// Calls a Databricks model serving endpoint (chat format) and returns the
// model's text answer. Uses Node's built-in fetch — no SDK needed.
//
// It also remembers whether the most recent call worked, so /api/health can
// tell "settings are filled in" apart from "a real call actually succeeded".
import type { DatabricksStatus } from "../../shared/contract";
import { config } from "./config";
import { AppError } from "./errors";
import type { ChatMessage } from "./prompt";

export const TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Connection status (in memory; resets when the backend restarts)
// ---------------------------------------------------------------------------

let status: DatabricksStatus = {
  state: config.mode === "databricks" ? "configured_unverified" : "not_used",
  lastCallAt: null,
  lastError: null,
};

export function getDatabricksStatus(): DatabricksStatus {
  return { ...status };
}

function recordSuccess() {
  status = { state: "verified", lastCallAt: new Date().toISOString(), lastError: null };
}

function recordFailure(message: string) {
  status = { state: "failing", lastCallAt: new Date().toISOString(), lastError: message.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Sends the messages and returns the model's text.
 * The timeout covers the WHOLE call: connecting, waiting for headers, AND
 * reading the response body. (A server can send headers quickly and then
 * stall while sending the body; that must time out too.)
 *
 * `timeoutMs` can be lowered by tests; normal code uses the default.
 */
export async function callDatabricks(messages: ChatMessage[], timeoutMs: number = TIMEOUT_MS): Promise<string> {
  try {
    const text = await callWithTimeout(messages, timeoutMs);
    recordSuccess();
    return text;
  } catch (err) {
    recordFailure(err instanceof AppError ? err.message : "Unexpected error calling Databricks.");
    throw err;
  }
}

async function callWithTimeout(messages: ChatMessage[], timeoutMs: number): Promise<string> {
  const url =
    `${config.databricksHost}/serving-endpoints/` +
    `${encodeURIComponent(config.databricksEndpoint)}/invocations`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutError = () =>
    new AppError("UPSTREAM_TIMEOUT", 504, `Databricks did not answer within ${timeoutMs / 1000}s.`);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.databricksToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages, max_tokens: 2000, temperature: 0.1 }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError();
      throw new AppError("UPSTREAM_ERROR", 502, `Could not reach Databricks: ${(err as Error).message}`);
    }

    // Read the body while the timer is STILL running.
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError();
      throw new AppError("UPSTREAM_ERROR", 502, `Databricks response was cut off: ${(err as Error).message}`);
    }

    if (!response.ok) {
      // Log details on the server only. The body may describe the error; it does not echo our token.
      console.error(`Databricks HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
      const hint =
        response.status === 401 || response.status === 403
          ? " Check DATABRICKS_TOKEN."
          : response.status === 404
            ? " Check DATABRICKS_HOST and DATABRICKS_SERVING_ENDPOINT."
            : "";
      throw new AppError("UPSTREAM_ERROR", 502, `Databricks returned HTTP ${response.status}.${hint}`);
    }

    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new AppError("BAD_MODEL_OUTPUT", 502, "Databricks response was not valid JSON.");
    }
    const text = extractText(data);
    if (!text) throw new AppError("BAD_MODEL_OUTPUT", 502, "Databricks response had no text content.");
    return text;
  } finally {
    // Only now, after the body is fully read (or we gave up), stop the timer.
    clearTimeout(timer);
  }
}

/**
 * Chat responses look like { choices: [ { message: { content } } ] }.
 * `content` is usually a string, but some models return a list of blocks.
 */
function extractText(data: unknown): string {
  const content = (data as any)?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}
