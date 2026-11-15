// The backend: one Express server with two routes.
//   GET  /api/health   -> is the server up, and which mode is it in?
//   POST /api/analyze  -> AnalyzeRequest in, AnalyzeResponse out
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  CONTRACT_VERSION,
  type AnalyzeResponse,
  type ErrorResponse,
  type HealthResponse,
} from "../../shared/contract";
import { assertDatabricksConfig, config } from "./config";
import { callDatabricks } from "./databricks";
import { AppError } from "./errors";
import { mockAnalyze } from "./mock";
import { parseModelOutput } from "./parse";
import { buildMessages, PROMPT_VERSION } from "./prompt";
import { validateAnalyzeRequest } from "./validate";

if (config.mode === "databricks") assertDatabricksConfig();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => {
  const body: HealthResponse = { ok: true, mode: config.mode, contractVersion: CONTRACT_VERSION };
  res.json(body);
});

/** Optional: only accept calls from our own extension (set ALLOWED_EXTENSION_ID). */
function checkOrigin(req: Request, _res: Response, next: NextFunction) {
  if (config.allowedExtensionId && req.headers.origin !== `chrome-extension://${config.allowedExtensionId}`) {
    return next(new AppError("FORBIDDEN", 403, "Requests are only accepted from the Second Look extension."));
  }
  next();
}

app.post("/api/analyze", checkOrigin, async (req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  const startedAt = Date.now();
  try {
    const request = validateAnalyzeRequest(req.body);

    const result =
      config.mode === "mock"
        ? mockAnalyze(request.sources)
        : parseModelOutput(await callDatabricks(buildMessages(request.sources)), request.sources);

    const body: AnalyzeResponse = {
      contractVersion: CONTRACT_VERSION,
      requestId,
      draftHash: request.draftHash,
      mode: config.mode,
      model: config.mode === "databricks" ? config.databricksEndpoint : null,
      promptVersion: config.mode === "databricks" ? PROMPT_VERSION : null,
      analyzedAt: new Date().toISOString(),
      summary: result.summary,
      findings: result.findings,
    };

    // Privacy: log ids and counts only — never the post text.
    console.log(
      `[${requestId}] mode=${config.mode} sources=${request.sources.length} ` +
        `findings=${body.findings.length} ${Date.now() - startedAt}ms`,
    );
    res.json(body);
  } catch (err) {
    next(err);
  }
});

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
    console.error(`[${requestId ?? "-"}]`, err);
  }

  const body: ErrorResponse = { contractVersion: CONTRACT_VERSION, error };
  res.status(status).json(body);
});

// Listen on localhost only, so other machines on the hackathon Wi-Fi can't use it.
app.listen(config.port, "127.0.0.1", () => {
  console.log(`Second Look backend on http://127.0.0.1:${config.port}  (mode: ${config.mode})`);
  if (config.mode === "mock") {
    console.log("MOCK MODE: results are keyword rules, not AI. Set ANALYSIS_MODE=databricks in backend/.env for real analysis.");
  }
});
