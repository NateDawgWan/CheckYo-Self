// Draws results on the page. SAFETY: text from the backend/LLM is only ever set
// with textContent (never innerHTML), so a malicious caption can't inject HTML.
//
// Two kinds of information are kept visibly apart on every finding card:
//  - OBSERVED: evidence quotes from the user's own text. "Found in your text"
//    means the backend checked the quote really appears there.
//  - AI INTERPRETATION: what the quote might reveal, how sure the AI is, and
//    the suggested changes. These can be wrong.
import type { AnalyzeResponse, Finding, Level, SuggestedEdit, TextSource } from "../../shared/contract";
import { canApplyEdit } from "./edits";
import { el, flash, shortDate } from "./ui/dom";
import { resultOutcome } from "./ui/state";

export function sourceLabel(source: TextSource | undefined, sourceId: string): string {
  if (sourceId === "caption") return "Caption";
  if (sourceId.startsWith("image_text")) {
    const n = sourceId.split(":")[1];
    return n ? `Photo text ${n}` : "Photo text";
  }
  if (sourceId.startsWith("history")) return `Earlier post, posted ${shortDate(source?.date)}`;
  return sourceId;
}

const CATEGORY_LABELS: Record<string, string> = {
  location: "Location",
  routine_schedule: "Routine",
  travel_absence: "Time away",
  children: "Children",
  identity: "Identity",
  contact: "Contact details",
  workplace_school: "Work or school",
  financial: "Money",
  health: "Health",
  relationships: "Relationships",
  other: "Other",
};

const SEVERITY_RANK: Record<Level, number> = { high: 3, medium: 2, low: 1 };

/** Find every element tied to one evidence quote (caption marks and photo boxes). */
function evidenceNodes(key: string): Element | null {
  return document.querySelector(`[data-evidence-keys~="${CSS.escape(key)}"]`);
}

// ---------------------------------------------------------------------------
// Marked-up draft: the user's text with highlighted evidence
// ---------------------------------------------------------------------------

interface Range {
  start: number;
  end: number;
  keys: string[];   // "f1:0" = finding f1, evidence #0
  severity: Level;
}

function findRanges(source: TextSource, findings: Finding[]): Range[] {
  const lower = source.text.toLowerCase();
  const ranges: Range[] = [];
  for (const finding of findings) {
    finding.evidence.forEach((ev, i) => {
      if (ev.sourceId !== source.id || !ev.verified) return;
      const start = lower.indexOf(ev.quote.toLowerCase());
      if (start === -1) return; // matched only after whitespace cleanup; skip the highlight
      ranges.push({ start, end: start + ev.quote.length, keys: [`${finding.id}:${i}`], severity: finding.severity });
    });
  }
  // Merge overlapping highlights so we never nest <mark> tags.
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
      last.keys.push(...r.keys);
      if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[last.severity]) last.severity = r.severity;
    } else {
      merged.push({ ...r, keys: [...r.keys] });
    }
  }
  return merged;
}

function renderMarkedText(source: TextSource, findings: Finding[], onMarkClick: (findingId: string) => void) {
  const p = el("p");
  let cursor = 0;
  for (const range of findRanges(source, findings)) {
    p.append(source.text.slice(cursor, range.start));
    const mark = el("mark", `sev-${range.severity}`, source.text.slice(range.start, range.end));
    mark.dataset.evidenceKeys = range.keys.join(" ");
    mark.tabIndex = 0;
    const firstFinding = range.keys[0].split(":")[0];
    mark.title = "Show the warning for this text";
    mark.addEventListener("click", () => onMarkClick(firstFinding));
    mark.addEventListener("keydown", (e) => e.key === "Enter" && onMarkClick(firstFinding));
    p.append(mark);
    cursor = range.end;
  }
  p.append(source.text.slice(cursor));
  return p;
}

// ---------------------------------------------------------------------------
// Finding cards
// ---------------------------------------------------------------------------

/** Show "Apply" only for complete edits that match the analyzed caption (see edits.ts). */
function canApply(edit: SuggestedEdit, sourcesById: Map<string, TextSource>): boolean {
  const source = sourcesById.get(edit.sourceId);
  return !!source && canApplyEdit(edit, source.text);
}

