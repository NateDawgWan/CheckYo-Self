// Popup logic: type a caption (and optional photo text), review exactly what
// will be sent, send it to the backend, show the findings, and mark them out
// of date as soon as the draft changes.
//
// All drawing is done by the warning interface (src/ui/warning-ui.ts). This
// file only collects the draft, calls the backend through api.ts, and handles
// the interface's callbacks.
import type { AnalysisMode, AnalyzeResponse, ErrorCode, HistoryPost, SuggestedEdit, TextSource } from "../../shared/contract";
import { CONTRACT_VERSION } from "../../shared/contract";
import { analyzeDraft, checkHealth, describeBackendStatus, hashSources } from "./api";
import { applyEditToText } from "./edits";
import { FIXTURE_HISTORY_CANDIDATES, makeFixtureOcr } from "./ui/fixtures";
import type { HistoryViewState } from "./ui/history";
import { createWarningUi } from "./ui/warning-ui";

const SAMPLE_CAPTION =
  "Back at Lincoln Park Elementary pickup again 🙃 same 3:15 chaos every weekday. " +
  "Then home to Maple St before Sam's soccer at 6pm Tuesdays! Leaving for Cancun Friday for a whole week ✈️";
const SAMPLE_IMAGE_TEXT = "Riverside Youth Soccer, U10 Tigers. Coach Dana 608-555-0142";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in popup.html`);
  return node as T;
}

const captionInput = byId<HTMLTextAreaElement>("caption");
const imageTextInput = byId<HTMLTextAreaElement>("image-text");
const manualImageText = byId<HTMLDivElement>("manual-image-text");
const analyzeButton = byId<HTMLButtonElement>("analyze");
const reanalyzeButton = byId<HTMLButtonElement>("reanalyze");
const sampleButton = byId<HTMLButtonElement>("load-sample");
const statusPill = byId<HTMLSpanElement>("backend-status");
const historyPanel = byId<HTMLElement>("history-panel");

/** The last result we showed. Its draftHash says which text it was about. */
let lastResult: AnalyzeResponse | null = null;
let hashTurn = 0;
/** Mode from the last health check, used for the consent wording. */
let backendMode: AnalysisMode | null = null;
/** History panel state. "not_connected" until a real history service exists. */
let historyState: HistoryViewState = { connection: "not_connected", candidates: [], imported: [] };

const ui = createWarningUi(
  {
    results: {
      root: byId("results"),
      summary: byId("summary"),
      markedDraft: byId("marked-draft"),
      findings: byId("findings"),
      meta: byId("meta"),
      mockBanner: byId("mock-banner"),
      incompleteBanner: byId("incomplete-banner"),
    },
    staleBanner: byId("stale-banner"),
    consent: byId("consent"),
    statePanel: byId("analysis-state"),
    message: byId("message"),
    ocrPanel: byId("ocr-panel"),
    historyPanel,
  },
  {
    onAnalyze: runAnalysis,
    onContinueWithoutAnalysis() {
      lastResult = null;
      ui.show({ kind: "skipped" });
    },
    onReturnToEditing() {
      ui.setMessage("Back to editing. Nothing was sent.");
      captionInput.focus();
    },
    onApplyEdit: applyEdit,
    onOcrTextChange: draftChanged,
    onApproveHistoryImport: approveHistoryImport,
    onDeleteHistory: deleteHistory,
  },
);

/** The draft as TextSources. Only text — never the image itself. */
function collectSources(): TextSource[] {
  const sources: TextSource[] = [{ id: "caption", type: "caption", text: captionInput.value }];
  if (ui.hasOcrResults()) {
    sources.push(...ui.ocrSources());
  } else if (imageTextInput.value.trim()) {
    sources.push({ id: "image_text:1", type: "image_text", text: imageTextInput.value });
  }
  sources.push(...ui.historySources());
  return sources;
}

/** Step 6: if the draft no longer matches the analyzed text, mark results stale. */
async function updateStaleness() {
  if (!lastResult) return;
  const myTurn = ++hashTurn;
  const currentHash = await hashSources(collectSources());
  if (myTurn !== hashTurn) return; // a newer keystroke already started a check
  ui.setStale(currentHash !== lastResult.draftHash);
}

function draftChanged() {
  ui.draftChanged();
  updateStaleness();
}

/** "Check this post": show the consent step first. Nothing is sent yet. */
function openConsent() {
  const sources = collectSources();
  if (!sources.some((s) => s.text.trim())) {
    ui.setMessage("Write a caption first.", "error");
    return;
  }
  ui.showConsent(sources, backendMode);
}

/** The user pressed Analyze on the consent step. `sources` is exactly what they saw. */
async function runAnalysis(sources: TextSource[]) {
  analyzeButton.disabled = true;
  reanalyzeButton.disabled = true;
  ui.show({ kind: "loading", sourceCount: sources.length });
  try {
    const draftHash = await hashSources(sources);
    const result = await analyzeDraft(sources, draftHash);
    lastResult = result;
    ui.show({ kind: "completed", result }, sources);
    await updateStaleness(); // the user may have typed while we waited
  } catch (err) {
    lastResult = null;
    const health = await checkHealth();
    const status = describeBackendStatus(health);
    if (status.state === "offline" || status.state === "mismatch") {
      ui.show({ kind: "unavailable", reason: `${status.label}. ${status.title}` });
    } else {
      // api.ts currently throws a plain Error; if it ever attaches the backend's
      // ErrorCode as `code`, the interface shows a more specific explanation.
      const code = (err as { code?: ErrorCode }).code;
      ui.show({ kind: "error", message: (err as Error).message, code });
    }
  } finally {
    analyzeButton.disabled = false;
    reanalyzeButton.disabled = false;
    // A Databricks call just succeeded or failed, so the status may have changed.
    showBackendStatus();
  }
}

/**
 * "Apply" on a suggested edit. Checked again here (not just when the button
 * was drawn):
 *  1. the draft must still be exactly the text the suggestion was made for,
 *     so a stale suggestion is never applied as if it were current;
 *  2. edits.ts must accept it, so an incomplete edit never deletes text.
 */
async function applyEdit(edit: SuggestedEdit, analyzedDraftHash: string) {
  const currentHash = await hashSources(collectSources());
  if (!lastResult || analyzedDraftHash !== lastResult.draftHash || currentHash !== analyzedDraftHash) {
    ui.setStale(true);
    ui.setMessage("These results are out of date, so nothing was changed. Check again first.", "error");
    return;
  }
  const result = applyEditToText(captionInput.value, edit);
  if (!result.ok) {
    ui.setMessage(result.reason, "error");
    return;
  }
  captionInput.value = result.text;
  captionInput.dispatchEvent(new Event("input"));
  ui.setMessage("Change applied. Check again to see updated results.");
}

/**
 * The pill in the corner. "Databricks connected" is shown ONLY after a real
 * call succeeded; filled-in settings alone show "Databricks not tested yet".
 */
async function showBackendStatus() {
  const health = await checkHealth();
  const { state, label, title } = describeBackendStatus(health);
  statusPill.dataset.state = state;
  statusPill.textContent = label;
  statusPill.title = title;
  backendMode = health && health.contractVersion === CONTRACT_VERSION ? health.mode : null;
  if (!health) ui.setMessage("Start the backend: open the backend folder and run `npm run dev`.", "error");
}

// ---------------------------------------------------------------------------
// History callbacks. There is no history service yet (milestone 3), so only
// the labeled development fixture can reach these. The real version should
// call the backend's /api/history routes and then ui.setHistoryState(...).
// ---------------------------------------------------------------------------

function setHistory(state: HistoryViewState) {
  historyState = state;
  ui.setHistoryState(state);
  draftChanged(); // approved history is part of what gets sent
}

function approveHistoryImport(_approvalId: string, posts: HistoryPost[]) {
  if (historyState.connection !== "fixture") return; // no real service to call yet
  const ids = new Set(posts.map((p) => p.postId));
  setHistory({
    ...historyState,
    candidates: historyState.candidates.filter((p) => !ids.has(p.postId)),
    imported: [...historyState.imported, ...posts],
    message: { text: `Fixture: "imported" ${posts.length} made-up post(s). Nothing was stored.`, kind: "info" },
  });
}

function deleteHistory() {
  if (historyState.connection !== "fixture") return; // no real service to call yet
  setHistory({
    ...historyState,
    candidates: [...historyState.candidates, ...historyState.imported],
    imported: [],
    message: { text: "Fixture: imported posts cleared. Nothing was stored to delete.", kind: "info" },
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

captionInput.addEventListener("input", draftChanged);
imageTextInput.addEventListener("input", draftChanged);
historyPanel.addEventListener("change", () => updateStaleness()); // "compare with these posts" toggle
analyzeButton.addEventListener("click", openConsent);
reanalyzeButton.addEventListener("click", openConsent);
sampleButton.addEventListener("click", () => {
  captionInput.value = SAMPLE_CAPTION;
  imageTextInput.value = SAMPLE_IMAGE_TEXT;
  captionInput.dispatchEvent(new Event("input"));
  captionInput.focus();
});

// Development fixtures (labeled in the popup as fake data).
byId<HTMLButtonElement>("fixture-ocr").addEventListener("click", () => {
  ui.setOcrResults([makeFixtureOcr()]);
  manualImageText.hidden = true;
  draftChanged();
});
byId<HTMLButtonElement>("fixture-history").addEventListener("click", () => {
  setHistory({ connection: "fixture", candidates: FIXTURE_HISTORY_CANDIDATES.map((p) => ({ ...p })), imported: [] });
});
byId<HTMLButtonElement>("fixture-clear").addEventListener("click", () => {
  ui.setOcrResults([]);
  manualImageText.hidden = false;
  setHistory({ connection: "not_connected", candidates: [], imported: [] });
});

ui.setHistoryState(historyState);
showBackendStatus();
