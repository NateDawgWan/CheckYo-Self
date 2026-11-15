# Test results

Mock and live results are kept separate on purpose. A passing mock or fake test says **nothing** about whether Databricks works. Update this file whenever a live check is run.

Last updated: 2026-11-14, branch `Backend-Connection/History`.

## Mock and fake results (no Databricks involved)

| Check | Result |
|---|---|
| `npm run typecheck` (backend, extension) | Pass |
| `npm test` backend | 50/50 pass |
| `npm test` extension | 45/45 pass (includes the OCR module's tests from `main`) |
| `npm run build` (extension) | Pass |

What the backend tests cover, all against a **fake** `fetch` or the in-memory store:

- **Invalid model output:** a missing or wrongly typed `findings` list is `BAD_MODEL_OUTPUT` (parse tests, and through HTTP in `app.test.ts`).
- **Unsupported evidence:** findings without a verified quote are dropped and counted in `droppedFindings`. `crossSource` uses verified quotes only.
- **Service failures:** app statuses 404/413/422/502/504, network errors, non-JSON bodies, empty replies, a body that stalls after the headers (timeout).
- **Auth and token expiry:**
  - an OAuth token is cached, then renewed before it expires;
  - simultaneous requests share one token fetch;
  - a token rejected early is replaced once and the call retried;
  - a second rejection stops with a clear error;
  - a refused token request names the settings to check;
  - a 302 login redirect is an auth error.
- **No mock fallback:** a failed Databricks call returns an error with no findings.
- **History:**
  - only explicitly approved, published posts are imported, and drafts are refused;
  - history can't be smuggled into a draft;
  - users are isolated (list, analysis, delete and revoke);
  - revoking deletes the posts and the AI interpretations derived from them;
  - suggestions rank relevant posts without calling the model;
  - analysis uses exactly the chosen posts, in order, with source ids and dates;
  - unknown, other users', revoked, duplicate or too many post ids are refused before anything is analyzed;
  - a choice over the size limits is refused, never trimmed;
  - the app-store client sends POST requests to `/api/` routes with the user id in the body, and rejects malformed or partial app responses.

Manual mock-mode run (`ANALYSIS_MODE=mock`, `HISTORY_STORE=dev-memory`), using one synthetic post:

- `/api/health` showed `databricks.state: not_used` and `history.store: dev-memory`.
- Import, then analysis with `historyPostIds: ["p1"]` added `history:p1` with its date. A verified quote from it made the finding `crossSource: true`.
- `/api/history/suggest` ranked the post sharing words with the draft first. An unknown post id in `historyPostIds` was refused with 400 before anything was analyzed.
- Revoke deleted the post, and a second user id saw nothing.

## Live results (real Databricks)

| Check | Result |
|---|---|
| Unauthenticated probes of the app | `/` and `/serving-endpoints/...` redirect to the browser login (302). `/api/health` answers 401. |
| `check:databricks`, PAT mode, **fake** token, handoff path | Correctly failed: app answered HTTP 401, reported as `UPSTREAM_AUTH` with the OAuth hint. |
| `check:databricks`, OAuth mode, **fake** client, real workspace | Correctly failed: workspace `/oidc/v1/token` exists and answered 401, reported with the settings to check. |
| `check:databricks` with **real** credentials (service principal `secondlook-backend`, OAuth M2M, `/api/v1/...` route) | **Failed at the app's access gate.** The workspace issued a valid token (scope `all-apis`, workspace audience, correct client ID). The app then answered **HTTP 401 with an empty `{}` body on every route**, including `/` and `/api/health`, with or without a fresh token. Empty-body 401s come from the Databricks gate, not the app's code, so the request never reached Genie's relay. Most likely cause: the service principal lacks **Can Use** on the app. |
| `check:history` against the app | **Not run.** The app has no history endpoints yet. |

**Status:**

- **Live analysis through the Databricks App: UNVERIFIED.**
- **Databricks history persistence: UNVERIFIED and not built on the app side.** Development uses the temporary in-memory store.
