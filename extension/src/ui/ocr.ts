// OCR review panel: shows each photo's text so the user can check and correct
// it before anything is sent, plus a LOCAL preview of the photo with boxes
// over the words a finding points at.
//
// This module does not run OCR. It displays OcrResult objects produced by the
// OCR owner's code (docs/TEAM.md interface B) or by a labeled dev fixture.
// The photo is only displayed from a local blob:/data: URL; it is never sent.
import type { Finding, Level, OcrResult, OcrWord, TextSource } from "../../../shared/contract";
import { button, el } from "./dom";

/** One photo handed to the panel. `imageUrl` must be local (blob: or data:image/). */
export interface OcrInput {
  result: OcrResult;
  imageUrl?: string;
  /** true when this came from a development fixture rather than real OCR. */
  isFixture?: boolean;
}

export interface OcrCallbacks {
  /** Called whenever the user changes which photo text would be sent. */
  onOcrTextChange(sourceId: string, text: string, included: boolean): void;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in extension/test/ui.test.ts)
// ---------------------------------------------------------------------------

/** Only local image URLs may be previewed, so the photo can't be fetched from or sent anywhere. */
export function isLocalImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("blob:") || url.startsWith("data:image/");
}

/** Below this OCR confidence we ask the user to check the text carefully. */
export const LOW_OCR_CONFIDENCE = 70;

export function ocrConfidenceHint(confidence: number): { text: string; low: boolean } {
  const pct = Math.round(Math.max(0, Math.min(100, confidence)));
  if (pct < LOW_OCR_CONFIDENCE) {
    return { text: `OCR confidence ${pct}%. The text may be misread; please check it against the photo.`, low: true };
  }
  return { text: `OCR confidence ${pct}%. Still worth a quick look.`, low: false };
}

/** Lower-case and strip punctuation at the edges: "608-555-0142," -> "608-555-0142". */
function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Find which OCR words make up `quote`, as a run of consecutive words.
 * Returns the word indexes, or null if the quote isn't a run of whole words.
 */
