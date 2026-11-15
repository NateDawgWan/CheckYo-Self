// Reads settings from environment variables (loaded from backend/.env).
// Secrets live ONLY here on the backend — never in the extension or in git.
import "dotenv/config";
import type { AnalysisMode } from "../../shared/contract.js";

function readMode(): AnalysisMode {
  const raw = (process.env.ANALYSIS_MODE ?? "mock").trim().toLowerCase();
  if (raw === "mock" || raw === "databricks") return raw;
  throw new Error(`ANALYSIS_MODE must be "mock" or "databricks" (got "${raw}").`);
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  mode: readMode(),
  databricksHost: (process.env.DATABRICKS_HOST ?? "").trim().replace(/\/+$/, ""),
  databricksToken: (process.env.DATABRICKS_TOKEN ?? "").trim(),
  databricksEndpoint: (process.env.DATABRICKS_SERVING_ENDPOINT ?? "").trim(),
  allowedExtensionId: (process.env.ALLOWED_EXTENSION_ID ?? "").trim(),
};

/** Fail fast with a clear message instead of a confusing error later. */
export function assertDatabricksConfig(): void {
  const missing = [
    ["DATABRICKS_HOST", config.databricksHost],
    ["DATABRICKS_TOKEN", config.databricksToken],
    ["DATABRICKS_SERVING_ENDPOINT", config.databricksEndpoint],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `ANALYSIS_MODE=databricks but these are missing in backend/.env: ${missing.join(", ")}. ` +
        `Fill them in, or set ANALYSIS_MODE=mock.`,
    );
  }
  if (!config.databricksHost.startsWith("https://")) {
    throw new Error("DATABRICKS_HOST must start with https://");
  }
}
