// Popup logic for milestone 1: type a caption (and optional photo text),
// send it to the backend, show the findings, and mark them out of date
// as soon as the draft changes.
import type { AnalyzeResponse, SuggestedEdit, TextSource } from "../../shared/contract";
import { analyzeDraft, checkHealth, hashSources } from "./api";
import { renderResults, type ResultElements } from "./render";

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
const analyzeButton = byId<HTMLButtonElement>("analyze");
const reanalyzeButton = byId<HTMLButtonElement>("reanalyze");
const sampleButton = byId<HTMLButtonElement>("load-sample");
const message = byId<HTMLParagraphElement>("message");
const statusPill = byId<HTMLSpanElement>("backend-status");
const staleBanner = byId<HTMLDivElement>("stale-banner");
const resultEls: ResultElements = {
  root: byId("results"),
  summary: byId("summary"),
  markedDraft: byId("marked-draft"),
  findings: byId("findings"),
  meta: byId("meta"),
  mockBanner: byId("mock-banner"),
};

/** The last result we showed, plus the exact text it was about. */
let lastResult: AnalyzeResponse | null = null;
let hashTurn = 0;

function setMessage(text: string, kind: "info" | "error" = "info") {
  message.textContent = text;
  message.dataset.kind = kind;
}

/** The draft as TextSources. Only text — never the image itself. */
function collectSources(): TextSource[] {
  const sources: TextSource[] = [{ id: "caption", type: "caption", text: captionInput.value }];
  if (imageTextInput.value.trim()) {
    sources.push({ id: "image_text:1", type: "image_text", text: imageTextInput.value });
  }
  return sources;
}

/** Step 6: if the draft no longer matches the analyzed text, mark results stale. */
async function updateStaleness() {
  if (!lastResult) return;
  const myTurn = ++hashTurn;
  const currentHash = await hashSources(collectSources());
  if (myTurn !== hashTurn) return; // a newer keystroke already started a check
  const stale = currentHash !== lastResult.draftHash;
  staleBanner.hidden = !stale;
  resultEls.root.classList.toggle("is-stale", stale);
}

async function analyze() {
  const sources = collectSources();
  if (!sources.some((s) => s.text.trim())) {
    setMessage("Write a caption first.", "error");
    return;
  }

  analyzeButton.disabled = true;
  reanalyzeButton.disabled = true;
  setMessage("Checking your post…");
  try {
    const draftHash = await hashSources(sources);
    const result = await analyzeDraft(sources, draftHash);
    lastResult = result;
    renderResults(resultEls, result, sources, applyEdit);
    const n = result.findings.length;
    setMessage(n === 0 ? "Check complete." : `Check complete: ${n} thing${n === 1 ? "" : "s"} to review.`);
    await updateStaleness(); // the user may have typed while we waited
  } catch (err) {
    setMessage((err as Error).message, "error");
  } finally {
    analyzeButton.disabled = false;
    reanalyzeButton.disabled = false;
  }
}

/** "Apply" on a suggested edit: change the caption, which makes results stale. */
function applyEdit(edit: SuggestedEdit) {
  if (!edit.original) return;
  const text = captionInput.value;
  const start = text.toLowerCase().indexOf(edit.original.toLowerCase());
  if (start === -1) {
    setMessage("That text is no longer in your caption.", "error");
    return;
  }
  const replacement = edit.action === "remove" ? "" : (edit.replacement ?? "");
  captionInput.value = (text.slice(0, start) + replacement + text.slice(start + edit.original.length))
    .replace(/ {2,}/g, " ")
    .trim();
  captionInput.dispatchEvent(new Event("input"));
  setMessage("Change applied. Check again to see updated results.");
}

async function showBackendStatus() {
  const health = await checkHealth();
  if (!health) {
    statusPill.dataset.state = "offline";
    statusPill.textContent = "Backend offline";
    setMessage("Start the backend: open the backend folder and run `npm run dev`.", "error");
  } else if (health.mode === "mock") {
    statusPill.dataset.state = "mock";
    statusPill.textContent = "Practice mode";
  } else {
    statusPill.dataset.state = "databricks";
    statusPill.textContent = "Databricks connected";
  }
}

captionInput.addEventListener("input", updateStaleness);
imageTextInput.addEventListener("input", updateStaleness);
analyzeButton.addEventListener("click", analyze);
reanalyzeButton.addEventListener("click", analyze);
sampleButton.addEventListener("click", () => {
  captionInput.value = SAMPLE_CAPTION;
  imageTextInput.value = SAMPLE_IMAGE_TEXT;
  captionInput.dispatchEvent(new Event("input"));
  captionInput.focus();
});

showBackendStatus();
