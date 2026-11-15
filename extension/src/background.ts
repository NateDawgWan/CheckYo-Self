// The extension's service worker (Manifest V3 "background").
//
// The Instagram content script can't call our backend itself (instagram.com's
// page rules would block it), so it sends a Chrome message here and this
// worker calls the backend with the same api.ts code the popup uses.
//
// The worker talks ONLY to our local backend (BACKEND_URL in api.ts). It never
// talks to Databricks and holds no credentials.
import { analyzeDraft } from "./api";
import { noHistory } from "./ports";
import { handleWorkerMessage } from "./worker-handler";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Other message kinds (like the popup's "get-instagram-draft") are not for
  // the worker. Returning false tells Chrome we won't answer them.
  if (!isForWorker(message)) return false;

  const deps = { extensionId: chrome.runtime.id, analyze: analyzeDraft, history: noHistory };
  handleWorkerMessage(message, sender, deps).then(sendResponse);
  // Returning true keeps the reply channel open while we wait for the backend.
  return true;
});

function isForWorker(message: unknown): boolean {
  const kind = (message as { kind?: unknown } | null)?.kind;
  return kind === "check-draft" || kind === "post-published";
}
