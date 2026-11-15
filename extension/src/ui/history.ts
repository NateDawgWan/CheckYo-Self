// Earlier-posts (history) panel: approve importing specific posts, see what is
// imported, and delete it. The panel never stores or sends anything itself; it
// only calls the callbacks. Whoever owns the history service (docs/TEAM.md
// interface D) does the real work and then calls setState() with the outcome.
//
// The approve/delete controls appear ONLY when the history service is connected
// (or in a clearly labeled development fixture). Otherwise the panel says the
// feature isn't available, instead of showing buttons that do nothing.
import type { HistoryPost, TextSource } from "../../../shared/contract";
import { button, el, shortDate } from "./dom";

/**
 *  - "not_connected": no history service yet (today's real state). No controls.
 *  - "fixture":       development fixture: made-up posts, nothing stored or sent anywhere but the analysis request.
 *  - "connected":     the history service answered. Controls are live.
 */
export type HistoryConnection = "not_connected" | "fixture" | "connected";

export interface HistoryViewState {
  connection: HistoryConnection;
  /** Posts the user could approve importing (not imported yet). */
  candidates: HistoryPost[];
  /** Posts already imported with the user's approval. */
  imported: HistoryPost[];
  /** Optional status text, e.g. "Imported 2 posts." or an error. */
  message?: { text: string; kind: "info" | "error" };
  /** true while an import/delete is in progress (controls disabled). */
  busy?: boolean;
}

export interface HistoryCallbacks {
  /** The user approved importing exactly `posts`. `approvalId` identifies this approval. */
  onApproveHistoryImport(approvalId: string, posts: HistoryPost[]): void;
  /** The user confirmed deleting all imported history. */
  onDeleteHistory(): void;
}

/** Approve/delete controls are shown only for a connected service or a labeled fixture. */
export function historyControlsAvailable(connection: HistoryConnection): boolean {
  return connection === "connected" || connection === "fixture";
}

/** Approved posts as analysis sources: id "history:<postId>", with the post's date. */
export function historySources(posts: HistoryPost[]): TextSource[] {
  return posts.map((p) => ({
    id: `history:${p.postId}`,
    type: "history" as const,
    text: p.imageText ? `${p.caption}\n\nPhoto text: ${p.imageText}` : p.caption,
    date: p.postedAt,
  }));
}

function postPreview(post: HistoryPost) {
  const wrap = el("span", "history-post");
  wrap.append(el("span", "history-date", `Posted ${shortDate(post.postedAt)}`));
  wrap.append(el("span", "history-caption", post.caption));
  if (post.imageText) wrap.append(el("span", "history-imagetext", `Photo text: ${post.imageText}`));
  return wrap;
}

export class HistoryPanel {
  private state: HistoryViewState = { connection: "not_connected", candidates: [], imported: [] };
  private includeInChecks = true;
  private selected = new Set<string>();
  private confirming: "import" | "delete" | null = null;

  constructor(private container: HTMLElement, private callbacks: HistoryCallbacks) {
    this.draw();
  }

  setState(state: HistoryViewState) {
    this.state = state;
    // Forget selections for posts that are no longer candidates.
    const ids = new Set(state.candidates.map((p) => p.postId));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    this.confirming = null;
    this.draw();
  }

  /** Imported posts to include in the next check (empty if not connected or switched off). */
  sources(): TextSource[] {
    if (!historyControlsAvailable(this.state.connection) || !this.includeInChecks) return [];
    return historySources(this.state.imported);
  }

  private draw() {
    const s = this.state;
    this.container.replaceChildren();
    this.container.append(el("h2", "panel-title", "Earlier posts"));

    if (!historyControlsAvailable(s.connection)) {
      this.container.append(
        el(
          "p",
          "hint",
          "Comparing with your earlier posts isn't available yet: the history service isn't connected. " +
            "No earlier posts are stored or sent.",
        ),
      );
      return;
    }

    if (s.connection === "fixture") {
      this.container.append(
        el(
          "p",
          "banner banner-fixture",
          "Development fixture: these posts are made up. Approving or deleting only changes this popup; " +
            "nothing is stored. Approved fixture posts ARE included in the check request.",
        ),
      );
    }

    if (s.message) {
      const msg = el("p", "message", s.message.text);
      msg.dataset.kind = s.message.kind;
      this.container.append(msg);
    }

    this.drawImported();
    this.drawCandidates();
  }

