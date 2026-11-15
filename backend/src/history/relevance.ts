// Picks which of the user's approved earlier posts to send along with a draft.
// Simple and explainable on purpose: posts that share meaningful words with
// the draft come first, then the most recent ones. No AI involved here.
import { HISTORY_LIMITS, LIMITS, type StoredHistoryPost, type TextSource } from "../../../shared/contract";

const STOP_WORDS = new Set(
  "about after again also back been before being from have here just like more much only over same some than that their them then there these they this today tonight very want were what when where which while will with would your".split(
    " ",
  ),
);

/** Lowercase words of 4+ letters/digits, minus very common words. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return new Set(words.filter((w) => !STOP_WORDS.has(w)));
}

/** The text of an earlier post as one source: caption plus any photo text. */
export function historySourceText(post: StoredHistoryPost): string {
  return post.imageText ? `${post.caption}\nText in photo: ${post.imageText}` : post.caption;
}

export interface SelectedHistory {
  sources: TextSource[];
  used: Array<{ sourceId: string; postId: string; publishedAt: string }>;
}

/**
 * Chooses up to HISTORY_LIMITS.maxPostsPerAnalysis posts and turns them into
 * "history:<postId>" sources with their publication date, keeping the whole
 * request within LIMITS (sources and characters).
 */
export function selectRelevantHistory(draft: TextSource[], posts: StoredHistoryPost[]): SelectedHistory {
  const draftWords = keywords(draft.map((s) => s.text).join(" "));
  const draftChars = draft.reduce((n, s) => n + s.text.length, 0);

  const scored = posts.map((post) => {
    const words = keywords(historySourceText(post));
    let shared = 0;
    for (const w of words) if (draftWords.has(w)) shared++;
    return { post, shared, time: Date.parse(post.publishedAt) || 0 };
  });
  // Most shared words first; ties go to the most recent post.
  scored.sort((a, b) => b.shared - a.shared || b.time - a.time);

  const maxPosts = Math.min(HISTORY_LIMITS.maxPostsPerAnalysis, LIMITS.maxSources - draft.length);
  let charsLeft = LIMITS.maxTotalChars - draftChars;
  const result: SelectedHistory = { sources: [], used: [] };

  for (const { post } of scored) {
    if (result.sources.length >= maxPosts) break;
    const text = historySourceText(post).slice(0, LIMITS.maxCharsPerSource);
    if (text.length > charsLeft) continue;
    charsLeft -= text.length;
    const sourceId = `history:${post.postId}`;
    result.sources.push({ id: sourceId, type: "history", text, date: post.publishedAt });
    result.used.push({ sourceId, postId: post.postId, publishedAt: post.publishedAt });
  }
  return result;
}
