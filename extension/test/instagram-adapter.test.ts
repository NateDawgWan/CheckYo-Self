// Tests for the page-independent parts of src/content/instagram-adapter.ts.
// (The parts that read Instagram's page are checked by hand on the live site;
// see docs/ROADMAP.md.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOutcomeText, isShareLabel, normalizeCaption } from "../src/content/instagram-adapter";

test("caption text is normalized the way the user sees it", () => {
  assert.equal(normalizeCaption("  hi there\r\nline 2\n\n"), "hi there\nline 2");
  assert.equal(normalizeCaption("\n"), "");
});

test("only the exact word Share counts as the Share button", () => {
  assert.equal(isShareLabel(" Share "), true);
  assert.equal(isShareLabel("share"), true);
  assert.equal(isShareLabel("Share to Facebook"), false);
  assert.equal(isShareLabel("Next"), false);
  assert.equal(isShareLabel(null), false);
});

test("confirmation, failure and neither are told apart", () => {
  assert.equal(classifyOutcomeText("Post shared\nYour post has been shared."), "published");
  assert.equal(classifyOutcomeText("Your post couldn't be shared. Try again."), "failed");
  assert.equal(classifyOutcomeText("Sharing"), null);
  assert.equal(classifyOutcomeText("Create new post"), null);
});
