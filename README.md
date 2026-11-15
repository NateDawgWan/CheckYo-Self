# Second Look

A Chrome extension that shows what an Instagram post could reveal about you before you share it, including things that only become revealing when combined with your earlier posts. Built for MadHacks 2026.

**Status: milestone 1.** The popup sends a caption (and optional, hand-typed photo text) to a small local backend, which asks a Databricks-hosted LLM for structured privacy findings and shows them, linked to the exact text they're based on. OCR, post history and Instagram integration come next (see [docs/ROADMAP.md](docs/ROADMAP.md)).

## What you need

- Node.js 20 or newer (`node -v`)
- Google Chrome
- For real AI results: a Databricks workspace with a chat model serving endpoint and a personal access token. Without these, the backend runs in **practice (mock) mode**.

## Setup

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env        # Windows (PowerShell): copy .env.example .env
npm run dev                 # starts http://127.0.0.1:8787 and restarts on save

# 2. Extension (in a second terminal)
cd extension
npm install
npm run build               # or: npm run watch
```

Load the extension in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/dist` folder.
3. Pin "Second Look" from the puzzle-piece menu and click it.
4. Click **Use sample post**, then **Check this post**.

After changing extension code, rebuild (or leave `npm run watch` running) and click the reload icon on the extension's card in `chrome://extensions`.

Tip: the popup closes when you click elsewhere. While developing, open it in a normal tab instead: `chrome-extension://<your-extension-id>/popup.html` (the ID is on its card in `chrome://extensions`). You can then right-click and Inspect it like any page.

## Practice (mock) mode vs. real Databricks

`ANALYSIS_MODE=mock` (the default) returns findings from simple keyword rules in `backend/src/mock.ts`. **These are not AI results.** The popup shows a "Practice mode" label and a purple banner whenever results are mocked.

To turn on real analysis:

1. In Databricks, open the **Serving** page and copy the name of a chat model endpoint (for example a Foundation Model API endpoint; names and availability vary by workspace and region, so use whatever your workspace lists).
2. Create a personal access token in your Databricks user settings (Developer section).
3. Edit `backend/.env`:
   ```
   ANALYSIS_MODE=databricks
   DATABRICKS_HOST=https://<your-workspace>.cloud.databricks.com
   DATABRICKS_TOKEN=<your token>
   DATABRICKS_SERVING_ENDPOINT=<endpoint name>
   ```
4. Test the connection: `npm run check:databricks` (in `backend/`). It should print `Success.`
5. Restart `npm run dev`. The popup's label changes to "Databricks connected".

If `check:databricks` fails: HTTP 401/403 means a bad or expired token; 404 means the host or endpoint name is wrong.

## Keeping secrets safe

- Databricks credentials live **only** in `backend/.env`, which `.gitignore` excludes. Never put them in the extension: anyone can read an extension's code.
- Each teammate creates their own `backend/.env` (or you share it privately, not through GitHub or Slack).
- If a token is ever committed, revoke it in Databricks immediately; deleting the commit is not enough.
- The backend listens on `127.0.0.1` only, so others on the hackathon Wi-Fi can't use it. Optionally set `ALLOWED_EXTENSION_ID` so it only answers your extension.

## What gets sent where

| Data | Stays in the browser | Sent to backend and Databricks |
|---|---|---|
| Photo, image URLs, base64 image data | Yes | **Never** (the backend rejects these) |
| Caption text | | Yes, when you click "Check this post" |
| Text in the photo (typed now, OCR'd locally later) | | Yes, same |
| Earlier posts (milestone 3) | | Only posts you approved importing |

The backend logs request IDs and counts, not post text.

## Commands

| Where | Command | What it does |
|---|---|---|
| backend | `npm run dev` | Run the server, restart on save |
| backend | `npm run typecheck` | Check types without running |
| backend | `npm run check:databricks` | Test Databricks credentials |
| extension | `npm run build` | Build into `extension/dist` |
| extension | `npm run watch` | Rebuild on save |
| extension | `npm run typecheck` | Check types |

## Project layout

See [CLAUDE.md](CLAUDE.md) for the architecture and file-by-file overview.
