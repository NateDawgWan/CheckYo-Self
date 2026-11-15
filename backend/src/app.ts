// The Express app: all routes, with its parts passed in (so tests can build
// one with fakes). server.ts builds the real one from backend/.env and starts it.
//
//   GET    /api/health                                -> HealthResponse
//   POST   /api/analyze                               -> AnalyzeResponse
//   POST   /api/history/import                        -> HistoryImportResponse
//   GET    /api/history                               -> HistoryListResponse
//   POST   /api/history/suggest                       -> HistorySuggestResponse
//   DELETE /api/history/posts/:postId                 -> HistoryDeleteResponse
//   POST   /api/history/approvals/:approvalId/revoke  -> HistoryDeleteResponse
//   DELETE /api/history                               -> HistoryDeleteResponse
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  CONTRACT_VERSION,
  HISTORY_LIMITS,
  USER_ID_HEADER,
  type AnalysisMode,
  type AnalyzeResponse,
  type DatabricksStatus,
  type ErrorResponse,
  type HealthResponse,
  type HistoryDeleteResponse,
  type HistoryImportResponse,
  type HistoryListResponse,
  type HistorySuggestResponse,
  type TextSource,
} from "../../shared/contract";
import { AppError } from "./errors";
import { buildHistorySources, suggestHistory } from "./history/relevance";
import type { AiInterpretation, HistoryStore } from "./history/store";
import type { ParsedAnalysis } from "./parse";
import {
  validateAnalyzeRequest,
  validateApprovalId,
  validateHistoryImport,
  validateHistorySuggest,
  validatePostId,
  validateUserId,
} from "./validate";

