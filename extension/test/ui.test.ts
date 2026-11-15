// Tests for the warning interface's pure logic (no DOM needed).
// Run with: npm test   (in the extension folder)
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type AnalyzeResponse, type Finding, type OcrResult, type TextSource } from "../../shared/contract";
import { describeEdit, sourceLabel } from "../src/render";
import { describeSubmission } from "../src/ui/consent";
import { historyControlsAvailable, historySources } from "../src/ui/history";
import { isLocalImageUrl, matchQuoteToWords, ocrConfidenceHint, ocrHighlightBoxes } from "../src/ui/ocr";
import { describeError, resultOutcome, statusLine } from "../src/ui/state";

function response(overrides: Partial<AnalyzeResponse> = {}): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: "r",
    draftHash: "0".repeat(64),
    mode: "databricks",
    model: "m",
    promptVersion: "p",
    analyzedAt: "2026-11-14T12:00:00Z",
    summary: "",
    findings: [],
    droppedFindings: 0,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    category: "contact",
    severity: "high",
    exposure: "x",
    evidence: [{ sourceId: "image_text:1", quote: "608-555-0142", verified: true }],
    crossSource: false,
    confidence: "low",
    uncertainty: "",
    suggestedEdits: [],
    ...overrides,
  };
}

// --- Valid empty vs. incomplete vs. failed ------------------------------------

test("only a complete result with no findings counts as clean", () => {
  assert.equal(resultOutcome(response()), "clean");
  assert.equal(resultOutcome(response({ findings: [finding()] })), "findings");
  assert.equal(resultOutcome(response({ droppedFindings: 1 })), "incomplete");
  assert.equal(resultOutcome(response({ findings: [finding()], droppedFindings: 2 })), "incomplete");
});

test("incomplete, failed, unavailable and skipped never say 'nothing stood out'", () => {
  const views = [
    statusLine({ kind: "completed", result: response({ droppedFindings: 3 }) }),
    statusLine({ kind: "error", message: "boom" }),
    statusLine({ kind: "unavailable", reason: "offline" }),
    statusLine({ kind: "skipped" }),
    statusLine({ kind: "loading", sourceCount: 2 }),
  ];
  for (const v of views) assert.doesNotMatch(v.text, /nothing stood out/i);
  assert.match(statusLine({ kind: "completed", result: response() }).text, /nothing stood out/i);
});

test("errors are explained as 'not checked', never as a clean result", () => {
  for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "BAD_MODEL_OUTPUT", "BAD_REQUEST", "FORBIDDEN", "INTERNAL", undefined] as const) {
    assert.match(describeError(code, "m").detail, /NOT a clean result/);
  }
});

// --- Consent lists exactly what will be sent -----------------------------------

test("consent groups caption, photo text and approved history with dates", () => {
  const sources: TextSource[] = [
    { id: "caption", type: "caption", text: "hello" },
    { id: "image_text:1", type: "image_text", text: "sign" },
    { id: "history:p1", type: "history", text: "old post", date: "2026-03-02T10:00:00Z" },
  ];
  const s = describeSubmission(sources);
  assert.deepEqual(s.caption.map((i) => i.text), ["hello"]);
  assert.deepEqual(s.imageText.map((i) => i.label), ["Photo text 1"]);
  assert.equal(s.history[0].label, "Earlier post you approved, posted 2026-03-02");
  assert.equal(s.totalChars, 5 + 4 + 8);
});

// --- History --------------------------------------------------------------------

test("history controls only when connected or a labeled fixture", () => {
  assert.equal(historyControlsAvailable("not_connected"), false);
  assert.equal(historyControlsAvailable("connected"), true);
  assert.equal(historyControlsAvailable("fixture"), true);
});

test("approved history becomes history:<postId> sources with their date", () => {
  const [src] = historySources([{ postId: "p9", postedAt: "2026-01-05T00:00:00Z", caption: "c", imageText: "t" }]);
  assert.deepEqual(src, { id: "history:p9", type: "history", text: "c\n\nPhoto text: t", date: "2026-01-05T00:00:00Z" });
  assert.equal(sourceLabel(src, src.id), "Earlier post, posted 2026-01-05");
  assert.equal(sourceLabel(undefined, "history:x"), "Earlier post, posted date unknown");
});

// --- OCR review and image highlights --------------------------------------------

const OCR: OcrResult = {
  sourceId: "image_text:1",
  text: "Coach Dana 608-555-0142",
  confidence: 64,
  words: [
    { text: "Coach", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    { text: "Dana", bbox: { x0: 12, y0: 0, x1: 20, y1: 10 } },
    { text: "608-555-0142,", bbox: { x0: 22, y0: 2, x1: 50, y1: 12 } },
  ],
};

test("quotes are matched to whole OCR words, ignoring case and edge punctuation", () => {
  assert.deepEqual(matchQuoteToWords(OCR.words!, "coach dana"), [0, 1]);
  assert.deepEqual(matchQuoteToWords(OCR.words!, "608-555-0142"), [2]);
  assert.equal(matchQuoteToWords(OCR.words!, "Dana Coach"), null);
  assert.equal(matchQuoteToWords(OCR.words!, "  "), null);
});

test("only VERIFIED evidence from this photo is boxed on the preview", () => {
  const boxes = ocrHighlightBoxes(OCR, [
    finding({
      evidence: [
        { sourceId: "image_text:1", quote: "Coach Dana", verified: true },
        { sourceId: "image_text:1", quote: "608-555-0142", verified: false },
        { sourceId: "caption", quote: "Dana", verified: true },
      ],
    }),
  ]);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].bbox, { x0: 0, y0: 0, x1: 20, y1: 10 });
  assert.equal(boxes[0].evidenceIndex, 0);
  assert.deepEqual(ocrHighlightBoxes({ ...OCR, words: undefined }, [finding()]), []);
});

test("only local images can be previewed", () => {
  assert.equal(isLocalImageUrl("blob:chrome-extension://abc/123"), true);
  assert.equal(isLocalImageUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isLocalImageUrl("https://example.com/photo.jpg"), false);
  assert.equal(isLocalImageUrl("data:text/html,<script>"), false);
  assert.equal(isLocalImageUrl(undefined), false);
});

test("low OCR confidence asks the user to check the text", () => {
  assert.equal(ocrConfidenceHint(64).low, true);
  assert.equal(ocrConfidenceHint(91).low, false);
  assert.match(ocrConfidenceHint(150).text, /100%/);
});

// --- Suggested edits wording ----------------------------------------------------

test("advice-only and photo edits are described without implying auto-apply", () => {
  assert.equal(
    describeEdit({ sourceId: "image_text:1", action: "crop_or_blur_image", original: "608-555-0142", explanation: "Blur it." }),
    'In the photo: "608-555-0142". Blur it.',
  );
  // A generalize without replacement (backend should have made it "other") falls back to advice text.
  assert.equal(describeEdit({ sourceId: "caption", action: "generalize", original: "Maple St", explanation: "Be vaguer." }), "Be vaguer.");
});
