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
//   "3" Approved history: AnalyzeRequest.includeHistory,
//       AnalyzeResponse.historyUsed, /api/history routes,
//       HealthResponse.history, USER_ID_HEADER.
export const CONTRACT_VERSION = "3" as const;

/**
 * HTTP header carrying the extension's random user id (one per install).
 * History is stored and looked up per user id. It is a pseudonymous label,
 * NOT a password: the backend only listens on 127.0.0.1, so it separates
 * users of one backend; it does not authenticate them.
 * Format: 8-64 characters of A-Z a-z 0-9 _ -
 */
export const USER_ID_HEADER = "X-Second-Look-User";
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

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
  /**
   * The DRAFT only: "caption" and "image_text" sources. "history" sources are
   * added by the backend from approved, stored history (never sent here).
   */
  sources: TextSource[];
  /**
   * true = also compare the draft with this user's approved earlier posts.
   * Needs the USER_ID_HEADER. Default false.
   */
  includeHistory?: boolean;
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
  /**
   * Earlier posts the backend added to this analysis (empty if none).
   * Evidence with sourceId "history:<postId>" refers to these.
   */
  historyUsed: Array<{ sourceId: string; postId: string; publishedAt: string }>;
}

export type ErrorCode =
  | "BAD_REQUEST"        // the extension sent something invalid
  | "FORBIDDEN"          // request came from an unexpected origin
  | "UPSTREAM_ERROR"     // Databricks returned an error
  | "UPSTREAM_AUTH"      // Databricks rejected our credentials (bad/expired token, or a login redirect)
  | "NOT_FOUND"          // e.g. that history post doesn't exist for this user
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

/**
 * Where approved history is kept.
 *  - "dev-memory":     TEMPORARY development storage in the backend's memory.
 *                      Lost on restart. Not Databricks.
 *  - "databricks-app": stored by the Databricks App (unverified until tested).
 */
export type HistoryStoreKind = "dev-memory" | "databricks-app";

// GET /api/health
export interface HealthResponse {
  ok: true;
  mode: AnalysisMode;
  contractVersion: typeof CONTRACT_VERSION;
  databricks: DatabricksStatus;
  history: { store: HistoryStoreKind };
}

// ---------------------------------------------------------------------------
// History (milestone 3): only earlier posts the user explicitly approved.
// Every /api/history request needs the USER_ID_HEADER; users never see each
// other's history.
//
//   POST   /api/history/import                       HistoryImportRequest -> HistoryImportResponse
//   GET    /api/history                              -> HistoryListResponse
//   DELETE /api/history/posts/:postId                -> HistoryDeleteResponse
//   POST   /api/history/approvals/:approvalId/revoke -> HistoryDeleteResponse
//   DELETE /api/history                              -> HistoryDeleteResponse  ("delete all my history")
// ---------------------------------------------------------------------------

export const HISTORY_LIMITS = {
  maxPostsPerImport: 50,
  maxPostsPerUser: 500,
  maxCharsPerPost: 5000,
  /** At most this many earlier posts are added to one analysis. */
  maxPostsPerAnalysis: 8,
} as const;

/**
 * OBSERVED data: one earlier post, as the user approved it.
 * Only PUBLISHED posts can be imported; drafts are never stored as history.
 */
export interface HistoryPost {
  /** Becomes the TextSource id "history:<postId>". Format: A-Z a-z 0-9 _ . - (1-80). */
  postId: string;
  status: "published";
  /** ISO 8601 date the post was published. */
  publishedAt: string;
  caption: string;
  /** Text read from the post's image (OCR). Never the image itself. */
  imageText?: string;
}

export interface HistoryImportRequest {
  contractVersion: typeof CONTRACT_VERSION;
  /**
   * The user's explicit approval. `approved` must be true and `postIds`
   * must list exactly the posts being imported.
   */
  approval: { approved: true; postIds: string[] };
  posts: HistoryPost[];
}

export interface HistoryImportResponse {
  contractVersion: typeof CONTRACT_VERSION;
  /** Use this to revoke the approval (deletes these posts and anything derived from them). */
  approvalId: string;
  imported: number;
  store: HistoryStoreKind;
}

export interface StoredHistoryPost extends HistoryPost {
  approvalId: string;
  importedAt: string;
}

export interface HistoryListResponse {
  contractVersion: typeof CONTRACT_VERSION;
  store: HistoryStoreKind;
  posts: StoredHistoryPost[];
}

export interface HistoryDeleteResponse {
  contractVersion: typeof CONTRACT_VERSION;
  /** Observed posts deleted. */
  deletedPosts: number;
  /** AI interpretations deleted along with them. */
  deletedInterpretations: number;
}