/** Plain-language description of a suggested edit. Exported for tests. */
export function describeEdit(edit: SuggestedEdit): string {
  if (edit.action === "remove" && edit.original) return `Remove "${edit.original}". ${edit.explanation}`;
  if ((edit.action === "replace" || edit.action === "generalize") && edit.original && edit.replacement) {
    return `Change "${edit.original}" to "${edit.replacement}". ${edit.explanation}`;
  }
  if (edit.action === "crop_or_blur_image") {
    return edit.original ? `In the photo: "${edit.original}". ${edit.explanation}` : edit.explanation;
  }
  return edit.explanation;
}

const STALE_APPLY_NOTE = "Out of date. Check again before applying.";

function renderFinding(
  finding: Finding,
  result: AnalyzeResponse,
  sourcesById: Map<string, TextSource>,
  onApplyEdit: (edit: SuggestedEdit, analyzedDraftHash: string) => void,
  stale: boolean,
) {
  const li = el("li", `finding sev-${finding.severity}`);
  li.id = `finding-${finding.id}`;
  li.tabIndex = -1;

  const head = el("div", "finding-head");
  head.append(el("span", "severity", `${finding.severity[0].toUpperCase()}${finding.severity.slice(1)} risk`));
  head.append(el("span", undefined, CATEGORY_LABELS[finding.category] ?? finding.category));
  if (finding.crossSource) head.append(el("span", undefined, "Combines several sources"));
  if (result.mode === "mock") head.append(el("span", "practice-tag", "Practice result, not AI"));
  li.append(head);

  // --- OBSERVED: evidence from the user's own text ---------------------------
  const observed = el("div", "observed");
  observed.append(el("h4", undefined, "From your text"));
  const evList = el("ul", "evidence");
  finding.evidence.forEach((ev, i) => {
    const item = el("li");
    const btn = el("button");
    btn.type = "button";
    const source = sourcesById.get(ev.sourceId);
    btn.append(el("span", ev.sourceId.startsWith("history") ? "source-tag history" : "source-tag", sourceLabel(source, ev.sourceId)));
    btn.append(el("span", "quote", `“${ev.quote}”`));
    btn.append(
      ev.verified
        ? el("span", "verified", "Found in your text")
        : el("span", "unverified", "Not found in your text; the AI may have made it up"),
    );
    btn.title = ev.verified ? "Show where this is in your text" : "This quote could not be found in your text";
    btn.addEventListener("click", () => flash(evidenceNodes(`${finding.id}:${i}`)));
    item.append(btn);
    evList.append(item);
  });
  observed.append(evList);

  // --- AI INTERPRETATION -----------------------------------------------------
  const ai = el("div", "interpretation");
  ai.append(el("h4", undefined, result.mode === "mock" ? "What this might reveal (keyword rule)" : "What this might reveal (AI)"));
  ai.append(el("p", "exposure", finding.exposure));

  const sureWord = { high: "Fairly sure", medium: "Somewhat sure", low: "Not very sure" }[finding.confidence];
  const unc = el("p", "uncertainty");
  unc.append(el("strong", undefined, `Confidence: ${sureWord}. `));
  unc.append(finding.uncertainty || "No reason given for possible mistakes.");
  ai.append(unc);

  if (finding.suggestedEdits.length > 0) {
    ai.append(el("h4", undefined, "Suggested changes"));
    const edits = el("ul", "edits");
    for (const edit of finding.suggestedEdits) {
      const item = el("li");
      item.append(el("span", "edit-text", describeEdit(edit)));
      if (canApply(edit, sourcesById)) {
        const apply = el("button", "secondary small apply", "Apply");
        apply.type = "button";
        apply.addEventListener("click", () => onApplyEdit(edit, result.draftHash));
        item.append(apply);
        item.append(el("span", "stale-note", STALE_APPLY_NOTE));
      } else if (edit.action === "crop_or_blur_image") {
        item.append(el("span", "advice-tag", "Edit the photo yourself"));
      } else {
        item.append(el("span", "advice-tag", "Advice only"));
      }
      edits.append(item);
    }
    ai.append(edits);
  }

  li.append(observed, ai);
  setCardStale(li, stale);
  return li;
}

