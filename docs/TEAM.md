# Team setup: who owns what, and how the pieces connect

Four teammates, four areas. Each area has one **owner** who reviews changes to it. Anyone may help, but talk to the owner first.

Put names next to the roles when you assign them:

| # | Area | Owner | Main folders and files | Milestone |
|---|---|---|---|---|
| 1 | Backend and Databricks (analysis, prompt, later history storage) | _name_ | `backend/` | 1 (done), 3 (history storage) |
| 2 | Warning interface (popup, results, Apply) | _name_ | `extension/src/popup.ts`, `render.ts`, `edits.ts`, `extension/public/` | 1 (done), polish |
| 3 | OCR (text from the photo, on the user's computer) | _name_ | new `extension/src/ocr/` | 2 |
| 4 | Instagram integration (content script, service worker) | _name_ | new `extension/src/content/`, `extension/src/background.ts` | 4 |

**Shared, owned by everyone:** `shared/contract.ts`. Changes to it need a quick OK from whoever's code uses the changed type (usually owners 1 and 2).

## Ground rules for working in parallel

1. **One contract.** Every type that crosses a boundary (extension ↔ backend over HTTP, or content script ↔ service worker ↔ popup over Chrome messages) lives in `shared/contract.ts`. No copies of these types anywhere else.
2. **Contract first.** To change a boundary: edit `shared/contract.ts`, bump `CONTRACT_VERSION` if old code would break, then fix the type errors on both sides in the same pull request.
3. **Only text crosses the network.** Images, image URLs, base64 and page HTML stay in the browser. `backend/src/validate.ts` enforces this; don't loosen it.
4. **Your own branch.** Each teammate works on their own branch and opens a pull request into `main`. Continue an existing branch/PR for the same work instead of starting a new one. Nobody merges their own PR.
5. **Before every push:** `npm run typecheck` and `npm test` in both `backend/` and `extension/`, and `npm run build` in `extension/`.

## The interfaces between areas

Status key: **in code** = exists today; **proposed** = planned shape, not written yet. When you build a proposed interface, add its types to `shared/contract.ts` first, then update this table.

### A. Extension → backend: analysis (owners 1 and 2) — **in code**

```
POST /api/analyze   AnalyzeRequest  -> AnalyzeResponse | ErrorResponse
GET  /api/health                    -> HealthResponse
```

What each side can rely on (see the comments in `shared/contract.ts`):

- Every shown `Finding` has at least one evidence quote with `verified: true` (the backend checked it really appears in the text). Unverified quotes may also appear and must be labeled as such.
- `crossSource` is computed by the backend from verified evidence only.
- `droppedFindings > 0` means the check is **incomplete**. The UI must not show "nothing stood out" in that case.
- A malformed model answer is an error (`BAD_MODEL_OUTPUT`), never an empty result.
- `SuggestedEdit` with `replace` / `generalize` always has non-blank `replacement`; edits that break the rules arrive as `other` (advice only). The extension still re-checks with `extension/src/edits.ts` before applying.
- `HealthResponse.databricks.state` is `"verified"` only after a real call succeeded. Settings alone give `"configured_unverified"`.

### B. OCR → warning interface (owners 3 and 2) — **proposed**, milestone 2

OCR runs inside the extension and produces ordinary `TextSource` objects, so the backend needs no change.

```ts
// extension/src/ocr/index.ts (proposed)
// Reads text from one image on the user's computer. Never uploads the image.
export async function readImageText(image: Blob, index: number): Promise<OcrResult>;

// Proposed new type in shared/contract.ts
export interface OcrResult {
  sourceId: string;   // "image_text:<index>"
  text: string;       // the user can edit this before checking
  confidence: number; // 0-100 from the OCR engine, shown as a hint
}
```

- The popup shows the OCR text in the existing "Text in the photo" box for the user to correct, then sends it as `{ id: "image_text:<n>", type: "image_text", text }`.
- Manifest V3 forbids remote code: the OCR engine, its WASM and language data must be bundled in `extension/` (see `docs/ROADMAP.md`).

### C. Instagram page → extension (owners 4 and 2) — **proposed**, milestone 4

The content script on instagram.com cannot call the backend directly (page CORS rules), so it sends Chrome messages to the service worker, which calls the backend using the same `api.ts` functions.

```ts
// Proposed new types in shared/contract.ts
export type ExtensionMessage =
  | { kind: "draft-changed"; caption: string; imageCount: number }        // content script -> worker
  | { kind: "check-draft"; sources: TextSource[]; draftHash: string }      // content script -> worker
  | { kind: "check-result"; result: AnalyzeResponse }                      // worker -> content script
  | { kind: "check-error"; message: string }                               // worker -> content script
  | { kind: "post-published"; postId: string | null; publishedAt: string }; // content script -> worker
```

- Reuse `hashSources()` and the stale-results logic; re-hash on every caption change.
- Every Instagram assumption in `docs/ROADMAP.md` is **unverified**. Check each one on the live site before relying on it, and keep a "Check this post" button as a fallback if intercepting Share is unreliable.

### D. History (owners 1 and 4) — **proposed**, milestone 3

Only posts the user explicitly approved. The backend stores them; the extension never holds Databricks credentials.

```
POST   /api/history/import   HistoryImportRequest  -> HistoryImportResponse   (proposed)
GET    /api/history          -> HistoryListResponse                          (proposed)
DELETE /api/history          -> { deleted: number }                          (proposed; "delete my history")
```

```ts
// Proposed new types in shared/contract.ts
export interface HistoryPost {
  postId: string;      // becomes TextSource id "history:<postId>"
  postedAt: string;    // ISO 8601
  caption: string;
  imageText?: string;  // OCR text only, never the image
}
export interface HistoryImportRequest {
  contractVersion: typeof CONTRACT_VERSION;
  approvalId: string;  // the user's explicit approval for exactly these posts
  posts: HistoryPost[];
}
```

- `POST /api/analyze` already accepts `history:<id>` sources with a `date`, so cross-post analysis needs no request change. The backend decides which stored posts to include.
- Planned tables are in `docs/ROADMAP.md` (observed data and AI interpretations kept separate).

### E. Warning interface (owner 2) — **in code**, consumed by everyone

`extension/src/render.ts` → `renderResults(elements, result, sources, onApplyEdit, { stale })` draws any `AnalyzeResponse`. The Instagram overlay (C) should reuse it rather than draw warnings a second way. Rules: `textContent` only (never `innerHTML`), show the "Practice mode" banner for `mode: "mock"`, the incomplete banner for `droppedFindings > 0`, and the stale banner when the draft hash changes. While stale, Apply is disabled.

The whole interface (consent, states, OCR review, history panel) is `createWarningUi(elements, callbacks)` in `extension/src/ui/warning-ui.ts`. Integration code calls its `show*`/`set*` methods and implements `WarningUiCallbacks`:

| Callback | When | What the integration must do |
|---|---|---|
| `onAnalyze(sources)` | user pressed Analyze on the consent step | send **exactly** `sources` (what the user saw) |
| `onContinueWithoutAnalysis()` | user declined | send nothing; let the post continue |
| `onReturnToEditing()` | user went back | send nothing |
| `onApplyEdit(edit, analyzedDraftHash)` | user pressed Apply | refuse if the current draft hash differs; then use `edits.ts` |
| `onOcrTextChange(sourceId, text, included)` | user corrected/excluded photo text | re-hash the draft (staleness) |
| `onApproveHistoryImport(approvalId, posts)` | user approved importing these posts | call the history service (D), then `setHistoryState` |
| `onDeleteHistory()` | user confirmed deleting history | call the history service (D), then `setHistoryState` |

States shown by `show(view)`: `idle`, `loading`, `completed`, `skipped`, `unavailable`, `error` (see `src/ui/state.ts`). The history panel shows approve/delete controls only for `connection: "connected"` or a labeled `"fixture"`. `OcrResult`, `OcrWord` and `HistoryPost` are now in `shared/contract.ts` (types only; no OCR or history code produces them yet). Development fixtures live in `src/ui/fixtures.ts`.

## Not done yet (do not assume these work)

- **Live Databricks** has never been tested with real credentials. Run `npm run check:databricks` (in `backend/`) once someone has them; it must print `Success. Connection verified.`
- OCR, history storage and Instagram integration are not implemented (only planned above).
- The popup has only been checked through its code and automated tests, not by clicking through it in Chrome.
