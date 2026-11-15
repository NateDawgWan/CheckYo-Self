// =============================================================================
// shared/contract.ts — THE request/response format between extension & backend.
//
// Both the extension and the backend import this file, so if you change a type
// here, TypeScript will show you every place on both sides that must change.
// Bump CONTRACT_VERSION whenever you make a breaking change.
// =============================================================================

// Version history:
//   "1" milestone 1 import.
//   "2" AnalyzeResponse.droppedFindings, HealthResponse.databricks,
//       verified-evidence rule, validated suggested edits.
export const CONTRACT_VERSION = "2" as const;

/** Size limits. The backend rejects anything bigger. */
export const LIMITS = {
  maxSources: 50,
  maxCharsPerSource: 5000,
  maxTotalChars: 40000,
} as const;

// ---------------------------------------------------------------------------
// Request: extension -> backend   (POST /api/analyze)
// ---------------------------------------------------------------------------

/**
 * Where a piece of text came from. ONLY text is ever sent — never images,
 * image URLs, base64 data, or page HTML.
 *  - "caption":    the draft caption the user typed
 *  - "image_text": text OCR'd from the draft image, locally (milestone 2)
 *  - "history":    text from a previous post the user approved importing (milestone 3)
 */
export type SourceType = "caption" | "image_text" | "history";

export interface TextSource {
  /**
   * Stable id used to link findings back to text.
   * Format: "caption", "image_text:1", "history:<postId>".
   */
  id: string;
  type: SourceType;
  text: string;
  /** ISO 8601 date the post was published. Only used for "history". */
  date?: string;
}

export interface AnalyzeRequest {
  contractVersion: typeof CONTRACT_VERSION;
  /**
   * SHA-256 (hex) of the draft's sources, computed by the extension.
   * The backend echoes it back so the extension can tell whether a result
   * still matches what's on screen (step 6: invalidate when the draft changes).
   */
  draftHash: string;
  sources: TextSource[];
}

// ---------------------------------------------------------------------------
// Response: backend -> extension
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "location",          // home, neighborhood, frequent places
  "routine_schedule",  // when you're predictably somewhere
  "travel_absence",    // when your home is likely empty
  "children",          // kids' names, schools, teams, ages
  "identity",          // full name, birthday, ID numbers
  "contact",           // phone, email, handles
  "workplace_school",  // employer, school, office
  "financial",
  "health",
  "relationships",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];

export const EDIT_ACTIONS = [
  "replace",            // swap `original` for `replacement`
  "remove",             // delete `original`
  "generalize",         // make `original` vaguer, e.g. "Maple St" -> "home"
  "crop_or_blur_image", // the text is inside the image, so edit the photo
  "other",
] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

/**
 * OBSERVED data: an exact quote from one of the request's sources.
 * `verified` is set by the BACKEND (not the AI): true only if the quote
 * really appears in that source's text. Unverified quotes may be made up.
 */
export interface Evidence {
  sourceId: string;
  quote: string;
  verified: boolean;
}

/**
 * A suggested change. The backend guarantees these rules (and the extension
 * checks them again before showing an "Apply" button):
 *  - "replace" / "generalize": `original` AND a non-blank `replacement` are set.
 *  - "remove": `original` is set; `replacement` is not used.
 *  - "crop_or_blur_image" / "other": advice only, never applied automatically.
 * An edit from the model that breaks these rules is turned into "other"
 * (advice only) so it can never delete text by accident.
 */
export interface SuggestedEdit {
  sourceId: string;
  action: EditAction;
  original?: string;
  replacement?: string;
  explanation: string;
}

/** AI-GENERATED interpretation, linked to observed evidence. */
export interface Finding {
  id: string;                 // "f1", "f2", ... assigned by the backend
  category: Category;
  severity: Level;
  exposure: string;           // what a stranger could learn
  /**
   * At least one entry has verified: true. The backend drops any finding
   * without verified evidence (and counts it in droppedFindings).
   * Unverified entries may still appear, labeled "not found in your text".
   */
  evidence: Evidence[];
  /** true if VERIFIED evidence spans more than one source (backend-computed). */
  crossSource: boolean;
  confidence: Level;
  uncertainty: string;        // why this might be wrong
  suggestedEdits: SuggestedEdit[];
}

