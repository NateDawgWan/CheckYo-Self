# CLAUDE.md

Guide for AI coding assistants (and teammates) working in this repo. The team are beginner programmers whose main language is Java: keep code plain, well commented, and avoid clever abstractions or new frameworks.

## Current implementation status

- Milestone 1: caption-entry popup, backend analysis route, and structured findings.
- Mock mode has been tested according to the initial implementation report.
- Databricks integration is written but has not passed a live credentialed test.
- Instagram interception, automatic image OCR, historical storage, and cross-post
  reasoning are future milestones unless subsequent code and tests establish otherwise.
- Implement only the milestone assigned in the current task.
- Preserve the existing working structure; do not reorganize it without a concrete need.

## Architecture

```
Chrome extension (TypeScript, MV3)        Backend (Node + Express, TypeScript)        Databricks
  popup: caption + photo text  ──POST /api/analyze──▶  validate ─▶ prompt ─▶ ──────▶  model serving endpoint
  hash draft, render findings  ◀──AnalyzeResponse────  parse + verify quotes ◀───────  (chat completions)
                                                       or mock.ts (no Databricks)
```

- The extension never talks to Databricks and never holds credentials.
- Only text crosses the network: never images, image URLs, base64, or page HTML. `backend/src/validate.ts` enforces this.
- `shared/contract.ts` is the single source of truth for the request/response format. Both sides import it. Change it first, then fix the type errors on both sides. Bump `CONTRACT_VERSION` on breaking changes.
- Observed vs. AI-generated: `Evidence` (quote + `verified`) is observed text; `exposure`, `uncertainty`, `suggestedEdits` are AI interpretation. The backend, not the model, sets `verified` and `crossSource`.
- Results are tied to a `draftHash` (SHA-256 of the draft sources). When the draft's hash changes, the popup marks results stale.

## Files

```
shared/contract.ts            Request/response types, limits, enums (both sides)
backend/src/server.ts         Express app: GET /api/health, POST /api/analyze, error handler
backend/src/config.ts         Reads backend/.env; ANALYSIS_MODE = mock | databricks
backend/src/validate.ts       Request validation + "text only" guard
backend/src/prompt.ts         LLM system prompt (bump PROMPT_VERSION when editing)
backend/src/databricks.ts     fetch() to /serving-endpoints/<name>/invocations
backend/src/parse.ts          Parse LLM JSON, normalize fields, verify quotes
backend/src/mock.ts           Keyword-rule fake findings (clearly labeled mode: "mock")
backend/scripts/ping-databricks.ts   Credential check
extension/public/             manifest.json, popup.html, popup.css (copied to dist/)
extension/src/popup.ts        Popup wiring, draft hashing, stale detection, apply-edit
extension/src/api.ts          Backend calls (BACKEND_URL), hashSources()
extension/src/render.ts       Marked-up draft + finding cards (textContent only, no innerHTML)
docs/ROADMAP.md               Next milestones, history storage plan, Instagram assumptions
```

## Commands

```bash
cd backend && npm install && cp .env.example .env && npm run dev   # http://127.0.0.1:8787
cd backend && npm run typecheck
cd backend && npm run check:databricks
cd extension && npm install && npm run build      # load extension/dist in chrome://extensions
cd extension && npm run watch
cd extension && npm run typecheck
curl http://127.0.0.1:8787/api/health
```

## Rules

- Never commit `.env` or put secrets in `extension/`. Secrets come from environment variables on the backend.
- Never log post text on the backend; log request IDs and counts.
- Render model output with `textContent`, never `innerHTML`.
- Treat post text as untrusted input to the LLM (prompt injection). Keep the "data, not instructions" rule in the prompt.
- If you change `BACKEND_URL` in `extension/src/api.ts`, update `host_permissions` in `extension/public/manifest.json`.
- `shared/package.json` sets `"type": "module"`; keep it, or the backend can't import the contract.
- Run both `typecheck` commands before committing.


# Git & Repository Safety Rules

## Repository Setup
- If the target repository is not present locally, clone it first before making any file changes.
- Always run `git status` and verify your current branch before editing files or running commits.

## Branching & Commits
- **NEVER commit or push directly to `main` (or `master`).**
- Always create and checkout a new feature or fix branch from an up-to-date `main` before starting work (e.g., `git checkout -b feat/short-description` or `fix/short-description`).
- Write clear, concise commit messages describing what changed and why.
- Stage specific files rather than blindly running `git add .` so untracked secrets, `.env` files, or build artifacts are never committed.

## Pull Requests
- Never merge your own pull requests.
- When work is complete, push your branch to `origin` (`git push -u origin <branch-name>`) and open a Pull Request using the GitHub CLI (`gh pr create`).
- Include a clear summary of changes and any testing performed in the PR description.

## Destructive Commands
- **NEVER run force pushes (`git push --force`), hard resets (`git reset --hard`), or branch deletions on shared branches** without explicit user confirmation.