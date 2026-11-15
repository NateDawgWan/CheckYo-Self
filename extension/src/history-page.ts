// The history page (history.html): see, delete and import your past posts.
//
// Import reads Instagram's own data export ON THIS COMPUTER (instagram-export.ts),
// lets you tick which posts to save, optionally reads the text in their
// photos locally (OCR), and sends ONLY the ticked posts' captions and photo
// text to the backend (history-api.ts). Photos never leave the computer.
import { HISTORY_LIMITS, type HistoryPost, type StoredHistoryPost } from "../../shared/contract";
import { checkHealth, describeBackendStatus } from "./api";
import { deleteAllHistory, deleteHistoryPost, importHistory, listHistory } from "./history-api";
import { findPostFiles, joinPhotoTexts, parsePostFiles, type ExportPost } from "./instagram-export";
import { OcrError, readImageText } from "./ocr";
import { describePhotoRead } from "./photo-text";

/** Most photos read per post (a long carousel would take too long). */
const MAX_PHOTOS_PER_POST = 10;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in history.html`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only: captions are untrusted
  return node;
}

const statusPill = byId<HTMLSpanElement>("backend-status");
const savedSummary = byId<HTMLParagraphElement>("saved-summary");
const savedList = byId<HTMLOListElement>("saved-list");
const savedMessage = byId<HTMLParagraphElement>("saved-message");
const refreshButton = byId<HTMLButtonElement>("refresh");
const deleteAllButton = byId<HTMLButtonElement>("delete-all");
const folderInput = byId<HTMLInputElement>("export-folder");
const importStatus = byId<HTMLParagraphElement>("import-status");
const picker = byId<HTMLDivElement>("picker");
const importList = byId<HTMLOListElement>("import-list");
const readPhotos = byId<HTMLInputElement>("read-photos");
const importButton = byId<HTMLButtonElement>("import");
const importProgress = byId<HTMLProgressElement>("import-progress");
const importMessage = byId<HTMLParagraphElement>("import-message");

let saved: StoredHistoryPost[] = [];
let exportPosts: ExportPost[] = [];
let photoFiles = new Map<string, File>(); // export-relative path -> file
const picked = new Set<string>();
let busy = false;

function setText(node: HTMLElement, text: string, kind: "info" | "error" = "info") {
  node.textContent = text;
  node.dataset.kind = kind;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function showBackendStatus() {
  const { state, label, title } = describeBackendStatus(await checkHealth());
  statusPill.dataset.state = state;
  statusPill.textContent = label;
  statusPill.title = title;
}

// --- Saved posts -----------------------------------------------------------------

/** Reloads the saved list. `keepMessage`: leave a just-shown confirmation (e.g. "Deleted…") on screen. */
async function loadSaved(keepMessage = false) {
  try {
    saved = (await listHistory()).posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  } catch (err) {
    savedSummary.textContent = "";
    setText(savedMessage, (err as Error).message, "error");
    return;
  }
  if (!keepMessage) setText(savedMessage, "");
  savedSummary.textContent =
    saved.length === 0
      ? "No posts saved yet. Import some below."
      : `${saved.length} post${saved.length === 1 ? "" : "s"} saved (limit ${HISTORY_LIMITS.maxPostsPerUser}).`;
  deleteAllButton.disabled = saved.length === 0;
  savedList.replaceChildren(
    ...saved.map((post) => {
      const li = el("li", "hist-item");
      const body = el("div");
      body.append(el("div", "hist-date", shortDate(post.publishedAt)), el("p", "hist-caption", post.caption));
      if (post.imageText) body.append(el("p", "hist-photo-text", `Photo text: ${post.imageText}`));
      const remove = el("button", "secondary small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => void removeOne(post.postId));
      li.append(el("span"), body, remove);
      return li;
    }),
  );
  renderPicker(); // "already saved" labels may have changed
}

async function removeOne(postId: string) {
  try {
    const r = await deleteHistoryPost(postId);
    setText(savedMessage, `Deleted 1 post${r.deletedInterpretations ? ` and ${r.deletedInterpretations} AI note(s) made from it` : ""}.`);
  } catch (err) {
    setText(savedMessage, (err as Error).message, "error");
  }
  await loadSaved(true);
}

async function removeAll() {
  if (!confirm(`Delete all ${saved.length} saved posts and everything the AI concluded from them? This can't be undone.`)) return;
  try {
    const r = await deleteAllHistory();
    setText(savedMessage, `Deleted ${r.deletedPosts} posts and ${r.deletedInterpretations} AI note(s).`);
  } catch (err) {
    setText(savedMessage, (err as Error).message, "error");
  }
  await loadSaved(true);
}

// --- Import from the export ------------------------------------------------------

/** "instagram-me-2026/media/posts/a.jpg" -> "media/posts/a.jpg" (paths in the JSON are relative to the export root). */
function withoutRoot(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.slice(1).join("/");
}

