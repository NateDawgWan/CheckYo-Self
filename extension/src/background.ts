// The extension's service worker (Manifest V3 "background").
//
// The Instagram content script can't call our backend itself (instagram.com's
// page rules would block it), so it sends a Chrome message here and this
// worker calls the backend with the same api.ts code the popup uses.
//
// It also relays the Instagram photo to the offscreen OCR page (offscreen.html)
// so its text can be read locally. That relay (ocr-relay.ts) never touches the
// backend: the photo's text is only analyzed later, when the user clicks the
// check button, and then only as text through "check-draft".
//
// The worker talks ONLY to our local backend (BACKEND_URL in api.ts). It never
// talks to Databricks and holds no credentials.
import { analyzeDraft, checkHealth, describeBackendStatus } from "./api";
import { handleOcrImageMessage, isOcrImageMessage, type OcrRunMessage, type OcrRunReply } from "./ocr-relay";
import { noHistory } from "./ports";
import { handleWorkerMessage } from "./worker-handler";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isOcrImageMessage(message)) {
    handleOcrImageMessage(message, sender, { extensionId: chrome.runtime.id, runOcr }).then(sendResponse);
    return true; // answer when the scan is done
  }

  // Other message kinds (like the popup's "get-instagram-draft", or "ocr-run"
  // meant for the offscreen page) are not for the worker. Returning false
  // tells Chrome we won't answer them.
  if (!isForWorker(message)) return false;

  const deps = {
    extensionId: chrome.runtime.id,
    analyze: analyzeDraft,
    history: noHistory,
    // The Instagram panel's status pill: same wording as the popup's.
    backendStatus: async () => describeBackendStatus(await checkHealth()),
  };
  handleWorkerMessage(message, sender, deps).then(sendResponse);
  // Returning true keeps the reply channel open while we wait for the backend.
  return true;
});

function isForWorker(message: unknown): boolean {
  const kind = (message as { kind?: unknown } | null)?.kind;
  return kind === "check-draft" || kind === "post-published" || kind === "get-backend-status";
}

// ---------------------------------------------------------------------------
// The offscreen OCR page
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | null = null; // so two photos at once don't create two pages

/** Creates the offscreen page if it isn't open yet. Chrome allows only one per extension. */
async function ensureOffscreenPage(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Reads the text in the photo being posted, on this computer, with the bundled OCR engine.",
    })
    .finally(() => (creating = null));
  await creating;
}

async function runOcr(message: OcrRunMessage): Promise<OcrRunReply> {
  await ensureOffscreenPage();
  return chrome.runtime.sendMessage(message);
}
