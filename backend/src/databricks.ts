// Calls a Databricks model serving endpoint (chat format) and returns the
// model's text answer. Uses Node's built-in fetch — no SDK needed.
import { config } from "./config";
import { AppError } from "./errors";
import type { ChatMessage } from "./prompt";

const TIMEOUT_MS = 45_000;

export async function callDatabricks(messages: ChatMessage[]): Promise<string> {
  const url =
    `${config.databricksHost}/serving-endpoints/` +
    `${encodeURIComponent(config.databricksEndpoint)}/invocations`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
    if ((err as Error).name === "AbortError") {
      throw new AppError("UPSTREAM_TIMEOUT", 504, `Databricks did not answer within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new AppError("UPSTREAM_ERROR", 502, `Could not reach Databricks: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Log details on the server only. The body may describe the error; it does not echo our token.
    const detail = (await response.text()).slice(0, 500);
    console.error(`Databricks HTTP ${response.status}: ${detail}`);
    const hint =
      response.status === 401 || response.status === 403
        ? " Check DATABRICKS_TOKEN."
        : response.status === 404
          ? " Check DATABRICKS_HOST and DATABRICKS_SERVING_ENDPOINT."
          : "";
    throw new AppError("UPSTREAM_ERROR", 502, `Databricks returned HTTP ${response.status}.${hint}`);
  }

  const data: unknown = await response.json();
  const text = extractText(data);
  if (!text) throw new AppError("BAD_MODEL_OUTPUT", 502, "Databricks response had no text content.");
  return text;
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
