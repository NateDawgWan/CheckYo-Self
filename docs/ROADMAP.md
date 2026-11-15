# Roadmap

Who owns each milestone, and the planned interfaces between them, are in [TEAM.md](TEAM.md).

## Milestone 2: local OCR

- Run OCR in the extension with Tesseract.js. Manifest V3 forbids remotely hosted code, so bundle its worker, WASM core and English language data inside the extension instead of loading them from a CDN.
- OCR output becomes a `TextSource` with `id: "image_text:<n>"` (one per carousel image). The image itself never leaves the browser.
- Let the user review and edit OCR text before sending it; OCR errors are common on stylized text.

## Milestone 3: history (manual import first)

1. User picks their own posts to import (start with pasted text or Instagram's "Download your information" export; check the export's real format before parsing it).
2. The import screen lists each post and the user ticks the ones to include. Nothing is imported without that approval.
3. The backend stores them in Databricks (SQL Statement Execution API or a SQL warehouse connection; still credentials on the backend only).

Proposed Delta tables, keeping observed facts and AI interpretations apart:

| Table | Columns | Notes |
|---|---|---|
| `observed_posts` | `user_id`, `source_id`, `posted_at`, `caption`, `image_text`, `imported_at`, `approval_id` | Only what the user approved. No images. |
| `ai_clues` | `clue_id`, `source_id`, `category`, `clue_text`, `evidence_quote`, `confidence`, `model`, `prompt_version`, `created_at` | Derived; can be deleted and regenerated. |
| `history_approvals` | `approval_id`, `user_id`, `approved_at`, `scope`, `revoked_at` | Lets a user revoke and delete. |

Sending history: select the relevant `observed_posts` (start with "the most recent N approved posts"), send them as `history:<source_id>` sources with `date`. The contract already supports this.

Add a "Delete my imported history" action before showing this to anyone else.

## Milestone 4: Instagram integration

- Content script on `https://www.instagram.com/*` that detects the share step, offers "Check first" or "Share without checking", reads the caption field, and runs OCR on the selected image.
- Content scripts are subject to the page's CORS rules, so route backend calls through the extension's service worker (`chrome.runtime.sendMessage`) rather than calling `fetch` from the content script.
- Re-hash the draft on every caption change; reuse the stale-results logic from the popup.
- Add to history only after publication is confirmed.

## Unverified assumptions about Instagram's posting workflow

None of these have been checked against the live site. Verify each one before building on it, and expect Instagram to change its UI without notice.

1. Desktop instagram.com lets you create photo posts through a "Create" dialog with steps roughly like select, crop, edit, caption, then a "Share" button.
2. The caption box can be found reliably. Class names on Instagram are generated and change often, so selectors should rely on roles, `aria-label`s or structure, and these may be localized.
3. The caption is an editable element whose current text can be read, and changes to it fire events a content script can observe.
4. The selected image is reachable from the page (for example as a `blob:` URL, `<img>` or `<canvas>`) at the caption step, for local OCR, and reflects crops and filters.
5. A content script can intercept the "Share" click before the post is sent, show its own choice, and then let the original action proceed. React's event handling may make this unreliable; a fallback is a "Check this post" button placed next to Share rather than blocking it.
6. Successful publication shows a recognizable confirmation (for example a "post shared" message) that a content script can detect, and failed or cancelled shares can be told apart from successful ones.
7. The new post's ID, URL or timestamp is available after publishing, to use as a `source_id` and date.
8. Multi-image (carousel) posts, video posts, and posts that Instagram converts to Reels follow the same flow, or will need separate handling.
9. Instagram's "Download your information" export includes captions and timestamps in a stable, parseable format.
10. Automating or reading Instagram's UI this way fits Instagram's terms for a personal, user-initiated tool. Read the terms before demoing; avoid any automated scraping of other accounts.
