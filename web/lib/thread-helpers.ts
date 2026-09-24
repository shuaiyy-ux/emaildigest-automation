/**
 * Thread aggregation — group emails by thread_id for Gmail-style conversation view.
 *
 * Rules (mirrors Gmail):
 *   - A thread appears in any tab/filter where *any* email in it matches.
 *   - Sorting uses the latest email's receivedAt.
 *   - Displayed sender/subject/snippet come from the latest email.
 *   - `isUnread`, `primaryUntil`, category membership aggregate across all emails.
 *
 * Scope: pure functions over in-memory Email[]. No API / DB changes. Emails
 * without a thread_id (unlikely — Gmail always populates it) degrade to a
 * single-email "thread" keyed by the email id.
 */
import type { Email } from "./types";
import { isPriority, isOther } from "./utils";

export interface Thread {
  threadId: string;
  /** Emails in the thread, sorted oldest → newest. */
  emails: Email[];
  /** Latest (newest) email — drives collapsed-row display. */
  latest: Email;
  /** Count of unread emails in this thread. 0 means all read. */
  unreadCount: number;
  /** Total emails in thread. */
  count: number;
}

/**
 * Group `emails` by `thread_id`. Inputs can be in any order; outputs are
 * sorted by the latest email's receivedAt DESC (Gmail convention).
 * Within a thread, emails are sorted receivedAt ASC (oldest at top).
 */
export function groupByThread(emails: Email[]): Thread[] {
  const byKey = new Map<string, Email[]>();
  for (const e of emails) {
    const key = e.threadId || `_single_${e.id}`;
    let bucket = byKey.get(key);
    if (!bucket) { bucket = []; byKey.set(key, bucket); }
    bucket.push(e);
  }
  const threads: Thread[] = [];
  for (const [threadId, bucket] of byKey) {
    bucket.sort((a, b) => (a.receivedAt ?? 0) - (b.receivedAt ?? 0));
    const latest = bucket[bucket.length - 1];
    threads.push({
      threadId,
      emails: bucket,
      latest,
      unreadCount: bucket.filter((e) => e.isUnread).length,
      count: bucket.length,
    });
  }
  threads.sort((a, b) => (b.latest.receivedAt ?? 0) - (a.latest.receivedAt ?? 0));
  return threads;
}

/** Any email in thread is unread → thread is unread. */
export function threadIsUnread(t: Thread): boolean {
  return t.unreadCount > 0;
}

/** Thread appears in Priority if any email is Priority. */
export function threadIsPriority(t: Thread, nowSec?: number): boolean {
  return t.emails.some((e) => isPriority(e, nowSec));
}

/** Thread appears in Other if any email is Other. */
export function threadIsOther(t: Thread): boolean {
  return t.emails.some((e) => isOther(e));
}

/** Thread is Junk only if *every* email is Junk (dominant, matches Gmail). */
export function threadIsJunk(t: Thread): boolean {
  return t.emails.every((e) => e.categoryId === "cat_junk" || e.category === "junk");
}

/** Thread matches a legacy-category short name (e.g. "primary", "track") if any email does. */
export function threadMatchesCategory(t: Thread, catShortName: string): boolean {
  return t.emails.some((e) => e.category === catShortName);
}

/** Thread matches a search query (case-insensitive) if any email matches on from/subject/snippet. */
export function threadMatchesSearch(t: Thread, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return t.emails.some((e) =>
    (e.from || "").toLowerCase().includes(q) ||
    (e.fromEmail || "").toLowerCase().includes(q) ||
    (e.subject || "").toLowerCase().includes(q) ||
    (e.snippet || "").toLowerCase().includes(q)
  );
}

/** Max primary_until across thread emails, for TTL elevation. */
export function threadMaxPrimaryUntil(t: Thread): number | null {
  let max: number | null = null;
  for (const e of t.emails) {
    if (e.primaryUntil && (max === null || e.primaryUntil > max)) max = e.primaryUntil;
  }
  return max;
}

/**
 * Compact sender list à la Gmail: unique sender display-names in chronological order.
 * Returns `"Alice, me, Bob"` style string; truncates to 3 unique senders + "+N" if more.
 * If selfEmail matches, substitute "me".
 */
export function compactSenders(t: Thread, selfEmail?: string): string {
  const seen: string[] = [];
  const self = (selfEmail || "").toLowerCase();
  for (const e of t.emails) {
    const isSelf = self && (e.fromEmail || "").toLowerCase() === self;
    const label = isSelf ? "me" : (e.from || e.fromEmail || "(unknown)");
    if (!seen.includes(label)) seen.push(label);
  }
  if (seen.length <= 3) return seen.join(", ");
  return `${seen.slice(0, 2).join(", ")} +${seen.length - 2}`;
}

/**
 * Given a list of emails, return the ids of all emails in the same thread as `anchor`.
 * Used when the user right-clicks a thread and the action should apply to every email in it.
 */
export function threadEmailIds(t: Thread): string[] {
  return t.emails.map((e) => e.id);
}
