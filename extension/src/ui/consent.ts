// The consent step shown BEFORE anything is sent for analysis. It lists exactly
// which text will be submitted (caption, photo text, approved earlier posts),
// and offers three choices: Analyze, Continue without analysis, Return to editing.
import type { AnalysisMode, TextSource } from "../../../shared/contract";
import { button, el, shortDate } from "./dom";

/** One line in the "what will be sent" list. Pure data, so it can be tested. */
export interface SubmissionItem {
  sourceId: string;
  label: string;   // "Caption", "Photo text 1", "Earlier post, 2026-03-02"
  text: string;    // the exact text that will be sent
  chars: number;
}

export interface SubmissionSummary {
  caption: SubmissionItem[];
  imageText: SubmissionItem[];
  history: SubmissionItem[];
  totalChars: number;
}

/** Group the sources the way the consent screen shows them. */
export function describeSubmission(sources: TextSource[]): SubmissionSummary {
  const summary: SubmissionSummary = { caption: [], imageText: [], history: [], totalChars: 0 };
  let photoNumber = 0;
  for (const s of sources) {
    const item: SubmissionItem = { sourceId: s.id, label: "", text: s.text, chars: s.text.length };
    if (s.type === "caption") {
      item.label = "Caption";
      summary.caption.push(item);
    } else if (s.type === "image_text") {
      photoNumber++;
      item.label = `Photo text ${photoNumber}`;
      summary.imageText.push(item);
    } else {
      item.label = `Earlier post you approved, posted ${shortDate(s.date)}`;
      summary.history.push(item);
    }
    summary.totalChars += item.chars;
  }
  return summary;
}

export interface ConsentCallbacks {
  /** The user agreed. `sources` is EXACTLY what was listed; send nothing else. */
  onAnalyze(sources: TextSource[]): void;
  /** The user chose not to send anything. */
  onContinueWithoutAnalysis(): void;
  /** The user wants to keep editing; nothing is sent. */
  onReturnToEditing(): void;
}

function renderGroup(title: string, items: SubmissionItem[], emptyText: string) {
  const group = el("div", "consent-group");
  group.append(el("h3", undefined, title));
  if (items.length === 0) {
    group.append(el("p", "consent-none", emptyText));
    return group;
  }
  const list = el("ul", "consent-list");
  for (const item of items) {
    const li = el("li");
    const details = el("details");
    const summary = el("summary");
    summary.append(el("span", "consent-label", item.label));
    summary.append(el("span", "consent-count", `${item.chars} characters`));
    details.append(summary);
    // The full text that will be sent, shown as plain text.
    details.append(el("p", "consent-text", item.text || "(empty)"));
    li.append(details);
    list.append(li);
  }
  group.append(list);
  return group;
}

/**
 * Draw the consent panel into `container`. Returns nothing; the panel calls
 * exactly one of the callbacks when the user chooses.
 */
export function renderConsent(
  container: HTMLElement,
  sources: TextSource[],
  options: { mode: AnalysisMode | null; warnings?: string[] },
  callbacks: ConsentCallbacks,
) {
  const { mode, warnings = [] } = options;
  const summary = describeSubmission(sources);
  container.replaceChildren();

  container.append(el("h2", undefined, "Before we check this post"));
  container.append(
    el(
      "p",
      "consent-intro",
      "To check your post, the text below is sent to the Second Look backend, which sends it to a cloud AI " +
        "model for analysis. Only text is sent. Your photo itself never leaves this computer.",
    ),
  );
  if (mode === "mock") {
    container.append(
      el(
        "p",
        "banner banner-mock",
        "Practice mode is on: the backend uses simple keyword rules and does not send your text to a cloud AI model.",
      ),
    );
  }

  container.append(renderGroup("Caption", summary.caption, "No caption."));
  container.append(
    renderGroup("Text read from the photo", summary.imageText, "No photo text will be sent."),
  );
  container.append(
    renderGroup("Earlier posts you approved", summary.history, "No earlier posts will be sent."),
  );
  container.append(el("p", "consent-total", `Total: ${summary.totalChars} characters of text.`));
  for (const warning of warnings) container.append(el("p", "banner banner-stale", warning));

  // Snapshot the sources so later edits to the draft can't change what is sent.
  const snapshot: TextSource[] = sources.map((s) => ({ ...s }));

  const actions = el("div", "actions consent-actions");
  actions.append(button("Return to editing", "secondary", () => callbacks.onReturnToEditing()));
  actions.append(button("Continue without analysis", "secondary", () => callbacks.onContinueWithoutAnalysis()));
  const analyze = button("Analyze", "primary", () => callbacks.onAnalyze(snapshot));
  analyze.dataset.role = "consent-analyze";
  actions.append(analyze);
  container.append(actions);
  analyze.focus();
}
