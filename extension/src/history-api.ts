// The backend's /api/history routes, from the extension. Every call carries
// this install's random user id (user-id.ts), so nobody sees anyone else's
// history. Only TEXT is sent (captions and photo text the user approved).
// See shared/contract.ts for the request/response shapes.
import {
  CONTRACT_VERSION,
  USER_ID_HEADER,
  type ErrorResponse,
  type HistoryDeleteResponse,
  type HistoryImportRequest,
  type HistoryImportResponse,
  type HistoryListResponse,
  type HistoryPost,
  type HistorySuggestResponse,
  type TextSource,
} from "../../shared/contract";
import { BACKEND_URL } from "./api";
import { getUserId } from "./user-id";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [USER_ID_HEADER]: await getUserId() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the backend. Start it (scripts\\windows\\start-backend.cmd or `npm run dev` in backend/).");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as ErrorResponse | null)?.error?.message ?? `Backend returned HTTP ${res.status}.`);
  }
  return data as T;
}

/**
 * Saves posts the user explicitly approved. `posts` must be exactly the
 * approved ones: the backend refuses anything else.
 */
export function importHistory(posts: HistoryPost[]): Promise<HistoryImportResponse> {
  const body: HistoryImportRequest = {
    contractVersion: CONTRACT_VERSION,
    approval: { approved: true, postIds: posts.map((p) => p.postId) },
    posts,
  };
  return call("POST", "/api/history/import", body);
}

export function listHistory(): Promise<HistoryListResponse> {
  return call("GET", "/api/history");
}

/** Which saved posts look related to a draft (no AI call). */
export function suggestHistory(sources: TextSource[]): Promise<HistorySuggestResponse> {
  return call("POST", "/api/history/suggest", { contractVersion: CONTRACT_VERSION, sources });
}

export function deleteHistoryPost(postId: string): Promise<HistoryDeleteResponse> {
  return call("DELETE", `/api/history/posts/${encodeURIComponent(postId)}`);
}

export function revokeApproval(approvalId: string): Promise<HistoryDeleteResponse> {
  return call("POST", `/api/history/approvals/${encodeURIComponent(approvalId)}/revoke`);
}

/** Deletes ALL of this user's saved posts and the AI interpretations made from them. */
export function deleteAllHistory(): Promise<HistoryDeleteResponse> {
  return call("DELETE", "/api/history");
}
