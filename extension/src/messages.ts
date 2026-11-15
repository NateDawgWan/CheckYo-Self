// Checks Chrome messages before the service worker acts on them.
// No DOM and no Chrome calls here, so it can be tested in Node
// (see test/messages.test.ts).
//
// Why check at all? The content script runs on instagram.com. If the page
// ever confused it, we still want the worker to send ONLY plain text to our
// backend: never images, image URLs, blob: URLs or base64 data. The backend
// checks this too (backend/src/validate.ts); this is a second, earlier check.
import { LIMITS, type ExtensionMessage, type SourceType, type TextSource } from "../../shared/contract";

const SOURCE_TYPES: SourceType[] = ["caption", "image_text", "history"];
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// Same idea as backend/src/validate.ts, plus blob: URLs (which only exist in the browser).
const IMAGE_DATA_URL = /data:image\//i;
const BLOB_URL = /blob:https?:\/\//i;
const LONG_BASE64_RUN = /[A-Za-z0-9+/=]{400,}/;
const INSTAGRAM_MEDIA_URL = /https?:\/\/\S*(cdninstagram\.com|fbcdn\.net)/i;

/** Returns why a piece of text is not allowed to leave the browser, or null if it is fine. */
export function nonTextProblem(text: string): string | null {
  if (IMAGE_DATA_URL.test(text) || LONG_BASE64_RUN.test(text)) return "looks like image data";
  if (BLOB_URL.test(text)) return "contains a browser image link (blob:)";
  if (INSTAGRAM_MEDIA_URL.test(text)) return "contains an Instagram image URL";
  return null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copies only the allowed fields of a source, after checking each one. */
function parseSource(raw: unknown, i: number): Parsed<TextSource> {
  if (!isPlainObject(raw)) return { ok: false, reason: `sources[${i}] is not an object.` };
  const { id, type, text } = raw;
  if (typeof id !== "string" || typeof text !== "string") {
    return { ok: false, reason: `sources[${i}] needs a text id and text.` };
  }
  if (!SOURCE_TYPES.includes(type as SourceType) || !id.startsWith(type as string)) {
    return { ok: false, reason: `sources[${i}] has an unknown type.` };
  }
  if (text.length > LIMITS.maxCharsPerSource) return { ok: false, reason: `sources[${i}] is too long.` };
  const problem = nonTextProblem(text);
  if (problem) return { ok: false, reason: `sources[${i}] ${problem}. Only text can be checked.` };
  // Build a fresh object so extra fields (for example an image) are dropped.
  return { ok: true, value: { id, type: type as SourceType, text } };
}

/**
 * Checks a message that claims to be an ExtensionMessage.
 * Returns a clean copy with only the expected fields.
 */
export function parseExtensionMessage(raw: unknown): Parsed<ExtensionMessage> {
  if (!isPlainObject(raw)) return { ok: false, reason: "Message is not an object." };

  switch (raw.kind) {
    case "check-draft": {
      const { requestId, draftHash, sources } = raw;
      if (typeof requestId !== "number" || !Number.isInteger(requestId)) {
        return { ok: false, reason: "requestId must be a whole number." };
      }
      if (typeof draftHash !== "string" || !HASH_PATTERN.test(draftHash)) {
        return { ok: false, reason: "draftHash must be a SHA-256 hex string." };
      }
      if (!Array.isArray(sources) || sources.length === 0 || sources.length > LIMITS.maxSources) {
        return { ok: false, reason: "sources must be a non-empty list." };
      }
      const clean: TextSource[] = [];
      for (let i = 0; i < sources.length; i++) {
        const parsed = parseSource(sources[i], i);
        if (!parsed.ok) return parsed;
        clean.push(parsed.value);
      }
      return { ok: true, value: { kind: "check-draft", requestId, draftHash, sources: clean } };
    }

    case "post-published": {
      const { draftHash, postId, publishedAt } = raw;
      if (typeof draftHash !== "string" || !HASH_PATTERN.test(draftHash)) {
        return { ok: false, reason: "draftHash must be a SHA-256 hex string." };
      }
      if (postId !== null && (typeof postId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(postId))) {
        return { ok: false, reason: "postId must be a short id or null." };
      }
      if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) {
        return { ok: false, reason: "publishedAt must be an ISO 8601 date." };
      }
      return { ok: true, value: { kind: "post-published", draftHash, postId, publishedAt } };
    }

    case "get-instagram-draft":
      return { ok: true, value: { kind: "get-instagram-draft" } };

    default:
      return { ok: false, reason: "Unknown message kind." };
  }
}