/** Disable (or re-enable) the Apply buttons inside one part of the page. */
function setCardStale(root: HTMLElement, stale: boolean) {
  root.querySelectorAll<HTMLButtonElement>("button.apply").forEach((b) => {
    b.disabled = stale;
    b.title = stale ? STALE_APPLY_NOTE : "Apply this change to your caption";
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface ResultElements {
  root: HTMLElement;
  summary: HTMLElement;
  markedDraft: HTMLElement;
  findings: HTMLElement;
  meta: HTMLElement;
  mockBanner: HTMLElement;
  incompleteBanner: HTMLElement;
}

export interface RenderOptions {
  /** true if the draft has changed since this result was produced. */
  stale?: boolean;
}

/** Text for the "this check is incomplete" banner, or null if it is complete. */
export function incompleteMessage(result: AnalyzeResponse): string | null {
  const n = result.droppedFindings;
  if (!n || n <= 0) return null;
  return (
    `Incomplete check: ${n} possible warning${n === 1 ? " was" : "s were"} not shown because ` +
    `${n === 1 ? "it" : "they"} could not be checked against your text. Check again, or review the post yourself.`
  );
}

/**
 * Mark results as out of date (or current again). While stale, every Apply
 * button is disabled, so an old suggestion can't be applied as if it were current.
 */
export function setResultsStale(els: ResultElements, stale: boolean) {
  els.root.classList.toggle("is-stale", stale);
  setCardStale(els.findings, stale);
}

/**
 * Draws any AnalyzeResponse (docs/TEAM.md interface E). `onApplyEdit` receives
 * the edit and the draftHash it was made for; the caller must re-check that the
 * draft still has that hash before changing anything.
 */
export function renderResults(
  els: ResultElements,
  result: AnalyzeResponse,
  sources: TextSource[],
  onApplyEdit: (edit: SuggestedEdit, analyzedDraftHash: string) => void,
  options: RenderOptions = {},
) {
  const stale = !!options.stale;
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  els.root.hidden = false;
  els.mockBanner.hidden = result.mode !== "mock";
  const incomplete = incompleteMessage(result);
  els.incompleteBanner.hidden = incomplete === null;
  els.incompleteBanner.textContent = incomplete ?? "";
  els.summary.textContent = result.summary;

  const showFinding = (id: string) => flash(document.getElementById(`finding-${id}`));

  // Marked-up draft (observed text with verified evidence highlighted)
  els.markedDraft.replaceChildren();
  els.markedDraft.append(el("p", "marked-legend", "Your text. Highlights show quotes found in it."));
  for (const source of sources) {
    if (!source.text.trim()) continue;
    els.markedDraft.append(el("h3", source.type === "history" ? "history" : undefined, sourceLabel(source, source.id)));
    els.markedDraft.append(renderMarkedText(source, result.findings, showFinding));
  }

  // Finding cards
  els.findings.replaceChildren();
  // "Nothing stood out" only when the check is COMPLETE. If findings were
  // dropped, the banner above explains that instead.
  if (resultOutcome(result) === "clean") {
    els.findings.append(
      el(
        "li",
        "empty",
        result.mode === "mock"
          ? "No keyword rules matched. Practice mode is not an AI check, so review the post yourself before sharing."
          : "Nothing stood out. You can still review the post yourself before sharing.",
      ),
    );
  }
  for (const finding of result.findings) {
    els.findings.append(renderFinding(finding, result, sourcesById, onApplyEdit, stale));
  }

  const when = new Date(result.analyzedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  els.meta.textContent =
    result.mode === "mock"
      ? `Checked at ${when} in practice mode (keyword rules, not AI). Request ${result.requestId.slice(0, 8)}.`
      : `Checked at ${when} with ${result.model} (prompt ${result.promptVersion}). Request ${result.requestId.slice(0, 8)}.`;

  setResultsStale(els, stale);
}
