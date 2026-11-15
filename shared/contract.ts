// =============================================================================
// shared/contract.ts — THE request/response format between extension & backend.
//
// Both the extension and the backend import this file, so if you change a type
// here, TypeScript will show you every place on both sides that must change.
// Bump CONTRACT_VERSION whenever you make a breaking change.
// =============================================================================

export const CONTRACT_VERSION = "1" as const;

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
  evidence: Evidence[];       // at least one entry
  crossSource: boolean;       // true if evidence spans >1 source (backend-computed)
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

// GET /api/health
export interface HealthResponse {
  ok: true;
  mode: AnalysisMode;
  contractVersion: typeof CONTRACT_VERSION;
}
