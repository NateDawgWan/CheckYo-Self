// Regression tests for databricks.ts, using a fake fetch() so no real
// Databricks workspace or credentials are needed.
// Run with: npm test   (in the backend folder)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppError } from "../src/errors";
import { callDatabricks, getDatabricksStatus } from "../src/databricks";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MESSAGES = [{ role: "user" as const, content: "Reply with OK." }];

/**
 * A fake fetch that answers headers right away, then sends the body slowly.
 * Like a real fetch, the body stream fails when the request is aborted.
 */
function fakeFetchWithSlowBody(bodyDelayMs: number, body: string): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        }, bodyDelayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const OK_BODY = JSON.stringify({ choices: [{ message: { content: "OK" } }] });

// --- 4. The timeout must cover reading the response body ---------------------

test("times out when the body stalls after the headers arrive", { timeout: 5000 }, async () => {
  globalThis.fetch = fakeFetchWithSlowBody(60_000, OK_BODY); // body would take a minute
  await assert.rejects(
    callDatabricks(MESSAGES, 100),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_TIMEOUT",
  );
});

test("succeeds when the body arrives before the timeout", { timeout: 5000 }, async () => {
  globalThis.fetch = fakeFetchWithSlowBody(20, OK_BODY);
  assert.equal(await callDatabricks(MESSAGES, 1000), "OK");
});

test("a non-JSON body is reported as bad model output", async () => {
  globalThis.fetch = fakeFetchWithSlowBody(0, "<html>gateway error</html>");
  await assert.rejects(
    callDatabricks(MESSAGES, 1000),
    (err: unknown) => err instanceof AppError && err.code === "BAD_MODEL_OUTPUT",
  );
});

// --- 5. "Configured" vs. "verified" ------------------------------------------

test("status becomes verified only after a successful call, and failing after a failed one", async () => {
  globalThis.fetch = fakeFetchWithSlowBody(0, OK_BODY);
  await callDatabricks(MESSAGES, 1000);
  assert.equal(getDatabricksStatus().state, "verified");
  assert.equal(getDatabricksStatus().lastError, null);

  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await assert.rejects(callDatabricks(MESSAGES, 1000));
  const status = getDatabricksStatus();
  assert.equal(status.state, "failing");
  assert.match(status.lastError ?? "", /HTTP 401/);
});