  private drawImported() {
    const s = this.state;
    const section = el("div", "history-section");
    section.append(el("h3", undefined, `Imported with your approval (${s.imported.length})`));
    if (s.imported.length === 0) {
      section.append(el("p", "consent-none", "Nothing imported."));
      this.container.append(section);
      return;
    }

    const list = el("ul", "history-list");
    for (const post of s.imported) {
      const li = el("li");
      li.append(postPreview(post));
      list.append(li);
    }
    section.append(list);

    const includeLabel = el("label", "check");
    const include = el("input");
    include.type = "checkbox";
    include.checked = this.includeInChecks;
    include.addEventListener("change", () => (this.includeInChecks = include.checked));
    includeLabel.append(include, " Compare with these posts when I check a new post");
    section.append(includeLabel);

    if (this.confirming === "delete") {
      const confirm = el("div", "confirm");
      confirm.append(
        el("p", undefined, `Delete all ${s.imported.length} imported post(s)? This can't be undone.`),
      );
      const row = el("div", "actions");
      row.append(button("Cancel", "secondary small", () => this.setConfirm(null)));
      const yes = button("Delete my history", "danger small", () => {
        this.confirming = null;
        this.callbacks.onDeleteHistory();
      });
      yes.disabled = !!s.busy;
      row.append(yes);
      confirm.append(row);
      section.append(confirm);
    } else {
      const del = button("Delete my imported history", "secondary small danger-outline", () => this.setConfirm("delete"));
      del.disabled = !!s.busy;
      const row = el("div", "actions");
      row.append(del);
      section.append(row);
    }
    this.container.append(section);
  }

  private drawCandidates() {
    const s = this.state;
    const section = el("div", "history-section");
    section.append(el("h3", undefined, "Posts you can import"));
    if (s.candidates.length === 0) {
      section.append(el("p", "consent-none", "No posts waiting for approval."));
      this.container.append(section);
      return;
    }
    section.append(
      el("p", "hint", "Tick only the posts you want compared with future posts. Only their text is stored, never photos."),
    );

    const list = el("ul", "history-list");
    for (const post of s.candidates) {
      const li = el("li");
      const label = el("label", "check history-pick");
      const box = el("input");
      box.type = "checkbox";
      box.checked = this.selected.has(post.postId);
      box.disabled = !!s.busy;
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(post.postId);
        else this.selected.delete(post.postId);
        this.confirming = null;
        this.draw();
      });
      label.append(box, postPreview(post));
      li.append(label);
      list.append(li);
    }
    section.append(list);

    const chosen = s.candidates.filter((p) => this.selected.has(p.postId));
    if (this.confirming === "import" && chosen.length > 0) {
      const confirm = el("div", "confirm");
      confirm.append(
        el(
          "p",
          undefined,
          `Approve storing the text of ${chosen.length} post(s) (caption and photo text only) so future checks can ` +
            "compare against them? You can delete them at any time.",
        ),
      );
      const row = el("div", "actions");
      row.append(button("Cancel", "secondary small", () => this.setConfirm(null)));
      const yes = button("Approve import", "primary small", () => {
        this.confirming = null;
        this.callbacks.onApproveHistoryImport(crypto.randomUUID(), chosen.map((p) => ({ ...p })));
      });
      yes.disabled = !!s.busy;
      row.append(yes);
      confirm.append(row);
      section.append(confirm);
    } else {
      const imp = button(`Import ${chosen.length} selected`, "secondary small", () => this.setConfirm("import"));
      imp.disabled = chosen.length === 0 || !!s.busy;
      const row = el("div", "actions");
      row.append(imp);
      section.append(row);
    }
    this.container.append(section);
  }

  private setConfirm(kind: "import" | "delete" | null) {
    this.confirming = kind;
    this.draw();
  }
}
