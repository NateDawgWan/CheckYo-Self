// Checks that a request body matches AnalyzeRequest before we use it.
// It also enforces our privacy rule: ONLY text goes to Databricks — no images,
// image URLs, base64 blobs, or unknown extra fields.
import {
  CONTRACT_VERSION,
  LIMITS,
  type AnalyzeRequest,
  type SourceType,
  type TextSource,
} from "../../shared/contract";
import { AppError } from "./errors";

const SOURCE_TYPES: SourceType[] = ["caption", "image_text", "history"];
const ID_PATTERN = /^(caption|image_text(:[A-Za-z0-9_.-]{1,80})?|history:[A-Za-z0-9_.-]{1,80})$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// Things that look like images or image links. We refuse them outright.
const IMAGE_DATA_URL = /data:image\//i;
const LONG_BASE64_RUN = /[A-Za-z0-9+/=]{400,}/;
const INSTAGRAM_MEDIA_URL = /https?:\/\/\S*(cdninstagram\.com|fbcdn\.net)/i;

function fail(message: string): never {
  throw new AppError("BAD_REQUEST", 400, message);
}

function checkOnlyKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`Unexpected field "${key}" in ${where}.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAnalyzeRequest(body: unknown): AnalyzeRequest {
  if (!isPlainObject(body)) fail("Body must be a JSON object.");
  checkOnlyKeys(body, ["contractVersion", "draftHash", "sources"], "request");

  if (body.contractVersion !== CONTRACT_VERSION) {
    fail(`contractVersion must be "${CONTRACT_VERSION}". Rebuild the extension and restart the backend.`);
  }
  if (typeof body.draftHash !== "string" || !HASH_PATTERN.test(body.draftHash)) {
    fail("draftHash must be a 64-character lowercase hex SHA-256.");
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    fail("sources must be a non-empty array.");
  }
  if (body.sources.length > LIMITS.maxSources) {
    fail(`Too many sources (max ${LIMITS.maxSources}).`);
  }

  const seenIds = new Set<string>();
  let totalChars = 0;
  const sources: TextSource[] = body.sources.map((raw, i) => {
    const where = `sources[${i}]`;
    if (!isPlainObject(raw)) fail(`${where} must be an object.`);
    checkOnlyKeys(raw, ["id", "type", "text", "date"], where);

    const { id, type, text, date } = raw;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) fail(`${where}.id is not a valid source id.`);
    if (seenIds.has(id)) fail(`Duplicate source id "${id}".`);
    seenIds.add(id);

    if (!SOURCE_TYPES.includes(type as SourceType)) fail(`${where}.type must be one of ${SOURCE_TYPES.join(", ")}.`);
    if (!id.startsWith(type as string)) fail(`${where}.id must start with its type ("${type}").`);

    if (typeof text !== "string") fail(`${where}.text must be a string.`);
    if (text.length > LIMITS.maxCharsPerSource) fail(`${where}.text is too long (max ${LIMITS.maxCharsPerSource}).`);
    if (IMAGE_DATA_URL.test(text) || LONG_BASE64_RUN.test(text)) fail(`${where}.text looks like image data. Send text only.`);
    if (INSTAGRAM_MEDIA_URL.test(text)) fail(`${where}.text contains an image URL. Send text only.`);
    totalChars += text.length;

    if (date !== undefined && (typeof date !== "string" || Number.isNaN(Date.parse(date)))) {
      fail(`${where}.date must be an ISO 8601 date string.`);
    }

    const source: TextSource = { id, type: type as SourceType, text };
    if (typeof date === "string") source.date = date;
    return source;
  });

  if (totalChars > LIMITS.maxTotalChars) fail(`Request text too long (max ${LIMITS.maxTotalChars} chars total).`);
  if (!sources.some((s) => s.text.trim().length > 0)) fail("All sources are empty. Type a caption first.");

  return { contractVersion: CONTRACT_VERSION, draftHash: body.draftHash, sources };
}