export function matchQuoteToWords(words: OcrWord[], quote: string): number[] | null {
  const target = quote.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (target.length === 0) return null;
  const tokens = words.map((w) => normalizeToken(w.text));
  for (let start = 0; start + target.length <= tokens.length; start++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (tokens[start + j] !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return target.map((_, j) => start + j);
  }
  return null;
}

export interface ImageHighlight {
  findingId: string;
  evidenceIndex: number;
  severity: Level;
  bbox: OcrWord["bbox"];
}

/**
 * Boxes to draw on the photo: one per VERIFIED evidence quote from this photo
 * whose words can be located. Unverified quotes are never drawn.
 */
export function ocrHighlightBoxes(result: OcrResult, findings: Finding[]): ImageHighlight[] {
  const words = result.words ?? [];
  if (words.length === 0) return [];
  const boxes: ImageHighlight[] = [];
  for (const finding of findings) {
    finding.evidence.forEach((ev, i) => {
      if (ev.sourceId !== result.sourceId || !ev.verified) return;
      const idx = matchQuoteToWords(words, ev.quote);
      if (!idx) return;
      // One box around all the matched words.
      const b = idx.map((k) => words[k].bbox);
      boxes.push({
        findingId: finding.id,
        evidenceIndex: i,
        severity: finding.severity,
        bbox: {
          x0: Math.min(...b.map((x) => x.x0)),
          y0: Math.min(...b.map((x) => x.y0)),
          x1: Math.max(...b.map((x) => x.x1)),
          y1: Math.max(...b.map((x) => x.y1)),
        },
      });
    });
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface ItemState {
  input: OcrInput;
  text: string;
  included: boolean;
  reviewed: boolean;
  textarea?: HTMLTextAreaElement;
  restore?: HTMLButtonElement;
  overlay?: HTMLElement;   // box layer on top of the preview image
  img?: HTMLImageElement;
}

export class OcrPanel {
  private items: ItemState[] = [];
  private highlights: Finding[] = [];
  private onBoxClick: (findingId: string) => void = () => {};

  constructor(private container: HTMLElement, private callbacks: OcrCallbacks) {}

  hasResults(): boolean {
    return this.items.length > 0;
  }

  /** Replace the panel's photos. Pass [] to clear it. */
  setResults(inputs: OcrInput[]) {
    this.items = inputs.map((input) => ({
      input,
      text: input.result.text,
      included: true,
      reviewed: false,
    }));
    this.highlights = [];
    this.draw();
  }

  /** The photo text that would be sent, as TextSources (only included photos). */
  sources(): TextSource[] {
    return this.items
      .filter((it) => it.included && it.text.trim())
      .map((it) => ({ id: it.input.result.sourceId, type: "image_text" as const, text: it.text }));
  }

  /** Source ids the user hasn't marked as checked yet. */
  unreviewedIds(): string[] {
    return this.items.filter((it) => it.included && !it.reviewed).map((it) => it.input.result.sourceId);
  }

  /** Draw boxes for these findings on the photo previews (or clear with []). */
  showHighlights(findings: Finding[], onBoxClick: (findingId: string) => void) {
    this.highlights = findings;
    this.onBoxClick = onBoxClick;
    for (const it of this.items) this.drawBoxes(it);
  }

  private draw() {
    this.container.replaceChildren();
    this.container.hidden = this.items.length === 0;
    if (this.items.length === 0) return;

    this.container.append(el("h2", "panel-title", "Text read from your photo"));
    this.container.append(
      el(
        "p",
        "hint",
        "Read on this computer. Check it against the photo and fix any mistakes: only this text is sent, never the photo.",
      ),
    );
    this.items.forEach((it, n) => this.container.append(this.drawItem(it, n + 1)));
  }

  private drawItem(it: ItemState, number: number) {
    const { result } = it.input;
    const box = el("div", "ocr-item");
    box.dataset.sourceId = result.sourceId;

    const head = el("div", "ocr-head");
    head.append(el("h3", undefined, `Photo ${number}`));
    if (it.input.isFixture) head.append(el("span", "fixture-tag", "Development fixture, not real OCR"));
    box.append(head);

    // Local photo preview with a layer for highlight boxes.
    if (isLocalImageUrl(it.input.imageUrl)) {
      const frame = el("div", "ocr-preview");
      const img = el("img");
      img.alt = `Preview of photo ${number}. It stays on this computer.`;
      img.src = it.input.imageUrl!;
      const overlay = el("div", "ocr-overlay");
      frame.append(img, overlay);
      it.img = img;
      it.overlay = overlay;
      img.addEventListener("load", () => this.drawBoxes(it));
      box.append(frame);
      if (!result.words || result.words.length === 0) {
        box.append(el("p", "hint", "Word positions aren't available, so warnings are highlighted in the text only."));
      }
    } else {
      box.append(el("p", "hint", "No photo preview available. Warnings are highlighted in the text only."));
    }

    const hint = ocrConfidenceHint(result.confidence);
    box.append(el("p", hint.low ? "ocr-confidence low" : "ocr-confidence", hint.text));

    const id = `ocr-text-${number}`;
    const label = el("label", undefined, "Text in this photo (you can correct it)");
    label.htmlFor = id;
    const textarea = el("textarea");
    textarea.id = id;
    textarea.rows = 3;
    textarea.value = it.text;
    it.textarea = textarea;
    box.append(label, textarea);

    const controls = el("div", "ocr-controls");

    const reviewedLabel = el("label", "check");
    const reviewed = el("input");
    reviewed.type = "checkbox";
    reviewed.checked = it.reviewed;
    reviewed.addEventListener("change", () => (it.reviewed = reviewed.checked));
    reviewedLabel.append(reviewed, " I checked this text against the photo");

    const includeLabel = el("label", "check");
    const include = el("input");
    include.type = "checkbox";
    include.checked = it.included;
    include.addEventListener("change", () => {
      it.included = include.checked;
      textarea.disabled = !it.included;
      box.classList.toggle("excluded", !it.included);
      this.callbacks.onOcrTextChange(result.sourceId, it.text, it.included);
    });
    includeLabel.append(include, " Include in the check");

    const restore = button("Restore OCR text", "secondary small", () => {
      it.text = result.text;
      textarea.value = it.text;
      restore.disabled = true;
      this.callbacks.onOcrTextChange(result.sourceId, it.text, it.included);
    });
    restore.disabled = true;
    it.restore = restore;

    textarea.addEventListener("input", () => {
      it.text = textarea.value;
      it.reviewed = true; // editing it counts as checking it
      reviewed.checked = true;
      restore.disabled = it.text === result.text;
      this.callbacks.onOcrTextChange(result.sourceId, it.text, it.included);
    });

    controls.append(reviewedLabel, includeLabel, restore);
    box.append(controls);
    return box;
  }

  private drawBoxes(it: ItemState) {
    const { overlay, img } = it;
    if (!overlay || !img) return;
    overlay.replaceChildren();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return; // image not loaded yet; the load event calls us again
    for (const hl of ocrHighlightBoxes(it.input.result, this.highlights)) {
      const mark = button("", `ocr-box sev-${hl.severity}`, () => this.onBoxClick(hl.findingId));
      mark.dataset.evidenceKeys = `${hl.findingId}:${hl.evidenceIndex}`;
      mark.setAttribute("aria-label", "Show the warning for this part of the photo");
      mark.style.left = `${(hl.bbox.x0 / w) * 100}%`;
      mark.style.top = `${(hl.bbox.y0 / h) * 100}%`;
      mark.style.width = `${((hl.bbox.x1 - hl.bbox.x0) / w) * 100}%`;
      mark.style.height = `${((hl.bbox.y1 - hl.bbox.y0) / h) * 100}%`;
      overlay.append(mark);
    }
  }
}
