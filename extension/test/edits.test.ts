// Regression tests for the "Apply" button rules (src/edits.ts).
// Run with: npm test   (in the extension folder)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SuggestedEdit } from "../../shared/contract";
import { applyEditToText, canApplyEdit } from "../src/edits";

const CAPTION = "Picking up Emma at Lincoln Elementary today";

function edit(overrides: Partial<SuggestedEdit>): SuggestedEdit {
  return { sourceId: "caption", action: "replace", original: "Lincoln Elementary", explanation: "x", ...overrides };
}

test("replace/generalize with no replacement is NOT applicable and changes nothing", () => {
  for (const action of ["replace", "generalize"] as const) {
    for (const replacement of [undefined, "", "   "]) {
      const e = edit({ action, replacement });
      assert.equal(canApplyEdit(e, CAPTION), false, `${action} with replacement=${JSON.stringify(replacement)}`);
      const result = applyEditToText(CAPTION, e);
      assert.equal(result.ok, false);
    }
  }
});

test("missing replacement can never delete the whole caption", () => {
  const result = applyEditToText("Lincoln Elementary", edit({ action: "generalize", replacement: undefined }));
  assert.equal(result.ok, false);
});

test("a complete replace edit is applied", () => {
  const result = applyEditToText(CAPTION, edit({ replacement: "school" }));
  assert.deepEqual(result, { ok: true, text: "Picking up Emma at school today" });
});

test("remove deletes only the quoted text and tidies spaces", () => {
  const result = applyEditToText(CAPTION, edit({ action: "remove", original: "at Lincoln Elementary" }));
  assert.deepEqual(result, { ok: true, text: "Picking up Emma today" });
});

test("an edit that would empty the caption is refused", () => {
  const result = applyEditToText("Lincoln Elementary", edit({ action: "remove" }));
  assert.equal(result.ok, false);
});

test("advice-only actions and non-caption sources are never applied", () => {
  assert.equal(canApplyEdit(edit({ action: "crop_or_blur_image", replacement: "x" }), CAPTION), false);
  assert.equal(canApplyEdit(edit({ action: "other", replacement: "x" }), CAPTION), false);
  assert.equal(canApplyEdit(edit({ sourceId: "image_text:1", replacement: "x" }), CAPTION), false);
});

test("missing original, or text no longer in the caption, is refused", () => {
  assert.equal(canApplyEdit(edit({ original: undefined, replacement: "x" }), CAPTION), false);
  assert.equal(canApplyEdit(edit({ original: "Maple St", replacement: "home" }), CAPTION), false);
});
