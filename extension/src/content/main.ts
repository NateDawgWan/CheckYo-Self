// Content script for https://www.instagram.com/* (milestone 4).
//
// Supported workflow: ONE single-photo post made in the desktop website's
// "Create" dialog. When the caption step is open, it:
//   - shows a "Check this post" button (always available, the manual path),
//   - pauses a click on Share and offers: check / back to editing / continue,
//   - sends ONLY text to the service worker, which calls our local backend,
//   - marks results stale on any change, and ignores outdated replies,
//   - never clicks Share itself: "continue" lets the user's next click through.
//
// Instagram-specific page details are in instagram-adapter.ts.
// The rules (stale, outdated, one-time permission, no double share) are in
// share-flow.ts, which is unit-tested.
import type {
  CheckDraftReply,
  ExtensionMessage,
  InstagramDraftReply,
  SuggestedEdit,
  TextSource,
} from "../../../shared/contract";
import { hashSources } from "../api";
import { applyEditToText } from "../edits";
import { assessPhotoQuality, limitPhotoText, PHOTO_TEXT_MAX_CHARS, truncationNotice } from "../photo-text";
import type { OcrPort, PhotoNotice, WarningPanel, WarningPanelActions } from "../ports";
import { offscreenOcr } from "./offscreen-ocr";
import {
  detectPublishOutcome,
  readComposer,
  readImageBlob,
  shareButtonFromEvent,
  writeCaption,
  type ComposerSnapshot,
  type PostType,
} from "./instagram-adapter";
import { createOverlayPanel } from "./overlay";
import { ShareFlow, draftKey, type PublishOutcome } from "./share-flow";

/**
 * The kinds of post the extension helps with. For anything else (several
 * photos, video, or a post we can't recognise) the extension does nothing at
 * all: no button, and Share is never paused.
 * TO SUPPORT ANOTHER TYPE: add it here, then give each of its photos a
 * "Text in the photo" source in currentSources() (image_text:1, :2, ...).
 */
export const SUPPORTED_POST_TYPES: PostType[] = ["single-photo"];

/** Is the caption step of a supported post open right now? */
function isSupportedCaptionStep(snapshot: ComposerSnapshot): boolean {
  return snapshot.step === "caption-step" && SUPPORTED_POST_TYPES.includes(snapshot.postType);
}

export interface IntegrationOptions {
  ocr: OcrPort;
  createPanel: (actions: WarningPanelActions) => WarningPanel;
}

