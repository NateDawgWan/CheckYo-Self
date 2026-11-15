// The warning panel shown on instagram.com. Default WarningPanel (see
// ports.ts); Person D can replace it with their own as long as it keeps the
// same methods.
//
// It reuses renderResults() from render.ts, so warnings look and behave the
// same as in the popup (textContent only, practice-mode banner, incomplete
// banner, stale banner).
//
// It lives in a Shadow DOM so Instagram's styles can't change it and ours
// can't change Instagram's page. It sits OUTSIDE Instagram's own dialog.
import type { AnalyzeResponse, TextSource } from "../../../shared/contract";
import type { MessageKind, WarningPanel, WarningPanelActions } from "../ports";
import { renderResults, type ResultElements } from "../render";
// The popup's stylesheet, bundled as text by esbuild (see build.mjs).
import popupCss from "../../public/popup.css";

/** Panel-only styles. The popup's colors and finding styles come from popup.css. */
const PANEL_CSS = `
:host { all: initial; }
.launcher, .panel { font: 14px/1.45 var(--ui-font); color: var(--ink); }
.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  box-shadow: 0 4px 16px rgba(0,0,0,.25);
}
.panel {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  width: 400px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
  overflow: auto; background: var(--paper); border: 1px solid var(--line);
  border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.35); padding: 14px 16px 16px;
}
.panel[hidden], .launcher[hidden] { display: none; }
.panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.panel-head h1 { font-size: 16px; }
.close { padding: 2px 8px; }
.intro { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.share-ready { margin: 10px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--low-mark); color: var(--low); font-weight: 600; }
.actions { flex-wrap: wrap; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className: string, onClick: () => void) {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function createOverlayPanel(actions: WarningPanelActions): WarningPanel {
  const host = document.createElement("second-look-panel");
  const shadow = host.attachShadow({ mode: "closed" });

  // Don't let clicks and key presses inside our panel reach Instagram's page,
  // which might treat them as "clicked outside the dialog" (closing the
  // composer) or as keyboard shortcuts.
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "keyup", "keypress", "input", "focusin"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const style = el("style");
  // popup.css styles :root and body; inside a shadow root the equivalent is :host.
  style.textContent = popupCss.replaceAll(":root", ":host") + PANEL_CSS;

  const launcher = button("Second Look: Check this post", "primary launcher", () => actions.onCheck());
  launcher.hidden = true;

  const panel = el("section", "panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Second Look");

  const head = el("div", "panel-head");
  const title = el("h1", undefined, "Second Look");
  head.append(title, button("Close", "secondary small close", () => actions.onBack()));
  const intro = el("p", "intro");
  const unsupportedNote = el("p", "banner banner-incomplete");
  unsupportedNote.hidden = true;

  const imageLabel = el("label", undefined, "Text in the photo");
  imageLabel.htmlFor = "sl-image-text";
  const imageHint = el("p", "hint");
  const imageText = el("textarea");
  imageText.id = "sl-image-text";
  imageText.rows = 2;
  imageText.placeholder = "e.g. a sign, name tag or jersey in the photo";
  imageText.addEventListener("input", () => actions.onImageTextInput(imageText.value));

  const checkButton = button("Check this post", "primary", () => actions.onCheck());
  const backButton = button("Back to editing", "secondary", () => actions.onBack());
  const continueButton = button("Share without checking", "secondary", () => actions.onContinue());
  const buttonRow = el("div", "actions");
  buttonRow.append(backButton, continueButton, checkButton);

  const shareReady = el("p", "share-ready", "Ready. Click Instagram's Share button to post.");
  shareReady.hidden = true;
  const message = el("p", "message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");

  // The same structure popup.html gives renderResults().
  const results = el("section", "results");
  results.hidden = true;
  const mockBanner = el("p", "banner banner-mock", "Practice results. These come from simple keyword rules, not AI.");
  const incompleteBanner = el("p", "banner banner-incomplete");
  incompleteBanner.setAttribute("role", "alert");
  const staleBanner = el("div", "banner banner-stale");
  staleBanner.append(el("span", undefined, "You changed the post after this check, so these results may be wrong."));
  staleBanner.append(button("Check again", "primary small", () => actions.onCheck()));
  staleBanner.hidden = true;
  const summary = el("p", "summary");
  const markedDraft = el("div", "marked-draft");
  const findings = el("ol", "findings");
  const meta = el("p", "meta");
  results.append(el("h2", undefined, "What this post could reveal"), mockBanner, incompleteBanner, staleBanner, summary, markedDraft, findings, meta);

  const resultEls: ResultElements = { root: results, summary, markedDraft, findings, meta, mockBanner, incompleteBanner };

  panel.append(head, intro, unsupportedNote, imageLabel, imageHint, imageText, buttonRow, shareReady, message, results);
  shadow.append(style, launcher, panel);
  document.documentElement.append(host);

  let hasResult = false;
  let stale = false;

  function updateContinueLabel() {
    continueButton.textContent = hasResult && !stale ? "Continue to Share" : "Share without checking";
  }

  return {
    showLauncher(visible) {
      launcher.hidden = !visible;
    },
    open(reason) {
      title.textContent = reason === "share-clicked" ? "Before you share" : "Check this post";
      intro.textContent =
        reason === "share-clicked"
          ? "Second Look paused sharing so you can check what this post could reveal. Nothing has been posted."
          : "Check what this post could reveal. Only text is sent to your local Second Look backend; the photo stays on your computer.";
      panel.hidden = false;
      launcher.hidden = true;
    },
    close() {
      panel.hidden = true;
    },
    isOpen() {
      return !panel.hidden;
    },
    setImageText(text, hint) {
      imageText.value = text;
      imageHint.textContent = hint;
    },
    setBusy(busy) {
      checkButton.disabled = busy;
      continueButton.disabled = busy;
    },
    setMessage(text: string, kind: MessageKind = "info") {
      message.textContent = text;
      message.dataset.kind = kind;
    },
    showResult(result: AnalyzeResponse, sources: TextSource[]) {
      // Apply buttons call back into main.ts, which re-checks the edit
      // against the caption that is on the page at that moment.
      renderResults(resultEls, result, sources, (edit) => actions.onApplyEdit(edit));
      hasResult = true;
      updateContinueLabel();
    },
    clearResult() {
      results.hidden = true;
      hasResult = false;
      updateContinueLabel();
    },
    setStale(value) {
      stale = value;
      staleBanner.hidden = !value;
      results.classList.toggle("is-stale", value);
      updateContinueLabel();
    },
    setShareReady(ready) {
      shareReady.hidden = !ready;
    },
    setUnsupported(note) {
      unsupportedNote.hidden = note === null;
      unsupportedNote.textContent = note ?? "";
    },
    destroy() {
      host.remove();
    },
  };
}
