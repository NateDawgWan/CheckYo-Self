// The warning interface as one object with a small API, so the code that does
// networking (popup.ts today, the Instagram overlay later) only has to:
//   1. call createWarningUi(elements, callbacks) once,
//   2. call the show*/set* methods as things happen,
//   3. handle the callbacks (the user's choices).
//
// This module never talks to the network, runs OCR, or stores history.
// Those belong to the callback owners (see docs/TEAM.md).
import type { AnalysisMode, SuggestedEdit, TextSource } from "../../../shared/contract";
import { renderResults, setResultsStale, type ResultElements } from "../render";
import { renderConsent, type ConsentCallbacks } from "./consent";
import { el, flash } from "./dom";
import { HistoryPanel, type HistoryCallbacks, type HistoryViewState } from "./history";
import { OcrPanel, type OcrCallbacks, type OcrInput } from "./ocr";
import { describeError, statusLine, type AnalysisView } from "./state";

/**
 * Everything the user can ask for. Implemented by the integration owner.
 *  - onAnalyze(sources):           user consented; send EXACTLY these sources.
 *  - onContinueWithoutAnalysis():  user declined; nothing is sent.
 *  - onReturnToEditing():          user went back to the draft; nothing is sent.
 *  - onApplyEdit(edit, hash):      user clicked Apply on a suggestion made for draft `hash`.
 *                                  Re-check the current hash and edits.ts before changing text.
 *  - onOcrTextChange(...):         user corrected or excluded photo text (draft changed).
 *  - onApproveHistoryImport(...):  user approved importing exactly these earlier posts.
 *  - onDeleteHistory():            user confirmed deleting all imported history.
 */
export interface WarningUiCallbacks extends ConsentCallbacks, OcrCallbacks, HistoryCallbacks {
  onApplyEdit(edit: SuggestedEdit, analyzedDraftHash: string): void;
}

export interface WarningUiElements {
  results: ResultElements;
  staleBanner: HTMLElement;
  consent: HTMLElement;
  statePanel: HTMLElement;
  message: HTMLElement;
  ocrPanel: HTMLElement;
  historyPanel: HTMLElement;
}

export interface WarningUi {
  /** Open the consent step listing exactly `sources`. */
  showConsent(sources: TextSource[], mode: AnalysisMode | null): void;
  isConsentOpen(): boolean;
  closeConsent(): void;
  /** Show one analysis state. For "completed", pass the sources that were analyzed. */
  show(view: AnalysisView, analyzedSources?: TextSource[]): void;
  /** Mark the shown result as out of date (draft changed) or current again. */
  setStale(stale: boolean): void;
  /** Tell the UI the draft changed. Closes an open consent step (it listed old text). */
  draftChanged(): void;
  /** Photo text from OCR, for review and correction. Pass [] to clear. */
  setOcrResults(inputs: OcrInput[]): void;
  hasOcrResults(): boolean;
  /** Reviewed/corrected photo text to send (only photos the user kept included). */
  ocrSources(): TextSource[];
  /** History panel state (connection, candidates, imported posts). */
  setHistoryState(state: HistoryViewState): void;
  /** Approved earlier posts to include in the next check. */
  historySources(): TextSource[];
  setMessage(text: string, kind?: "info" | "error"): void;
}

export function createWarningUi(els: WarningUiElements, callbacks: WarningUiCallbacks): WarningUi {
  const ocr = new OcrPanel(els.ocrPanel, callbacks);
  const history = new HistoryPanel(els.historyPanel, callbacks);
  let consentOpen = false;
  let showingResult = false;

  function setMessage(text: string, kind: "info" | "error" = "info") {
    els.message.textContent = text;
    els.message.dataset.kind = kind;
  }

  function closeConsent() {
    consentOpen = false;
    els.consent.hidden = true;
    els.consent.replaceChildren();
  }

  function hideResults() {
    showingResult = false;
    els.results.root.hidden = true;
    els.staleBanner.hidden = true;
    ocr.showHighlights([], () => {});
  }

  function drawStatePanel(view: AnalysisView) {
    const panel = els.statePanel;
    panel.replaceChildren();
    panel.removeAttribute("aria-busy");
    panel.dataset.state = view.kind;
    panel.hidden = view.kind === "idle" || view.kind === "completed";

    switch (view.kind) {
      case "loading":
        panel.setAttribute("aria-busy", "true");
        panel.append(el("span", "spinner"));
        panel.append(el("p", "state-title", "Checking your post…"));
        panel.append(el("p", "state-detail", "Results will appear here. You can keep editing; they'll be marked out of date if you do."));
        break;
      case "skipped":
        panel.append(el("p", "state-title", "Not checked"));
        panel.append(
          el("p", "state-detail", "You continued without analysis. Nothing was sent. This is not the same as a clean result."),
        );
        break;
      case "unavailable":
        panel.append(el("p", "state-title", "Analysis unavailable"));
        panel.append(el("p", "state-detail", `${view.reason} Your post was not checked.`));
        break;
      case "error": {
        const { title, detail } = describeError(view.code, view.message);
        panel.append(el("p", "state-title", title));
        panel.append(el("p", "state-detail", detail));
        if (view.requestId) panel.append(el("p", "meta", `Request ${view.requestId.slice(0, 8)}.`));
        break;
      }
    }
  }

  return {
    showConsent(sources, mode) {
      consentOpen = true;
      const warnings: string[] = [];
      const unreviewed = ocr.unreviewedIds();
      if (unreviewed.length > 0) {
        warnings.push(
          `You haven't marked the photo text as checked (${unreviewed.length} photo${unreviewed.length === 1 ? "" : "s"}). ` +
            "OCR can misread text; return to editing to review it.",
        );
      }
      renderConsent(els.consent, sources, { mode, warnings }, {
        onAnalyze: (snapshot) => {
          closeConsent();
          callbacks.onAnalyze(snapshot);
        },
        onContinueWithoutAnalysis: () => {
          closeConsent();
          callbacks.onContinueWithoutAnalysis();
        },
        onReturnToEditing: () => {
          closeConsent();
          callbacks.onReturnToEditing();
        },
      });
      els.consent.hidden = false;
      flash(els.consent);
    },

    isConsentOpen: () => consentOpen,
    closeConsent,

    show(view, analyzedSources = []) {
      const line = statusLine(view);
      setMessage(line.text, line.kind);
      drawStatePanel(view);
      if (view.kind !== "completed") {
        // Never leave an old result on screen looking current.
        hideResults();
        return;
      }
      showingResult = true;
      renderResults(els.results, view.result, analyzedSources, callbacks.onApplyEdit, { stale: false });
      ocr.showHighlights(view.result.findings, (id) => flash(document.getElementById(`finding-${id}`)));
    },

    setStale(stale) {
      if (!showingResult) return;
      els.staleBanner.hidden = !stale;
      setResultsStale(els.results, stale);
    },

    draftChanged() {
      if (!consentOpen) return;
      closeConsent();
      setMessage("You changed the draft, so the list of text to send was closed. Press “Check this post” to review it again.");
    },

    setOcrResults(inputs) {
      ocr.setResults(inputs);
    },
    hasOcrResults: () => ocr.hasResults(),
    ocrSources: () => ocr.sources(),

    setHistoryState(state) {
      history.setState(state);
    },
    historySources: () => history.sources(),

    setMessage,
  };
}

/** Re-exported so integration code only needs to import this one module. */
export type { AnalysisView, HistoryViewState, OcrInput };