async function readExportFolder(files: FileList) {
  const all = [...files];
  const byPath = new Map(all.map((f) => [f.webkitRelativePath.replaceAll("\\", "/"), f]));
  const postFiles = findPostFiles([...byPath.keys()]);
  if (postFiles.length === 0) {
    picker.hidden = true;
    setText(importStatus, "No posts found. Pick the UNZIPPED export folder (it contains content/posts_1.json, possibly inside your_instagram_activity).", "error");
    return;
  }
  const texts = await Promise.all(postFiles.map((p) => byPath.get(p)!.text()));
  const { posts, skipped } = parsePostFiles(texts);
  exportPosts = posts;
  photoFiles = new Map(all.map((f) => [withoutRoot(f.webkitRelativePath), f]));
  picked.clear();
  setText(
    importStatus,
    `Found ${posts.length} post${posts.length === 1 ? "" : "s"} on this computer${skipped ? ` (${skipped} entries skipped: not posts)` : ""}. Tick the ones to save.`,
  );
  picker.hidden = posts.length === 0;
  renderPicker();
}

function renderPicker() {
  if (exportPosts.length === 0) return;
  const savedIds = new Set(saved.map((p) => p.postId));
  importList.replaceChildren(
    ...exportPosts.map((post) => {
      const li = el("li", `hist-item${picked.has(post.postId) ? " is-picked" : ""}`);
      const box = el("input");
      box.type = "checkbox";
      box.checked = picked.has(post.postId);
      box.setAttribute("aria-label", `Save the post from ${shortDate(post.publishedAt)}`);
      box.addEventListener("change", () => {
        if (box.checked) picked.add(post.postId);
        else picked.delete(post.postId);
        li.classList.toggle("is-picked", box.checked);
        updateImportButton();
      });
      const body = el("div");
      const media = [`${post.photos.length} photo${post.photos.length === 1 ? "" : "s"}`];
      if (post.hasVideo) media.push("video (not read)");
      if (savedIds.has(post.postId)) media.push("already saved; saving again replaces it");
      body.append(el("div", "hist-date", shortDate(post.publishedAt)), el("p", "hist-caption", post.caption), el("p", "hist-meta", media.join(" · ")));
      li.append(box, body, el("span"));
      return li;
    }),
  );
  updateImportButton();
}

function updateImportButton() {
  importButton.disabled = busy || picked.size === 0;
  importButton.textContent = picked.size ? `Save ${picked.size} selected post${picked.size === 1 ? "" : "s"}` : "Save selected posts";
}

/** Reads the text in one post's photos, locally. Unreliable reads are dropped (describePhotoRead). */
async function photoTextFor(post: ExportPost): Promise<string | undefined> {
  const texts: string[] = [];
  for (const [i, path] of post.photos.slice(0, MAX_PHOTOS_PER_POST).entries()) {
    const file = photoFiles.get(path);
    if (!file) continue; // photo not in the chosen folder
    try {
      const view = describePhotoRead(await readImageText(file, i + 1));
      if (view.text) texts.push(view.text);
    } catch (err) {
      if (err instanceof OcrError && err.code === "CANCELLED") throw err;
      // One unreadable photo shouldn't stop the import; its text is just left out.
    }
  }
  return joinPhotoTexts(texts);
}

async function importPicked() {
  const chosen = exportPosts.filter((p) => picked.has(p.postId));
  if (chosen.length === 0) return;
  busy = true;
  updateImportButton();
  importProgress.hidden = false;
  importProgress.value = 0;
  setText(importMessage, "");

  const ready: HistoryPost[] = [];
  let emptySkipped = 0;
  try {
    for (const [i, post] of chosen.entries()) {
      setText(importMessage, readPhotos.checked && post.photos.length ? `Reading photos on this computer… (${i + 1} of ${chosen.length})` : `Preparing… (${i + 1} of ${chosen.length})`);
      const imageText = readPhotos.checked ? await photoTextFor(post) : undefined;
      if (!post.caption.trim() && !imageText) {
        emptySkipped++; // nothing to check in this post
      } else {
        ready.push({ postId: post.postId, status: "published", publishedAt: post.publishedAt, caption: post.caption, ...(imageText ? { imageText } : {}) });
      }
      importProgress.value = (i + 1) / chosen.length / 2;
    }

    let savedCount = 0;
    for (let start = 0; start < ready.length; start += HISTORY_LIMITS.maxPostsPerImport) {
      const batch = ready.slice(start, start + HISTORY_LIMITS.maxPostsPerImport);
      setText(importMessage, `Saving… (${savedCount} of ${ready.length})`);
      savedCount += (await importHistory(batch)).imported;
      importProgress.value = 0.5 + savedCount / Math.max(1, ready.length) / 2;
    }
    setText(
      importMessage,
      `Saved ${savedCount} post${savedCount === 1 ? "" : "s"}.${emptySkipped ? ` ${emptySkipped} had no caption or readable photo text, so there was nothing to save.` : ""}`,
    );
    picked.clear();
  } catch (err) {
    setText(importMessage, `Stopped: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    importProgress.hidden = true;
    await loadSaved();
  }
}

refreshButton.addEventListener("click", () => void loadSaved());
deleteAllButton.addEventListener("click", () => void removeAll());
folderInput.addEventListener("change", () => {
  if (folderInput.files?.length) void readExportFolder(folderInput.files);
});
byId<HTMLButtonElement>("select-all").addEventListener("click", () => {
  exportPosts.forEach((p) => picked.add(p.postId));
  renderPicker();
});
byId<HTMLButtonElement>("select-none").addEventListener("click", () => {
  picked.clear();
  renderPicker();
});
importButton.addEventListener("click", () => void importPicked());

void showBackendStatus();
void loadSaved();
