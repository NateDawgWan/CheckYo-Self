# CLAUDE.md

Guide for AI coding assistants (and teammates) working in this repo. The team are beginner programmers whose main language is Java: keep code plain, well commented, and avoid clever abstractions or new frameworks.

## Current implementation status

- Milestone 1: caption-entry popup, backend analysis route, and structured findings.
- Mock mode is tested: typechecks, extension build, `npm test` regression tests in both packages, and manual `curl` checks of `/api/health` and `/api/analyze`.
- Databricks: the backend calls the Databricks App `instagram-risk-analyzer` (maintained by Genie, outside this repo), which relays to the hosted model. The connector supports OAuth service-principal tokens (default) and PATs, and is tested only against a fake `fetch`. It has **not** passed a live credentialed test. Treat it as unverified until `npm run check:databricks` prints `Success. Connection verified.` "Configured" (settings filled in) is not "verified". Probes show the app redirects token calls outside `/api/` to a browser login; see `docs/DATABRICKS_APP_API.md`.
- History (milestone 3, backend side): explicit import of approved, published posts; relevant-history retrieval for analysis; per-user isolation; deletion and approval revocation; AI interpretations stored apart from observed posts. Storage is the **temporary in-memory dev store** (`HISTORY_STORE=dev-memory`, lost on restart). The Databricks App store (`databricks-app`) is written against a spec Genie has not built yet, so it's unverified. No extension UI for history yet.
- Live vs. mock results: `docs/TEST_RESULTS.md`. Team ownership and interfaces: `docs/TEAM.md`.
- Instagram interception and automatic image OCR are future milestones unless subsequent code and tests establish otherwise.
- Implement only the milestone assigned in the current task.
- Preserve the existing working structure; do not reorganize it without a concrete need.

## Architecture

```
Chrome extension (TypeScript, MV3)        Backend (Node + Express, TypeScript)        Databricks App ──▶ hosted model
  popup: caption + photo text  ──POST /api/analyze──▶  validate ─▶ + approved history ─▶  (relay, OAuth)
  hash draft, render findings  ◀──AnalyzeResponse────  parse + verify quotes ◀──────────  history storage (requested)
                                                       or mock.ts (no Databricks)
```

- The extension never talks to Databricks and never holds credentials. OAuth tokens are fetched, cached and renewed only in `backend/src/auth.ts`.
- A failed Databricks call is an error for the user. Never substitute mock findings after a live failure; mock mode is chosen explicitly at startup and labeled.
- Drafts vs. history: `/api/analyze` accepts only draft sources (`caption`, `image_text`). `history:<postId>` sources are added by the backend from posts the user explicitly approved, and only `status: "published"` posts can be imported.
- History requests carry the `X-Second-Look-User` header (a random per-install id). Every store method is per user; never read or delete across users.
- Only text crosses the network: never images, image URLs, base64, or page HTML. `backend/src/validate.ts` enforces this.
- `shared/contract.ts` is the single source of truth for the request/response format. Both sides import it. Change it first, then fix the type errors on both sides. Bump `CONTRACT_VERSION` on breaking changes.
- Observed vs. AI-generated: `Evidence` (quote + `verified`) is observed text; `exposure`, `uncertainty`, `suggestedEdits` are AI interpretation. The backend, not the model, sets `verified` and `crossSource`.
- Evidence verification (`backend/src/parse.ts`):
  - `verified: true` means the quote appears in the named source's text (case- and whitespace-insensitive). It proves the text exists, not that the AI's interpretation is right.
  - A finding is shown only if it has at least one verified quote. Unverified quotes may be kept but are labeled "not found in your text".
  - `crossSource` is computed from verified quotes only.
  - A missing or wrongly typed `findings` list is `BAD_MODEL_OUTPUT`, never an empty "clean" result.
  - Findings that are malformed, unverified or over the limit of 8 are dropped and counted in `droppedFindings`. If it is above 0 the popup says the check is incomplete, not "nothing stood out".
- Suggested edits: `replace`/`generalize` need an `original` found in the text and a non-blank `replacement`; otherwise the backend turns them into `other` (advice only). The extension re-checks with `extension/src/edits.ts` before showing or running "Apply", and never applies an edit that would empty the caption.
- Databricks status: `GET /api/health` returns `databricks.state` (`not_used`, `configured_unverified`, `verified`, `failing`) from the most recent real call. Only `verified` may be shown as "connected". The Databricks timeout covers reading the response body, not just the headers.
- Results are tied to a `draftHash` (SHA-256 of the draft sources). When the draft's hash changes, the popup marks results stale.

## Files