export type AnalysisMode = "mock" | "databricks";

export interface AnalyzeResponse {
  contractVersion: typeof CONTRACT_VERSION;
  requestId: string;
  draftHash: string;          // echoed from the request
  mode: AnalysisMode;         // "mock" results are NOT from an AI model
  model: string | null;       // Databricks endpoint name, or null in mock mode
  promptVersion: string | null;
  analyzedAt: string;         // ISO 8601
  summary: string;
  findings: Finding[];
  /**
   * How many findings the model returned that the backend did NOT show,
   * because they were malformed, had no verified evidence, or went over the
   * limit of 8. If this is > 0 the check is INCOMPLETE: the extension must
   * not present it as "nothing stood out".
   */
  droppedFindings: number;
}

export type ErrorCode =
  | "BAD_REQUEST"        // the extension sent something invalid
  | "FORBIDDEN"          // request came from an unexpected origin
  | "UPSTREAM_ERROR"     // Databricks returned an error
  | "UPSTREAM_TIMEOUT"   // Databricks took too long
  | "BAD_MODEL_OUTPUT"   // the LLM's answer wasn't valid JSON
  | "INTERNAL";

export interface ErrorResponse {
  contractVersion: typeof CONTRACT_VERSION;
  error: { code: ErrorCode; message: string; requestId?: string };
}

/**
 * What the backend knows about its Databricks connection. "Configured" only
 * means the settings are filled in; it is NOT proof that they work.
 *  - "not_used":              mock mode, Databricks is not called.
 *  - "configured_unverified": settings present, no call has succeeded yet.
 *  - "verified":              the most recent Databricks call succeeded.
 *  - "failing":               the most recent Databricks call failed.
 */
export type DatabricksState = "not_used" | "configured_unverified" | "verified" | "failing";

export interface DatabricksStatus {
  state: DatabricksState;
  /** ISO 8601 time of the most recent call, or null if none yet. */
  lastCallAt: string | null;
  /** Short, credential-free error message from the most recent failed call. */
  lastError: string | null;
}

// GET /api/health
export interface HealthResponse {
  ok: true;
  mode: AnalysisMode;
  contractVersion: typeof CONTRACT_VERSION;
  databricks: DatabricksStatus;
}

// ---------------------------------------------------------------------------
// PROPOSED interfaces (docs/TEAM.md, interfaces B and D). Added so the warning
// interface can be built against them. Nothing below crosses the network yet,
// and no backend or OCR code produces these types yet. Additive only, so
// CONTRACT_VERSION is unchanged.
// ---------------------------------------------------------------------------

/**
 * One word the OCR engine found, with its box in the ORIGINAL image's pixels
 * (Tesseract.js reports words in this shape). Used only by the popup to draw
 * highlights on a local preview of the photo. Never sent to the backend.
 */
export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Interface B: what local OCR produces for one image (milestone 2). */
export interface OcrResult {
  sourceId: string;   // "image_text:<index>"
  text: string;       // the user can edit this before checking
  confidence: number; // 0-100 from the OCR engine, shown as a hint
  /** Optional word boxes, for highlighting evidence on the photo preview. */
  words?: OcrWord[];
}

/** Interface D: one earlier post the user may approve importing (milestone 3). */
export interface HistoryPost {
  postId: string;      // becomes TextSource id "history:<postId>"
  postedAt: string;    // ISO 8601
  caption: string;
  imageText?: string;  // OCR text only, never the image
}

/** Interface D (proposed): POST /api/history/import. Not implemented on the backend. */
export interface HistoryImportRequest {
  contractVersion: typeof CONTRACT_VERSION;
  approvalId: string;  // the user's explicit approval for exactly these posts
  posts: HistoryPost[];
}