export interface AppDeps {
  mode: AnalysisMode;
  /** Model/endpoint name shown to the user, or null in mock mode. */
  model: string | null;
  promptVersion: string | null;
  /**
   * Runs the analysis. In "databricks" mode this calls Databricks and parses
   * the answer; errors are passed on. It must NEVER fall back to mock results.
   */
  analyze: (sources: TextSource[]) => Promise<ParsedAnalysis>;
  historyStore: HistoryStore;
  getDatabricksStatus: () => DatabricksStatus;
  allowedExtensionId?: string;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));

  // Every request gets an id for logs and error messages.
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    next();
  });

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      mode: deps.mode,
      contractVersion: CONTRACT_VERSION,
      // "configured_unverified" until a real Databricks call succeeds.
      databricks: deps.getDatabricksStatus(),
      history: { store: deps.historyStore.kind },
    };
    res.json(body);
  });

  /** Optional: only accept calls from our own extension (set ALLOWED_EXTENSION_ID). */
  function checkOrigin(req: Request, _res: Response, next: NextFunction) {
    if (deps.allowedExtensionId && req.headers.origin !== `chrome-extension://${deps.allowedExtensionId}`) {
      return next(new AppError("FORBIDDEN", 403, "Requests are only accepted from the Second Look extension."));
    }
    next();
  }

  const userIdOf = (req: Request) => validateUserId(req.get(USER_ID_HEADER));

  // Wraps an async route so its errors reach the error handler below.
  const route =
    (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
      handler(req, res).catch(next);

  // --- Analysis ------------------------------------------------------------

  app.post(
    "/api/analyze",
    checkOrigin,
    route(async (req, res) => {
      const requestId: string = res.locals.requestId;
      const startedAt = Date.now();
      const request = validateAnalyzeRequest(req.body);

      // Earlier posts: EXACTLY the ones the user chose on the consent step,
      // and only from THIS user's approved history. Nothing is added or swapped.
      let sources: TextSource[] = request.sources;
      let historyUsed: AnalyzeResponse["historyUsed"] = [];
      let userId: string | null = null;
      if (request.historyPostIds) {
        userId = userIdOf(req);
        const stored = new Map((await deps.historyStore.listPosts(userId)).map((p) => [p.postId, p]));
        const missing = request.historyPostIds.filter((id) => !stored.has(id));
        if (missing.length > 0) {
          throw new AppError(
            "BAD_REQUEST",
            400,
            `${missing.length} chosen earlier post(s) are not in your approved history (deleted or revoked?). Review the list and check again.`,
          );
        }
        const chosen = buildHistorySources(request.sources, request.historyPostIds.map((id) => stored.get(id)!));
        sources = [...request.sources, ...chosen.sources];
        historyUsed = chosen.used;
      }

      const result = await deps.analyze(sources);

      const body: AnalyzeResponse = {
        contractVersion: CONTRACT_VERSION,
        requestId,
        draftHash: request.draftHash,
        mode: deps.mode,
        model: deps.model,
        promptVersion: deps.promptVersion,
        analyzedAt: new Date().toISOString(),
        summary: result.summary,
        findings: result.findings,
        droppedFindings: result.droppedFindings,
        historyUsed,
      };

      // Keep AI conclusions about earlier posts SEPARATE from the posts themselves.
      // Mock results are keyword rules, not AI, so they are never stored.
      if (userId && deps.mode === "databricks") {
        const interpretations = interpretationsFrom(body);
        try {
          await deps.historyStore.saveInterpretations(userId, interpretations);
        } catch (err) {
          // The analysis itself is fine; just report that saving failed.
          console.error(`[${requestId}] could not save ${interpretations.length} interpretation(s): ${(err as Error).message}`);
        }
      }

      // Privacy: log ids and counts only — never the post text or the user id.
      console.log(
        `[${requestId}] mode=${deps.mode} sources=${sources.length} history=${historyUsed.length} ` +
          `findings=${body.findings.length} dropped=${body.droppedFindings} ${Date.now() - startedAt}ms`,
      );
      res.json(body);
    }),
  );

  // --- History ---------------------------------------------------------------

  app.post(
    "/api/history/import",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      const request = validateHistoryImport(req.body);
      const existing = await deps.historyStore.listPosts(userId);
      const newIds = request.posts.filter((p) => !existing.some((e) => e.postId === p.postId)).length;
      if (existing.length + newIds > HISTORY_LIMITS.maxPostsPerUser) {
        throw new AppError("BAD_REQUEST", 400, `History is limited to ${HISTORY_LIMITS.maxPostsPerUser} posts per user.`);
      }
      const approvalId = randomUUID();
      const imported = await deps.historyStore.importPosts(userId, approvalId, new Date().toISOString(), request.posts);
      console.log(`[${res.locals.requestId}] history import posts=${imported} store=${deps.historyStore.kind}`);
      const body: HistoryImportResponse = { contractVersion: CONTRACT_VERSION, approvalId, imported, store: deps.historyStore.kind };
      res.json(body);
    }),
  );

  app.get(
    "/api/history",
    checkOrigin,
    route(async (req, res) => {
      const posts = await deps.historyStore.listPosts(userIdOf(req));
      const body: HistoryListResponse = { contractVersion: CONTRACT_VERSION, store: deps.historyStore.kind, posts };
      res.json(body);
    }),
  );

  // Suggests which approved posts to pre-select for a draft. Analyzes nothing
  // and calls no AI; the user still chooses on the consent step.
  app.post(
    "/api/history/suggest",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      const request = validateHistorySuggest(req.body);
      const ranked = suggestHistory(request.sources, await deps.historyStore.listPosts(userId));
      const body: HistorySuggestResponse = {
        contractVersion: CONTRACT_VERSION,
        suggestions: ranked.map((r) => ({ postId: r.post.postId, publishedAt: r.post.publishedAt, sharedWords: r.sharedWords })),
      };
      res.json(body);
    }),
  );

  app.delete(
    "/api/history/posts/:postId",
    checkOrigin,
    route(async (req, res) => {
      const counts = await deps.historyStore.deletePost(userIdOf(req), validatePostId(req.params.postId));
      if (counts.deletedPosts === 0) throw new AppError("NOT_FOUND", 404, "No such post in your history.");
      const body: HistoryDeleteResponse = { contractVersion: CONTRACT_VERSION, ...counts };
      res.json(body);
    }),
  );

  app.post(
    "/api/history/approvals/:approvalId/revoke",
    checkOrigin,
    route(async (req, res) => {
      const counts = await deps.historyStore.revokeApproval(userIdOf(req), validateApprovalId(req.params.approvalId));
      if (!counts) throw new AppError("NOT_FOUND", 404, "No such approval in your history.");
      const body: HistoryDeleteResponse = { contractVersion: CONTRACT_VERSION, ...counts };
      res.json(body);
    }),
  );

  app.delete(
    "/api/history",
    checkOrigin,
    route(async (req, res) => {
      const counts = await deps.historyStore.deleteAll(userIdOf(req));
      const body: HistoryDeleteResponse = { contractVersion: CONTRACT_VERSION, ...counts };
      res.json(body);
    }),
  );

  // --- Errors ----------------------------------------------------------------

  // Turns any error into an ErrorResponse the extension understands.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId: string | undefined = res.locals.requestId;
    let status = 500;
    let error: ErrorResponse["error"] = { code: "INTERNAL", message: "Unexpected server error.", requestId };

    if (err instanceof AppError) {
      status = err.httpStatus;
      error = { code: err.code, message: err.message, requestId };
    } else if ((err as any)?.type === "entity.parse.failed") {
      status = 400;
      error = { code: "BAD_REQUEST", message: "Body is not valid JSON.", requestId };
    } else if ((err as any)?.type === "entity.too.large") {
      status = 413;
      error = { code: "BAD_REQUEST", message: "Request body is too large.", requestId };
    } else {
      // Log the error type and message only (no request body).
      console.error(`[${requestId ?? "-"}] ${(err as Error)?.name}: ${(err as Error)?.message}`);
    }

    const body: ErrorResponse = { contractVersion: CONTRACT_VERSION, error };
    res.status(status).json(body);
  });

  return app;
}

/** AI findings that rely on verified quotes from earlier posts. */
export function interpretationsFrom(response: AnalyzeResponse): AiInterpretation[] {
  const result: AiInterpretation[] = [];
  for (const finding of response.findings) {
    const historyEvidence = finding.evidence.filter((e) => e.verified && e.sourceId.startsWith("history:"));
    if (historyEvidence.length === 0) continue;
    result.push({
      interpretationId: randomUUID(),
      postIds: [...new Set(historyEvidence.map((e) => e.sourceId.slice("history:".length)))],
      category: finding.category,
      severity: finding.severity,
      exposure: finding.exposure,
      evidence: finding.evidence.filter((e) => e.verified).map((e) => ({ sourceId: e.sourceId, quote: e.quote })),
      model: response.model,
      promptVersion: response.promptVersion,
      requestId: response.requestId,
      createdAt: response.analyzedAt,
    });
  }
  return result;
}
