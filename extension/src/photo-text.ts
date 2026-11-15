// Rules for the photo text the OCR reads, before the user sees it:
//   1. a STRICT size limit (demo safety: keeps requests to the backend small
//      and stops a text-heavy photo from breaking anything), and
//   2. a quality check, so a noisy, low-quality read is explained to the user
//      instead of being passed along silently.
// No DOM and no Chrome here, so it can be tested in Node (test/photo-text.test.ts).
import type { OcrResult } from "./ocr/types";

/**
 * The most photo text we keep, in characters (about 150-200 words).
 * Deliberately far below the backend's 5000 per source: this is a demo, and a
 * caption photo rarely has more text than this. OCR text past this point is
 * dropped, and the user is told. The photo-text box enforces it too.
 */
export const PHOTO_TEXT_MAX_CHARS = 1000;

export interface LimitedText {
  text: string;
  /** true if text was dropped to stay within the limit. */
  truncated: boolean;
  /** Length before cutting, to tell the user how much was dropped. */
  originalLength: number;
}

/**
 * Cuts `text` to at most `max` characters, at a word boundary when possible
 * (so a word is never cut in half), and trims the end.
 */
export function limitPhotoText(text: string, max: number = PHOTO_TEXT_MAX_CHARS): LimitedText {
  if (text.length <= max) return { text, truncated: false, originalLength: text.length };
  const head = text.slice(0, max);
  const lastBreak = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  // Cut at the last space/line break, unless that would throw away most of the text.
  const cut = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return { text: cut.trimEnd(), truncated: true, originalLength: text.length };
}

/** The message shown when OCR text was cut to the limit. */
export function truncationNotice(limited: LimitedText, max: number = PHOTO_TEXT_MAX_CHARS): string {
  return (
    `This photo has a lot of text (${limited.originalLength} characters). The reader stopped at the ` +
    `${max}-character limit, so only the first part is kept and checked.`
  );
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

/** Below this average reader confidence (0-100) the whole read is treated as unreliable. */
export const POOR_MEAN_CONFIDENCE = 60;
/** If at least this share of the words are unclear or junk, the read is poor. */
export const POOR_NOISE_SHARE = 0.4;

/** Punctuation that stands alone in real text, e.g. "U10 Tigers - Spring Season", "Salt & Pepper". */
const NORMAL_SEPARATORS = /^[-–—&+/]$/;

/**
 * Is this "word" probably noise rather than real text? For example "©", "~",
 * "00000000000", "oooo", or a stray single letter. (Single digits like "3" on a
 * jersey, and separators like "-" or "&", are kept as real.)
 */
export function isJunkWord(word: string): boolean {
  if (NORMAL_SEPARATORS.test(word.trim())) return false;
  const core = word.replace(/[^\p{L}\p{N}]/gu, "");
  if (core.length === 0) return true;                   // only symbols: "©", "~", ":"
  if (/(.)\1{3,}/iu.test(core)) return true;            // 4+ of the same character: "00000000000"
  if (core.length === 1 && /\p{L}/u.test(core) && !/^[aAiI]$/.test(core)) return true; // stray letter
  return false;
}

export type PhotoQuality = "clean" | "noisy" | "poor" | "no_text";

export interface QualityReport {
  level: PhotoQuality;
  /** Words that are low-confidence or look like junk. */
  noisyWordCount: number;
  wordCount: number;
  /** A few of the noisy words, to show the user what was unclear. */
  examples: string[];
  /** What to tell the user, or null when there's nothing to say. */
  message: string | null;
}

/** How trustworthy is this OCR read? Decides the notice shown above the photo text. */
export function assessPhotoQuality(result: OcrResult): QualityReport {
  const words = result.words;
  if (result.status === "no_text" || words.length === 0) {
    return { level: "no_text", noisyWordCount: 0, wordCount: 0, examples: [], message: null };
  }
  const low = new Set(result.lowConfidenceWordIds);
  const noisy = words.filter((w) => low.has(w.id) || isJunkWord(w.text));
  const examples = [...new Set(noisy.map((w) => w.text))].slice(0, 4);
  const share = noisy.length / words.length;
  const meanTooLow = result.confidence !== null && result.confidence < POOR_MEAN_CONFIDENCE;
  const quoted = examples.map((t) => `“${t}”`).join(", ");

  if (meanTooLow || share >= POOR_NOISE_SHARE) {
    return {
      level: "poor", noisyWordCount: noisy.length, wordCount: words.length, examples,
      message:
        "Poor photo quality: the text reader couldn't read this photo reliably " +
        `(${noisy.length} of ${words.length} words unclear${quoted ? `, e.g. ${quoted}` : ""}), so the photo text below is probably wrong. ` +
        "Delete anything you can't see in the photo, or type the text yourself. A sharper, brighter, straight-on photo reads better.",
    };
  }
  if (noisy.length > 0) {
    return {
      level: "noisy", noisyWordCount: noisy.length, wordCount: words.length, examples,
      message:
        `Some of the photo couldn't be read clearly (${noisy.length} of ${words.length} words${quoted ? `: ${quoted}` : ""}). ` +
        "This happens with blurry, dark, small or stylized lettering. Delete or fix anything below that isn't really in the photo.",
    };
  }
  return { level: "clean", noisyWordCount: 0, wordCount: words.length, examples: [], message: null };
}