export function startInstagramIntegration(options: IntegrationOptions) {
  const flow = new ShareFlow();
  let panel: WarningPanel | null = null; // created the first time a composer appears

  // What we last read from the page.
  let snapshot: ComposerSnapshot = readComposer(document);
  let imageKey: string | null = null; // which photo(s) are selected; a change means a different post
  let imageText = "";   // text in the (single) photo: from OCR, or typed by the user in our panel
  let ocrTurn = 0;      // to ignore OCR results for a photo that is no longer selected
  let ocrRunning = false;      // true while the photo is being read; checking waits for it
  let imageTextTyped = false;  // the user typed in the photo-text box; OCR must not overwrite it
  let sharedDraftHash: Promise<string> | null = null; // hash of the draft that was shared

  // -------------------------------------------------------------------------
  // The draft
  // -------------------------------------------------------------------------

  /** The draft as TextSources. Only text — never the image. */
  function currentSources(): TextSource[] {
    const sources: TextSource[] = [{ id: "caption", type: "caption", text: snapshot.caption }];
    if (imageText.trim()) sources.push({ id: "image_text:1", type: "image_text", text: imageText });
    return sources;
  }

  function currentKey(): string {
    return draftKey(currentSources(), imageKey);
  }

  function getPanel(): WarningPanel {
    if (!panel) panel = options.createPanel(actions);
    return panel;
  }

  /** Re-reads the page and reacts to any change. Called (debounced) on every page change. */
  function scan() {
    snapshot = readComposer(document);

    if (flow.isPublishing()) watchPublishOutcome();

    if (!isSupportedCaptionStep(snapshot)) {
      if (panel) {
        panel.showLauncher(false);
        panel.close();
        panel.setShareReady(false);
      }
      if (imageKey !== null || flow.isShareAllowed(Date.now())) {
        // The user closed the composer or went back a step without sharing.
        if (flow.isShareAllowed(Date.now())) console.info("[Second Look] Share outcome: cancelled");
        flow.composerClosed();
        imageKey = null;
        imageText = "";
        imageTextTyped = false;
        ocrTurn++; // ignore a scan still running for the closed post
        ocrRunning = false;
        panel?.setPhotoNotices([]);
        panel?.clearResult();
        panel?.setStale(false);
      }
      return;
    }

    const p = getPanel();
    if (!p.isOpen()) p.showLauncher(true);

    // A different photo: forget the old photo text and read the new one.
    const newImageKey = snapshot.images.map((image) => image.key).join("|");
    if (newImageKey !== imageKey) {
      imageKey = newImageKey;
      imageText = "";
      imageTextTyped = false;
      void startOcr();
    }

    draftChanged();
  }

  /** Tell the flow about the current draft; update the stale banner and Share hint. */
  function draftChanged() {
    const becameStale = flow.updateDraft(currentKey());
    if (becameStale) {
      panel?.setMessage("You changed the post. Check again before sharing.");
    }
    if (panel) {
      panel.setStale(flow.lastResult() !== null && !flow.hasCurrentResult());
      panel.setShareReady(flow.isShareAllowed(Date.now()));
      panel.setBusy(flow.isChecking());
    }
  }

  // -------------------------------------------------------------------------
  // OCR: the selected photo is grabbed from Instagram's composer (no upload
  // prompt) and read on this computer by the offscreen OCR page. Reading it
  // sends nothing for analysis; see content/offscreen-ocr.ts.
  // -------------------------------------------------------------------------

  /** Show OCR's text, unless the user already typed their own (never overwrite it). */
  function showOcrText(text: string, hint: string) {
    const p = getPanel();
    if (imageTextTyped) {
      p.setImageText(imageText, `${hint} You had already typed the photo text, so yours was kept.`);
      return;
    }
    imageText = text;
    p.setImageText(text, hint);
  }

  async function startOcr() {
    const myTurn = ++ocrTurn;
    const p = getPanel();
    const photo = snapshot.images[0]; // single-photo posts only (see SUPPORTED_POST_TYPES)
    ocrRunning = false;
    p.setPhotoNotices([]); // notices belong to the previous photo
    if (!photo) {
      p.setImageText("", "Type any text you can see in the photo (signs, name tags, jerseys).");
      return;
    }
    if (!options.ocr.available) {
      p.setImageText("", "Automatic photo reading isn't available. Type any text you can see in the photo (signs, name tags, jerseys).");
      return;
    }
    ocrRunning = true;
    p.setImageText("", "Reading text from the photo on your computer… (nothing is sent yet)");
    try {
      const blob = await readImageBlob(photo);
      if (myTurn !== ocrTurn) return; // a newer photo was selected meanwhile
      if (!blob) {
        showOcrText("", "Couldn't read this photo from the page. Type any text you can see in it.");
        return;
      }
      const result = await options.ocr.readImageText(blob, 1); // stays inside the browser
      if (myTurn !== ocrTurn) return;

      // Strict size limit (demo safety): keep at most PHOTO_TEXT_MAX_CHARS.
      const limited = limitPhotoText(result.text);
      // Tell the user explicitly when the read is noisy or unreliable.
      const quality = assessPhotoQuality(result);
      const notices: PhotoNotice[] = [];
      if (quality.message) notices.push({ kind: quality.level === "poor" ? "poor" : "warning", text: quality.message });
      if (limited.truncated) notices.push({ kind: "warning", text: truncationNotice(limited) });
      p.setPhotoNotices(notices);
      if (limited.truncated || quality.level === "poor" || quality.level === "noisy") {
        console.info(`[Second Look] Photo read: quality=${quality.level}, truncated=${limited.truncated}`); // no photo text in logs
      }

      const sure = result.confidence === null ? "" : ` (confidence ${Math.round(result.confidence)}%)`;
      showOcrText(
        limited.text,
        result.status === "no_text"
          ? "No text found in the photo. Type any text you can see in it."
          : `Read from the photo on your computer${sure}. Check it and fix any mistakes before checking the post.`,
      );
    } catch (err) {
      if (myTurn !== ocrTurn) return;
      // OCR errors carry a user-readable message (src/ocr/README.md). A failure is never "no text".
      const reason = err instanceof Error ? ` ${err.message}` : "";
      showOcrText("", `Reading the photo failed.${reason} Type any text you can see in it.`);
    } finally {
      if (myTurn === ocrTurn) {
        ocrRunning = false;
        draftChanged(); // the photo text is part of the draft
      }
    }
  }

  // -------------------------------------------------------------------------
  // Panel actions
  // -------------------------------------------------------------------------

  const actions: WarningPanelActions = {
    onOpen() {
      // The corner button only OPENS the panel, so the user sees the photo
      // text before anything is sent. Sending needs a click on "Check this post".
      const p = getPanel();
      if (!p.isOpen()) p.open("manual");
    },
    onCheck() {
      const p = getPanel();
      if (!p.isOpen()) p.open("manual"); // keep the "Before you share" heading if Share opened it
      void checkDraft();
    },
    onBack() {
      flow.cancelShare();
      const p = getPanel();
      p.setShareReady(false);
      p.close();
      p.showLauncher(isSupportedCaptionStep(snapshot));
      snapshot.editor?.focus();
    },
    onContinue() {
      // Does NOT share. Only lets the user's next real click on Share through.
      flow.allowNextShare(Date.now());
      const p = getPanel();
      const ready = flow.isShareAllowed(Date.now());
      p.setShareReady(ready);
      p.setMessage(flow.hasCurrentResult() ? "" : "Not checked. Click Share when you're ready.");
      if (ready) {
        // Get out of the way: the open panel can cover Instagram's Share
        // button (checked live). The small corner button now says "Ready";
        // clicking it reopens the panel (without sending anything) and without cancelling.
        p.close();
        p.showLauncher(true);
      }
    },
    onApplyEdit(edit) {
      void applyEdit(edit);
    },
    onImageTextInput(text) {
      imageText = text;
      imageTextTyped = true;
      draftChanged();
    },
  };

  async function checkDraft() {
    snapshot = readComposer(document);
    const p = getPanel();
    if (!isSupportedCaptionStep(snapshot)) {
      p.setMessage("Open the caption step of a single-photo post first.", "error");
      return;
    }
    draftChanged();
    if (ocrRunning && !imageTextTyped) {
      // Don't send a draft that is missing the photo text the user hasn't seen yet.
      p.setMessage("Still reading the photo. Check it again in a moment, once its text appears above.", "error");
      return;
    }
    if (imageText.length > PHOTO_TEXT_MAX_CHARS) {
      // Can't normally happen (the box has the same limit); never send it if it does.
      p.setMessage(`The photo text is longer than ${PHOTO_TEXT_MAX_CHARS} characters. Shorten it before checking.`, "error");
      return;
    }
    const sources = currentSources();
    if (!sources.some((s) => s.text.trim())) {
      p.setMessage("Write a caption (or type the photo's text) first.", "error");
      return;
    }

    const requestId = flow.startCheck();
    if (requestId === null) return; // this exact draft is already being checked
    p.setBusy(true);
    p.setMessage("Checking your post…");

    let reply: CheckDraftReply | { kind: "rejected"; reason: string } | undefined;
    try {
      const draftHash = await hashSources(sources);
      const message: ExtensionMessage = { kind: "check-draft", requestId, draftHash, sources };
      reply = await chrome.runtime.sendMessage(message);
    } catch {
      reply = { kind: "check-error", requestId, message: "Second Look was reloaded. Refresh this page and try again." };
    }

    if (!reply || reply.kind === "rejected") {
      if (flow.receiveError(requestId) === "accepted") {
        p.setMessage(reply ? reply.reason : "No answer from Second Look. Try again.", "error");
      }
    } else if (reply.kind === "check-error") {
      if (flow.receiveError(reply.requestId) === "accepted") p.setMessage(reply.message, "error");
    } else if (flow.receiveResult(reply.requestId, reply.result) === "accepted") {
      p.showResult(reply.result, sources);
      const n = reply.result.findings.length;
      if (reply.result.droppedFindings > 0) {
        p.setMessage(`Check incomplete: ${n} thing${n === 1 ? "" : "s"} shown, ${reply.result.droppedFindings} not shown.`, "error");
      } else {
        p.setMessage(n === 0 ? "Check complete." : `Check complete: ${n} thing${n === 1 ? "" : "s"} to review.`);
      }
    }
    // An "outdated" reply is ignored on purpose: the draft changed while we waited.
    draftChanged();
  }

  let applying = false; // so a double-click on Apply can't start two edits at once

  /** "Apply" on a suggested edit: only if the caption still matches what was checked. */
  async function applyEdit(edit: SuggestedEdit) {
    if (applying) return;
    const p = getPanel();
    snapshot = readComposer(document); // read the caption as it is RIGHT NOW
    if (!isSupportedCaptionStep(snapshot) || !snapshot.editor) {
      p.setMessage("The caption box isn't open any more.", "error");
      return;
    }
    if (!flow.canApplyEdit(currentKey())) {
      p.setMessage("Your post changed since this check. Check again before applying suggestions.", "error");
      draftChanged();
      return;
    }
    const result = applyEditToText(snapshot.caption, edit);
    if (!result.ok) {
      p.setMessage(result.reason, "error");
      return;
    }
    const captionBefore = snapshot.caption;
    applying = true;
    p.setMessage("Applying the change…");
    let changed = false;
    try {
      changed = await writeCaption(snapshot.editor, result.text);
    } finally {
      applying = false;
    }
    scan(); // the caption (may have) changed, so the result is now stale
    if (changed) {
      p.setMessage("Change applied. Check again to see updated results.");
      return;
    }
    // Instagram's editor didn't take the change. Never leave a half-edit
    // silently: tell the user, and offer the text to paste themselves.
    const copied = await navigator.clipboard.writeText(result.text).then(() => true, () => false);
    const copyNote = copied ? " The suggested caption was copied; paste it in yourself." : "";
    p.setMessage(
      snapshot.caption === captionBefore
        ? "Couldn't change Instagram's caption box." + copyNote
        : "Couldn't apply this change cleanly, and your caption may have changed. Please check it." + copyNote,
      "error",
    );
  }

  // -------------------------------------------------------------------------
  // Share button interception
  // -------------------------------------------------------------------------

  /**
   * Runs BEFORE Instagram sees any click (capture phase on window, added at
   * document_start, so ours runs first). Stopping the event here means
   * Instagram's own handler never runs.
   */
  function onPointerOrClick(event: Event) {
    const shareButton = shareButtonFromEvent(event);
    if (!shareButton) return;
    // Only supported post types (see SUPPORTED_POST_TYPES); for others we
    // never get in the way.
    if (!isSupportedCaptionStep(readComposer(document))) return;

    const now = Date.now();
    if (event.type !== "click") {
      // pointerdown/mousedown/etc.: block them unless the user chose to continue,
      // in case Instagram reacts to them instead of "click".
      if (!flow.isShareAllowed(now)) stop(event);
      return;
    }

    const decision = flow.onShareClick(now);
    if (decision === "allow") {
      // The user's own click goes through to Instagram, untouched.
      snapshot = readComposer(document);
      sharedDraftHash = hashSources(currentSources());
      const p = getPanel();
      p.setShareReady(false);
      p.close();
      p.showLauncher(false);
      return;
    }
    stop(event);
    if (decision === "block") {
      getPanel().setMessage("Your post is already being shared.", "error");
      return;
    }
    // "intercept": show our choice instead.
    scan();
    const p = getPanel();
    p.open("share-clicked");
    p.setShareReady(false);
    p.setMessage(flow.hasCurrentResult() ? "You checked this exact post. Continue, or go back to edit." : "");
  }

  /** Enter/Space on a focused Share button. */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!shareButtonFromEvent(event) || !isSupportedCaptionStep(readComposer(document))) return;
    if (flow.isShareAllowed(Date.now())) return; // let it through; the click that follows decides
    stop(event);
    scan();
    getPanel().open("share-clicked");
  }

  function stop(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend", "click"]) {
    // passive: false, or Chrome ignores preventDefault() on touch events.
    window.addEventListener(type, onPointerOrClick, { capture: true, passive: false });
  }
  window.addEventListener("keydown", onKeyDown, { capture: true, passive: false });

  // -------------------------------------------------------------------------
  // After Share
  // -------------------------------------------------------------------------

  function watchPublishOutcome() {
    const seen = detectPublishOutcome(document);
    let outcome: PublishOutcome | null = null;
    if (seen === "published") outcome = flow.finishPublishing("published");
    else if (seen === "failed") outcome = flow.finishPublishing("failed");
    // Closed without a confirmation or error: we can't tell what happened.
    else if (seen === "closed") outcome = flow.finishPublishing("unknown");
    else if (flow.publishTimedOut(Date.now())) outcome = flow.finishPublishing("unknown");
    if (outcome) reportOutcome(outcome);
  }

  async function reportOutcome(outcome: PublishOutcome) {
    console.info(`[Second Look] Share outcome: ${outcome}`);
    if (outcome !== "published" || !sharedDraftHash) return; // only CONFIRMED posts count
    const message: ExtensionMessage = {
      kind: "post-published",
      draftHash: await sharedDraftHash,
      postId: null, // UNVERIFIED whether Instagram shows the new post's id; not read yet
      publishedAt: new Date().toISOString(),
    };
    sharedDraftHash = null;
    chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // The popup's "Use draft from Instagram tab"
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only our own popup (an extension page, not a tab) may ask.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if ((message as ExtensionMessage | null)?.kind !== "get-instagram-draft") return false;
    snapshot = readComposer(document);
    const found = isSupportedCaptionStep(snapshot);
    const reply: InstagramDraftReply = {
      kind: "instagram-draft",
      found,
      caption: found ? snapshot.caption : "",
      imageText: found ? imageText : "",
    };
    sendResponse(reply);
    return false;
  });

  // -------------------------------------------------------------------------
  // Watching the page
  // -------------------------------------------------------------------------

  let scanTimer: number | undefined;
  function scheduleScan() {
    if (scanTimer !== undefined) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = undefined;
      scan();
    }, 150);
  }
  new MutationObserver(scheduleScan).observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener("input", scheduleScan, true);
  // Also check now and then, so a share that never gets an answer times out.
  window.setInterval(() => flow.isPublishing() && scan(), 2000);
}

startInstagramIntegration({ ocr: offscreenOcr, createPanel: createOverlayPanel });