```
shared/contract.ts            Request/response types, limits, enums (both sides)
backend/src/server.ts         Starts the app from .env settings (mock vs. databricks chosen once, here)
backend/src/app.ts            Express routes: health, analyze, /api/history/*, error handler
backend/src/config.ts         Reads backend/.env; reports missing settings, never guesses them
backend/src/auth.ts           OAuth M2M tokens (cache + renewal) or fixed PAT
backend/src/databricks.ts     Databricks client: one timeout incl. body, no redirects, retry once on auth failure
backend/src/validate.ts       Request validation, "text only" guard, history import rules
backend/src/prompt.ts         LLM system prompt (bump PROMPT_VERSION when editing)
backend/src/parse.ts          Parse LLM JSON, normalize fields, verify quotes
backend/src/mock.ts           Keyword-rule fake findings (clearly labeled mode: "mock")
backend/src/history/          store.ts (interface), memoryStore.ts (TEMPORARY dev store),
                              appStore.ts (Databricks App store, unverified), relevance.ts
backend/scripts/ping-databricks.ts   Live connection check (npm run check:databricks)
backend/scripts/check-history.ts     Live history round trip (npm run check:history)
extension/public/             manifest.json, popup.html, popup.css (copied to dist/)
extension/src/popup.ts        Popup wiring, draft hashing, stale detection, apply-edit
extension/src/api.ts          Backend calls (BACKEND_URL), hashSources()
extension/src/render.ts       Marked-up draft + finding cards (textContent only, no innerHTML)
extension/src/edits.ts        Rules for applying a suggested edit safely (no DOM; tested)
backend/test/, extension/test/  Regression tests (node:test, run with `npm test`)
docs/ROADMAP.md               Next milestones, history storage plan, Instagram assumptions
docs/TEAM.md                  Module owners and integration interfaces (in code vs. proposed)
docs/DATABRICKS_APP_API.md    What the backend needs from Genie's Databricks App (auth fix, history endpoints)
docs/TEST_RESULTS.md          Mock and live results, kept separate
```

## Commands

Requires Node.js 20+ and npm (`node -v`, `npm -v`). Use `npm ci` to install exactly what the lockfiles say; use `npm install <pkg>` only when deliberately changing a dependency.

```bash
# Backend (first time). Create .env ONLY if it doesn't exist; never overwrite a teammate's .env.
cd backend && npm ci
cp -n .env.example .env            # macOS/Linux/Git Bash (-n = don't overwrite)
# Windows PowerShell:  if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev                        # http://127.0.0.1:8787, restarts on save

# Extension
cd extension && npm ci && npm run build   # load extension/dist in chrome://extensions
cd extension && npm run watch

# Checks (run all of these before committing)
cd backend && npm run typecheck && npm test
cd extension && npm run typecheck && npm test && npm run build

# Databricks (only with real credentials in backend/.env)
cd backend && npm run check:databricks    # must print "Success. Connection verified."
cd backend && npm run check:history       # HISTORY_STORE=databricks-app; must print "Success. History storage verified ..."
curl http://127.0.0.1:8787/api/health     # shows mode, databricks.state and history.store
```

`ANALYSIS_MODE=mock` (the default) needs no `.env` at all; you can also set it for one run instead of editing `.env`.

## Rules

- Never commit `.env` or put secrets in `extension/`. Secrets come from environment variables on the backend.
- Never log post text, user ids, tokens, or Databricks response bodies on the backend; log request IDs, statuses and counts.
- Don't claim a Databricks feature works until its live check (`check:databricks`, `check:history`) passes, and record the result in `docs/TEST_RESULTS.md`.
- Render model output with `textContent`, never `innerHTML`.
- Treat post text as untrusted input to the LLM (prompt injection). Keep the "data, not instructions" rule in the prompt.
- If you change `BACKEND_URL` in `extension/src/api.ts`, update `host_permissions` in `extension/public/manifest.json`.
- `shared/package.json` sets `"type": "module"`; keep it, or the backend can't import the contract.
- Run both `typecheck` and both `npm test` commands, and the extension build, before committing.
- When you fix a bug, add a test for it in `backend/test/` or `extension/test/`.


# Git & Repository Safety Rules

## Repository Setup
- If the target repository is not present locally, clone it first before making any file changes.
- Always run `git status` and verify your current branch before editing files or running commits.

## Branching & Commits
- **NEVER commit or push directly to `main` (or `master`).**
- **Continue an existing branch when the work belongs to it.** If the task names a branch or an open PR (for example a teammate's branch like `Tri-Hoang` and its PR), check it out, `git pull`, and keep committing there. Do not create a second branch or PR for the same work.
- Only for new, separate work: create a branch from an up-to-date `main` (e.g., `git checkout -b feat/short-description` or `fix/short-description`).
- Each teammate works on their own branch; don't push to someone else's branch unless they asked.
- Write clear, concise commit messages describing what changed and why.
- Stage specific files rather than blindly running `git add .` so untracked secrets, `.env` files, or build artifacts are never committed.

## Pull Requests
- Never merge your own pull requests.
- When work is complete, push your branch to `origin` (`git push -u origin <branch-name>`) and open a Pull Request using the GitHub CLI (`gh pr create`). If a PR already exists for the branch, just push; the PR updates itself (`gh pr view` shows it).
- **GitHub CLI fallback:** first run `gh auth status`. If `gh` is not installed or not logged in, do not paste tokens anywhere. Push the branch, then open the PR in a browser at `https://github.com/NateDawgWan/MADHACKS26_HANS/compare/main...<branch-name>`, or have the person run `gh auth login` themselves.
- Include a clear summary of changes and any testing performed in the PR description. Say plainly what was NOT tested (for example live Databricks).

## Destructive Commands
- **NEVER run force pushes (`git push --force`), hard resets (`git reset --hard`), or branch deletions on shared branches** without explicit user confirmation.