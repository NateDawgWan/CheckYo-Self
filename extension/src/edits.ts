// Rules for the "Apply" button on a suggested edit. Kept separate from the
// popup and the rendering code (no DOM here) so it can be tested on its own.
//
// SAFETY: an edit is only applied when it is complete. In particular, a
// "replace" or "generalize" without replacement text must NOT be treated as
// "replace with nothing" — that would silently delete part of the caption.
import type { SuggestedEdit } from "../../shared/contract";

/** The result of trying to apply an edit: either the new text, or why not. */
export type ApplyResult = { ok: true; text: string } | { ok: false; reason: string };

/** Find `original` in `text`, ignoring upper/lower case. -1 if not found. */
function findIgnoringCase(text: string, original: string): number {
  return text.toLowerCase().indexOf(original.toLowerCase());
}

/**
 * Is this edit safe to apply automatically to the caption text?
 * Used to decide whether to show an "Apply" button at all.
 */
export function canApplyEdit(edit: SuggestedEdit, captionText: string): boolean {
  return applyEditToText(captionText, edit).ok;
}

/**
 * Applies one suggested edit to the caption text and returns the new text.
 * Returns { ok: false } (and changes nothing) if the edit is incomplete,
 * doesn't match the current text, or would leave the caption empty.
 */
export function applyEditToText(text: string, edit: SuggestedEdit): ApplyResult {
  if (edit.sourceId !== "caption") return { ok: false, reason: "Only caption text can be changed automatically." };

  const original = edit.original?.trim() ?? "";
  if (!original) return { ok: false, reason: "This suggestion doesn't say which text to change." };

  let replacement: string;
  if (edit.action === "remove") {
    replacement = "";
  } else if (edit.action === "replace" || edit.action === "generalize") {
    replacement = edit.replacement?.trim() ?? "";
    // No replacement text = incomplete suggestion. Never treat it as "delete".
    if (!replacement) return { ok: false, reason: "This suggestion has no replacement text." };
  } else {
    return { ok: false, reason: "This suggestion is advice only." };
  }

  const start = findIgnoringCase(text, original);
  if (start === -1) return { ok: false, reason: "That text is no longer in your caption." };

  const newText = (text.slice(0, start) + replacement + text.slice(start + original.length))
    .replace(/ {2,}/g, " ")
    .trim();

  // A single suggestion should never wipe out the whole caption.
  if (!newText) return { ok: false, reason: "Applying this would leave the caption empty." };

  return { ok: true, text: newText };
}
