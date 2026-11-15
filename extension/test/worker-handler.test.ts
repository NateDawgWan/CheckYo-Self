// Tests for the service worker's message handling (src/worker-handler.ts)
// and the message checks it relies on (src/messages.ts). Uses a fake backend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type AnalyzeResponse, type TextSource } from "../../shared/contract";
import { nonTextProblem, parseExtensionMessage } from "../src/messages";
import type { HistoryClient, PublishedPostInfo } from "../src/ports";
import { handleWorkerMessage, type SenderInfo, type WorkerDeps } from "../src/worker-handler";

const HASH = "a".repeat(64);
const OUR_ID = "our-extension-id";
const INSTAGRAM_TAB: SenderInfo = { id: OUR_ID, url: "https://www.instagram.com/", tab: {} };
const POPUP: SenderInfo = { id: OUR_ID, url: `chrome-extension://${OUR_ID}/popup.html` };

function response(draftHash = HASH): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION, requestId: "r", draftHash, mode: "mock", model: null,
    promptVersion: null, analyzedAt: "2026-11-14T12:00:00Z", summary: "", findings: [], droppedFindings: 0,
    historyUsed: [],
  };
}

/** A fake backend and history that record what they were given. */
function fakes(answer: () => Promise<AnalyzeResponse> = async () => response()) {
  const analyzed: TextSource[][] = [];
  const recorded: PublishedPostInfo[] = [];
  const history: HistoryClient = { async recordPublished(info) { recorded.push(info); } };
  const deps: WorkerDeps = {
    extensionId: OUR_ID,
    analyze: async (sources) => { analyzed.push(sources); return answer(); },
    history,
  };
  return { deps, analyzed, recorded };
}

function checkDraft(sources: unknown, requestId = 7) {
  return { kind: "check-draft", requestId, draftHash: HASH, sources };
}

// --- text only ----------------------------------------------------------------

test("image data and image links are not treated as text", () => {
  assert.notEqual(nonTextProblem("data:image/png;base64,AAAA"), null);
  assert.notEqual(nonTextProblem("see blob:https://www.instagram.com/1234-abcd"), null);
  assert.notEqual(nonTextProblem("https://scontent.cdninstagram.com/v/t51/abc.jpg"), null);
  assert.notEqual(nonTextProblem("A".repeat(500)), null);
  assert.equal(nonTextProblem("Back home on Maple St! 🏡"), null);
});

test("extra fields on a source (like an image) are dropped", () => {
  const parsed = parseExtensionMessage(checkDraft([{ id: "caption", type: "caption", text: "hi", image: "x" }]));
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.value.kind === "check-draft") {
    assert.deepEqual(parsed.value.sources, [{ id: "caption", type: "caption", text: "hi" }]);
  }
});

test("malformed messages are rejected", () => {
  assert.equal(parseExtensionMessage(null).ok, false);
  assert.equal(parseExtensionMessage({ kind: "nope" }).ok, false);
  assert.equal(parseExtensionMessage({ ...checkDraft([]), draftHash: "short" }).ok, false);
  assert.equal(parseExtensionMessage(checkDraft([])).ok, false);
  assert.equal(parseExtensionMessage(checkDraft([{ id: "caption", type: "image_text", text: "x" }])).ok, false);
});

// --- check-draft ----------------------------------------------------------------

test("a check from the Instagram tab is sent to the backend and the request id is echoed", async () => {
  const { deps, analyzed } = fakes();
  const reply = await handleWorkerMessage(checkDraft([{ id: "caption", type: "caption", text: "hi" }]), INSTAGRAM_TAB, deps);
  assert.deepEqual(reply && reply.kind === "check-result" ? reply.requestId : null, 7);
  assert.equal(analyzed.length, 1);
});

test("a check containing image data never reaches the backend", async () => {
  const { deps, analyzed } = fakes();
  const reply = await handleWorkerMessage(
    checkDraft([{ id: "caption", type: "caption", text: "data:image/jpeg;base64,/9j/4AAQ" }]),
    INSTAGRAM_TAB,
    deps,
  );
  assert.equal(reply?.kind, "rejected");
  assert.equal(analyzed.length, 0);
});

test("checks are only accepted from our content script on instagram.com", async () => {
  const { deps, analyzed } = fakes();
  const msg = checkDraft([{ id: "caption", type: "caption", text: "hi" }]);
  assert.equal((await handleWorkerMessage(msg, POPUP, deps))?.kind, "rejected");
  assert.equal((await handleWorkerMessage(msg, { ...INSTAGRAM_TAB, url: "https://evil.example/" }, deps))?.kind, "rejected");
  assert.equal((await handleWorkerMessage(msg, { ...INSTAGRAM_TAB, id: "other-extension" }, deps))?.kind, "rejected");
  assert.equal(analyzed.length, 0);
});

test("a backend answer about different text is not passed on", async () => {
  const { deps } = fakes(async () => response("b".repeat(64)));
  const reply = await handleWorkerMessage(checkDraft([{ id: "caption", type: "caption", text: "hi" }]), INSTAGRAM_TAB, deps);
  assert.equal(reply?.kind, "check-error");
});

test("backend errors come back as check-error with the request id", async () => {
  const { deps } = fakes(async () => { throw new Error("Can't reach the backend."); });
  const reply = await handleWorkerMessage(checkDraft([{ id: "caption", type: "caption", text: "hi" }], 9), INSTAGRAM_TAB, deps);
  assert.deepEqual(reply, { kind: "check-error", requestId: 9, message: "Can't reach the backend." });
});

// --- post-published ---------------------------------------------------------------

test("a confirmed publication is passed to history; nothing else is", async () => {
  const { deps, recorded } = fakes();
  const msg = { kind: "post-published", draftHash: HASH, postId: null, publishedAt: "2026-11-14T12:00:00Z" };
  assert.deepEqual(await handleWorkerMessage(msg, INSTAGRAM_TAB, deps), { kind: "ok" });
  assert.equal(recorded.length, 1);
  assert.equal((await handleWorkerMessage(msg, POPUP, deps))?.kind, "rejected");
  assert.equal(recorded.length, 1);
});

test("the popup's request for the Instagram draft is not answered by the worker", async () => {
  const { deps } = fakes();
  assert.equal(await handleWorkerMessage({ kind: "get-instagram-draft" }, POPUP, deps), undefined);
});
