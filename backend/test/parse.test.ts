// Regression tests for parse.ts: how we treat the model's answer.
// Run with: npm test   (in the backend folder)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextSource } from "../../shared/contract";
import { AppError } from "../src/errors";
import { normalizeEdit, parseModelOutput } from "../src/parse";

const CAPTION = "Picking up Emma at Lincoln Elementary at 3:15 every weekday.";
const PHOTO = "Riverside Youth Soccer, U10 Tigers";
const SOURCES: TextSource[] = [
  { id: "caption", type: "caption", text: CAPTION },
  { id: "image_text:1", type: "image_text", text: PHOTO },
];
const SOURCE_MAP = new Map(SOURCES.map((s) => [s.id, s]));

/** A well-formed finding; tests override parts of it. */
function finding(overrides: Record<string, unknown> = {}) {
  return {
    category: "children",
    severity: "high",
    exposure: "Names a school.",
    evidence: [{ sourceId: "caption", quote: "Lincoln Elementary" }],
    confidence: "medium",
    uncertainty: "May not be your child.",
    suggestedEdits: [],
    ...overrides,
  };
}

function expectBadOutput(raw: string) {
  assert.throws(
    () => parseModelOutput(raw, SOURCES),
    (err: unknown) => err instanceof AppError && err.code === "BAD_MODEL_OUTPUT",
  );
}

// --- 1. Malformed output is an error, not a clean empty result -------------

test("rejects output with no findings field", () => {
  expectBadOutput(JSON.stringify({ summary: "All good" }));
});

test("rejects findings that is not an array", () => {
  expectBadOutput(JSON.stringify({ summary: "x", findings: "none" }));
  expectBadOutput(JSON.stringify({ summary: "x", findings: { a: 1 } }));
  expectBadOutput(JSON.stringify({ summary: "x", findings: null }));
});

test("rejects a summary that is not text", () => {
  expectBadOutput(JSON.stringify({ summary: 42, findings: [] }));
});

test("rejects non-JSON and JSON arrays", () => {
  expectBadOutput("Sorry, I can't help with that.");
  expectBadOutput("[1, 2, 3]");
});

test("accepts a genuinely empty findings list as a clean result", () => {
  const result = parseModelOutput(JSON.stringify({ summary: "Nothing notable.", findings: [] }), SOURCES);
  assert.equal(result.findings.length, 0);
  assert.equal(result.droppedFindings, 0);
});

test("still accepts JSON wrapped in code fences", () => {
  const raw = "```json\n" + JSON.stringify({ summary: "s", findings: [finding()] }) + "\n```";
  assert.equal(parseModelOutput(raw, SOURCES).findings.length, 1);
});

// --- 2. Verified evidence, crossSource, dropped findings --------------------

test("drops a finding whose only quote is not in the text, and counts it", () => {
  const raw = JSON.stringify({
    summary: "s",
    findings: [finding({ evidence: [{ sourceId: "caption", quote: "123 Maple Street" }] })],
  });
  const result = parseModelOutput(raw, SOURCES);
  assert.equal(result.findings.length, 0);
  assert.equal(result.droppedFindings, 1, "a dropped finding must be reported, not hidden");
});

test("counts malformed findings (wrong types) as dropped", () => {
  const raw = JSON.stringify({
    summary: "s",
    findings: [
      "not an object",
      null,
      finding({ exposure: 5 }),
      finding({ evidence: "Lincoln Elementary" }),
      finding({ suggestedEdits: "remove it" }),
      finding(), // the only valid one
    ],
  });
  const result = parseModelOutput(raw, SOURCES);
  assert.equal(result.findings.length, 1);
  assert.equal(result.droppedFindings, 5);
});

test("crossSource uses verified evidence only", () => {
  const madeUp = finding({
    evidence: [
      { sourceId: "caption", quote: "Lincoln Elementary" },
      { sourceId: "image_text:1", quote: "Coach Dana" }, // NOT in the photo text
    ],
  });
  const real = finding({
    evidence: [
      { sourceId: "caption", quote: "Lincoln Elementary" },
      { sourceId: "image_text:1", quote: "U10 Tigers" },
    ],
  });
  const result = parseModelOutput(JSON.stringify({ summary: "s", findings: [madeUp, real] }), SOURCES);
  assert.equal(result.findings[0].crossSource, false, "an unverified quote must not make it cross-source");
  assert.equal(result.findings[1].crossSource, true);
});

test("keeps unverified quotes labeled, after the verified ones", () => {
  const raw = JSON.stringify({
    summary: "s",
    findings: [
      finding({
        evidence: [
          { sourceId: "caption", quote: "made up words" },
          { sourceId: "caption", quote: "lincoln   elementary" }, // case/space differences are OK
        ],
      }),
    ],
  });
  const [f] = parseModelOutput(raw, SOURCES).findings;
  assert.deepEqual(
    f.evidence.map((e) => e.verified),
    [true, false],
  );
});

test("findings over the limit of 8 are counted as dropped", () => {
  const raw = JSON.stringify({ summary: "s", findings: Array.from({ length: 10 }, () => finding()) });
  const result = parseModelOutput(raw, SOURCES);
  assert.equal(result.findings.length, 8);
  assert.equal(result.droppedFindings, 2);
});

// --- 3. Suggested edits are validated before they can be applied -------------

test("replace/generalize without replacement text becomes advice only", () => {
  for (const action of ["replace", "generalize"]) {
    const edit = normalizeEdit(
      { sourceId: "caption", action, original: "Lincoln Elementary", explanation: "Be vaguer." },
      SOURCE_MAP,
    );
    assert.equal(edit?.action, "other", `${action} with no replacement must not be applicable`);
  }
  const blank = normalizeEdit(
    { sourceId: "caption", action: "replace", original: "Lincoln Elementary", replacement: "   ", explanation: "x" },
    SOURCE_MAP,
  );
  assert.equal(blank?.action, "other", "whitespace-only replacement counts as missing");
});

test("edits whose original text is missing or not in the source become advice only", () => {
  const noOriginal = normalizeEdit({ sourceId: "caption", action: "remove", explanation: "x" }, SOURCE_MAP);
  assert.equal(noOriginal?.action, "other");
  const wrongOriginal = normalizeEdit(
    { sourceId: "caption", action: "replace", original: "Maple St", replacement: "home", explanation: "x" },
    SOURCE_MAP,
  );
  assert.equal(wrongOriginal?.action, "other");
});

test("a complete replace edit is kept as-is", () => {
  const edit = normalizeEdit(
    { sourceId: "caption", action: "replace", original: "Lincoln Elementary", replacement: "school", explanation: "x" },
    SOURCE_MAP,
  );
  assert.deepEqual(edit, {
    sourceId: "caption",
    action: "replace",
    original: "Lincoln Elementary",
    replacement: "school",
    explanation: "x",
  });
});
