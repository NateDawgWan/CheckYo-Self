// Talks to our backend. The extension NEVER talks to Databricks directly and
// NEVER holds Databricks credentials.
import {
  CONTRACT_VERSION,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type ErrorResponse,
  type HealthResponse,
  type TextSource,
} from "../../shared/contract";

// 127.0.0.1 rather than "localhost": on some computers "localhost" means IPv6
// and wouldn't reach a backend listening on 127.0.0.1.
// If you change this, also change "host_permissions" in public/manifest.json.
export const BACKEND_URL = "http://127.0.0.1:8787";

export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`);
    return res.ok ? ((await res.json()) as HealthResponse) : null;
  } catch {
    return null; // backend isn't running
  }
}

/** What the status pill should say. Pure function (no DOM), so it can be tested. */
export interface BackendStatusView {
  state: "offline" | "mismatch" | "mock" | "databricks-unverified" | "databricks-verified" | "databricks-failing";
  label: string;
  title: string; // tooltip with more detail
}

export function describeBackendStatus(health: HealthResponse | null): BackendStatusView {
  if (!health) {
    return { state: "offline", label: "Backend offline", title: "Run `npm run dev` in the backend folder." };
  }
  if (health.contractVersion !== CONTRACT_VERSION || !health.databricks) {
    return {
      state: "mismatch",
      label: "Version mismatch",
      title: `Backend speaks contract "${health.contractVersion}", extension expects "${CONTRACT_VERSION}". Rebuild the extension and restart the backend.`,
    };
  }
  if (health.mode === "mock") {
    return { state: "mock", label: "Practice mode", title: "Keyword rules, not AI. Databricks is not used." };
  }
  switch (health.databricks.state) {
    case "verified":
      return {
        state: "databricks-verified",
        label: "Databricks connected",
        title: `Last successful call: ${health.databricks.lastCallAt ?? "unknown"}.`,
      };
    case "failing":
      return {
        state: "databricks-failing",
        label: "Databricks error",
        title: health.databricks.lastError ?? "The last Databricks call failed.",
      };
    default:
      // Settings are filled in, but no call has succeeded yet. That is NOT a verified connection.
      return {
        state: "databricks-unverified",
        label: "Databricks not tested yet",
        title: "Databricks settings are filled in, but no call has succeeded since the backend started. Run a check, or `npm run check:databricks`.",
      };
  }
}

/** SHA-256 of the draft text. Same text -> same hash; any edit -> different hash. */
export async function hashSources(sources: TextSource[]): Promise<string> {
  const canonical = JSON.stringify(sources.map((s) => [s.id, s.text]));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function analyzeDraft(sources: TextSource[], draftHash: string): Promise<AnalyzeResponse> {
  const body: AnalyzeRequest = { contractVersion: CONTRACT_VERSION, draftHash, sources };

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the backend. Start it with `npm run dev` in the backend folder.");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as ErrorResponse | null)?.error?.message ?? `Backend returned HTTP ${res.status}.`;
    throw new Error(message);
  }
  return data as AnalyzeResponse;
}
