/**
 * Email digest — a long-form narrative summary of the last 48h of email
 * activity, split into Primary / Track / News sections.
 *
 * Cadence (2026-05-02 redesign):
 *   - Data refresh: every 2h with stale-check. `isEmailDigestStale` returns
 *     true only if (≥ 2h since last gen) AND (a new email arrived since
 *     last gen). Idle inboxes don't burn LLM cycles.
 *   - Push notifications: still gated to 9/15/21 PT slots. We don't want
 *     to push 12x/day even though the digest data may refresh that often.
 *     `push_last_slot_pushed_at` app_state key prevents duplicate pushes
 *     within the same slot window.
 *
 * Storage: single `app_state.email_digest` JSON blob. Not a new table —
 * only one digest exists at a time (no history).
 *
 * LLM path: one tool-less `claude -p` run via lib/claude-cli.ts (empty cwd,
 * no MCP, no settings). DEMO_MODE: no background regeneration and no push;
 * only an explicit POST /api/emails/digest regenerates.
 */
import * as os from "os";
import db from "./db";
import { getAppState, setAppState, type EmailRow } from "./db";
import { parseJsonObject } from "./parse";
import { stripQuotedReply } from "./reply-quote";
import { runClaude } from "./claude-cli";
import { isDemoMode } from "./demo";
import { log } from "./logger";

const dlog = log.child("email-digest");
const plog = log.child("push-digest");

const MODEL = process.env.EMAILDIGEST_DIGEST_MODEL
  || process.env.EMAILDIGEST_DRAFT_MODEL
  || "sonnet";

const STALE_INTERVAL_SEC = 2 * 3600;            // refresh ceiling: ≥ 2h between regens
const LOOKBACK_SEC = 48 * 3600;                 // 48 hours of mail feeds the digest
// Different caps per category reflect the target section length — Primary
// gets the most source emails because its output section is the longest.
const MAX_PRIMARY = 30;
const MAX_TRACK   = 20;
const MAX_NEWS    = 12;
const MAX_REVIEW  = 15;     // already-read, still-active emails
const MAX_SNIPPET = 220;

/** PT slots used solely for push gating (digest data itself refreshes
 *  every 2h independently of these). */
const PUSH_SLOTS_PT = [9, 15, 21] as const;

export interface EmailDigest {
  generated_at: number;
  primary: string;
  track: string;
  news: string;
  review: string;
  email_count: number;
  review_count: number;
  /** 2-3 sentence Chinese push notification summary. "" if nothing actionable. */
  push_summary: string;
}

export function getEmailDigest(): EmailDigest | null {
  const raw = getAppState("email_digest");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EmailDigest;
    if (typeof parsed.generated_at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Stale = (≥ STALE_INTERVAL_SEC since last gen) AND (a non-junk email
 * arrived after last gen). Idle inboxes never go stale; busy inboxes
 * regenerate at most every 2h.
 *
 * Why a SQL max(received_at) check instead of a hash: avoids the same trap
 * we fixed in briefings (commit 105bdaf) — hash invalidates when user
 * READS an email (id-set changes), triggering spurious LLM spawns. We only
 * care if NEW MAIL arrived.
 *
 * Why exclude cat_junk: digest source pool already excludes junk in
 * fetchCategoriedEmails, so a junk-only arrival cannot change digest output.
 * Without this filter, a stale window whose ONLY new arrival was a junk
 * email triggered a regen producing byte-identical content. Junk is ~13%
 * of arrivals, so the savings are modest but the regens are pure waste.
 */
export function isEmailDigestStale(d: EmailDigest | null = getEmailDigest()): boolean {
  if (!d) return true;
  const now = Math.floor(Date.now() / 1000);
  if (now - d.generated_at < STALE_INTERVAL_SEC) return false;
  const row = db.prepare(
    "SELECT MAX(received_at) AS mx FROM emails WHERE COALESCE(category_id,'') != 'cat_junk'",
  ).get() as { mx: number | null };
  const maxRecv = row?.mx ?? 0;
  return maxRecv > d.generated_at;
}

/* ── PT slot math (used only for push gating now) ───────────── */

function getPtParts(d: Date): { y: number; m: number; d: number; h: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") };
}

// Convert a Pacific wall-clock (y/m/d/hour) to a UTC epoch. DST-safe:
// format a tentative UTC guess back in PT, measure the delta, correct.
function ptWallClockToEpochSec(y: number, m: number, d: number, hour: number): number {
  const tentative = Date.UTC(y, m - 1, d, hour, 0, 0);
  const actual = getPtParts(new Date(tentative));
  const actualMs = Date.UTC(actual.y, actual.m - 1, actual.d, actual.h);
  const wantedMs = Date.UTC(y, m - 1, d, hour);
  return Math.floor((tentative + (wantedMs - actualMs)) / 1000);
}

/** Epoch seconds of the most recent 9/15/21 PT slot <= now. Used by push gate. */
function lastPushSlotSec(nowSec = Math.floor(Date.now() / 1000)): number {
  const pt = getPtParts(new Date(nowSec * 1000));
  for (const h of [...PUSH_SLOTS_PT].reverse()) {
    if (pt.h >= h) return ptWallClockToEpochSec(pt.y, pt.m, pt.d, h);
  }
  // Before 09:00 PT → yesterday's 21:00 PT. Decrement the PT calendar day
  // directly (Date.UTC normalizes month/year rollover); do NOT subtract
  // 24h from a UTC timestamp, which would shift by the PT offset first.
  const prev = new Date(Date.UTC(pt.y, pt.m - 1, pt.d - 1));
  return ptWallClockToEpochSec(
    prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 21
  );
}

/* ── prompt ───────────────────────────────────────────────── */

function formatEmailLine(e: EmailRow): string {
  // Strip inline quoted-reply history before feeding to LLM. snippet is
  // usually 50 chars and falls in the new-content zone, but terse replies
  // ("ok thanks\n> On Apr 20...") can leak quote into the snippet. Apply
  // strip to both candidates — cheap, and catches both paths.
  const raw = e.snippet || stripQuotedReply(e.body || "");
  const snippet = stripQuotedReply(raw).replace(/\s+/g, " ").slice(0, MAX_SNIPPET);
  const threadHint = e.thread_size && e.thread_size > 1 ? ` (${e.thread_size}-msg thread)` : "";
  return `- ${e.date} · ${e.from_name}: ${e.subject}${threadHint} — ${snippet}`;
}

function buildPrompt(grouped: { primary: EmailRow[]; track: EmailRow[]; news: EmailRow[]; review: EmailRow[] }): string {
  const cap = (label: string) =>
    label === "primary" ? MAX_PRIMARY
    : label === "track" ? MAX_TRACK
    : label === "news" ? MAX_NEWS
    : MAX_REVIEW;
  const sec = (label: "primary" | "track" | "news" | "review", rows: EmailRow[]) =>
    rows.length === 0
      ? `(nothing)`
      : rows.slice(0, cap(label)).map(formatEmailLine).join("\n");

  // Prompt design notes:
  // - Format is ONE dense paragraph per section, not bullets. Bullets felt
  //   choppy + repeated context per item; a paragraph chains facts with
  //   commas, preserving readability while raising info density.
  // - Per-category shape differs:
  //     Primary / Review = specific narrative (name senders, actions, dates)
  //     Track / News     = aggregated count ("You got N X, M Y")
  //   This matches how a user actually scans those sections — Primary needs
  //   detail because it represents real interactions; Track/News only need
  //   "what types and how many" since they're systems.
  // - Density bans: cut "has sent", "regarding", "various", "wanted to
  //   share", "is prompting you to", "noting", "in order to". Strong verbs
  //   only (locked, flagged, requested, scheduled, posted, cleared).
  // - Acronyms: UCI / OPT / CPT / course codes (COURSE 101)
  //   allowed. NEVER invent "Intl" / "Ctr" / "Mgmt" — these confused the
  //   user previously.
  return `Inbox lines (one per email):

<emails>
=== Primary (unread, ${grouped.primary.length}) ===
${sec("primary", grouped.primary)}

=== Track (unread, ${grouped.track.length}) ===
${sec("track", grouped.track)}

=== News (unread, ${grouped.news.length}) ===
${sec("news", grouped.news)}

=== Review (already read, still active, ${grouped.review.length}) ===
${sec("review", grouped.review)}
</emails>

TASK: For each section output ONE dense English paragraph (NOT bullets, NOT a list). Maximum density — every word must carry information.

PER-SECTION SHAPE:
- "primary" / "review" — SPECIFIC. Name senders, concrete actions, key dates. Strong verbs (locked, flagged, requested, scheduled). Chain facts with commas. Example: "Company A's recruiter Dana locked the Monday April 27 1:45pm interview, Advisor Lee requested your signed form, Professor Kim flagged the project checklist ahead of the visit."
- "track" / "news" — AGGREGATE.
  - When items cluster by type (multiple of the same kind): "You got N <type>, M <type>, ...". Example track: "You got 2 bank notifications, 1 Analytics Club registration, and 1 COURSE 101 grade post."
  - When EVERY item is unique (each would be count=1): collapse into "You got N <super-type>: <terse item 1>, <terse item 2>, ...". DO NOT enumerate "1 X, 1 Y, 1 Z" — verbose, forbidden. Example news: "You got 5 UCI campus updates: Graduate Division dean's note, Counseling Center newsletter, Giving Day results, UC Irvine Digest, and International Center summer travel reminders."
  - Each item in the terse list ≤ 8 words. Drop full sender names + dates if they don't add scanning value.

PRESERVE VERBATIM: dates, times, $ amounts, course codes (COURSE 101), person first names, locations, OTPs.

DROP: filler ("has sent", "regarding", "various", "wanted to share", "is prompting you to", "noting", "would like to inform you that"); auto-replies; bare "thanks"; redundant confirmations.

ALLOWED ACRONYMS: UCI, OPT, CPT, and course codes. NEVER invent contractions like "Intl", "Ctr", "Mgmt".

EMPTY SECTIONS: if a section has nothing to surface, return "(No activity)".

GOOD primary: "Company A's mentor Sam cancelled Friday's project meeting, Advisor Lee confirmed she has your forms, Recruiter Dana sent a post-interview thank-you."
GOOD track (clustered): "You got 2 COURSE 101 grade posts, 2 bank notifications (transfer cleared + April statement), and 1 payment deadline reminder."
GOOD track (all unique): "You got 4 system updates: COURSE 101 grade post, bank transfer cleared, utility bill, and payment deadline."
GOOD news (clustered): "You got 3 COURSE 101 announcements and 2 UCI PD campus alerts."
GOOD news (all unique): "You got 5 UCI campus updates: Graduate Division dean's note, Counseling Center newsletter, Giving Day results, UC Irvine Digest, and International Center summer travel reminders."

BAD (DO NOT WRITE LIKE THIS):
- "Recruiter Dana at Company A sent a thank-you following your analyst interview, noting you were a good sport — the interview has clearly concluded, so watch for next steps."
- Bullets / lists / line breaks within a section value.

Output JSON only:

{
  "primary": "<paragraph>",
  "track":   "<paragraph>",
  "news":    "<paragraph>",
  "review":  "<paragraph>",
  "push_summary": "付款 4/29 截止；Company A 面试已结束等通知；Advisor Lee 在跟进表格"
}

CRITICAL JSON ESCAPING — must JSON.parse() cleanly:
- NEVER write a literal " inside any string value. Email subjects, event names, anything quotable → use single quotes 'like this', Chinese 「」, or just drop the quotes entirely.
- WRONG: "track": "...invite for "My Meeting" today..."   ← bare " breaks the parser
- RIGHT: "track": "...invite for 'My Meeting' today..."   (single quotes)
- RIGHT: "track": "...invite for My Meeting today..."     (no quotes — usually cleaner)
- Same goes for nested apostrophes — apostrophes (') are safe to use freely. Only " is forbidden inside string values.
- If you violate this, the digest fails to parse, the user misses the push notification, and a stale digest gets shown on the dashboard.

\`push_summary\`: 2-3 short Chinese sentences for phone lock screen — action-required only (reply needed, deadline this week, OTP, interview, bill). Semicolons between items. Skip newsletters. If nothing actionable, "".`;
}

/* ── generation ───────────────────────────────────────────── */

function fetchCategoriedEmails(): { primary: EmailRow[]; track: EmailRow[]; news: EmailRow[]; review: EmailRow[] } {
  // Thread dedup: a 5-email back-and-forth used to occupy 5 of Primary's 30
  // slots, and Sonnet tended to write 5 bullets about one conversation.
  // ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY received_at DESC)
  // keeps only the latest email per thread; thread_size surfaces the thread
  // length to the prompt so Sonnet writes one summary bullet with a hint.
  // COALESCE(NULLIF(thread_id,''), id) — emails without a thread_id (cold
  // sends) partition by their own id so they're never grouped with each other.
  const unread = db.prepare(
    `WITH ranked AS (
       SELECT *,
         ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(thread_id,''), id) ORDER BY received_at DESC) AS rn,
         COUNT(*)    OVER (PARTITION BY COALESCE(NULLIF(thread_id,''), id)) AS thread_size
       FROM emails
       WHERE received_at > unixepoch() - ?
         AND is_unread = 1
         AND category_id IN ('cat_primary','cat_track','cat_news')
     )
     SELECT * FROM ranked WHERE rn = 1 ORDER BY received_at DESC`
  ).all(LOOKBACK_SEC) as EmailRow[];

  // Section 4 (Review): already-read emails that still have an active time
  // or action signal. Per docs/presentations/importance-signals.md, the
  // 5 signals are:
  //   1. emails.primary_until > now             (TTL not expired)
  //   2. events.start_ts > now                  (future event linked)
  //   3. applications.current_stage active      (interview / offer phase)
  //   4. job_emails.needs_action + deadline > now
  //   5. category_id = cat_primary AND received_at > 48h  (recent real human)
  // Read-side guard: is_unread = 0 AND category_id != cat_junk.
  // Thread-dedup applied in a second CTE so signals can come from any email
  // in the thread (e.g. event on email #2) but we only surface email #5.
  const review = db.prepare(
    `WITH candidates AS (
       SELECT DISTINCT e.*
       FROM emails e
       LEFT JOIN events ev      ON ev.email_id = e.id
       LEFT JOIN job_emails je  ON je.email_id = e.id
       LEFT JOIN applications a ON a.id = je.application_id
       WHERE e.is_unread = 0
         AND (e.category_id IS NULL OR e.category_id != 'cat_junk')
         AND (
           (e.primary_until IS NOT NULL AND e.primary_until > unixepoch())
           OR (ev.start_ts IS NOT NULL AND ev.start_ts > unixepoch())
           OR (a.current_stage IN ('interview_scheduled','interviewed','offer'))
           OR (je.needs_action = 1 AND je.deadline IS NOT NULL AND je.deadline > unixepoch())
           OR (e.category_id = 'cat_primary' AND e.received_at > unixepoch() - ?)
         )
     ),
     ranked AS (
       SELECT *,
         ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(thread_id,''), id) ORDER BY received_at DESC) AS rn,
         COUNT(*)    OVER (PARTITION BY COALESCE(NULLIF(thread_id,''), id)) AS thread_size
       FROM candidates
     )
     SELECT * FROM ranked WHERE rn = 1
     ORDER BY received_at DESC
     LIMIT ?`
  ).all(LOOKBACK_SEC, MAX_REVIEW) as EmailRow[];

  return {
    primary: unread.filter((e) => e.category_id === "cat_primary"),
    track:   unread.filter((e) => e.category_id === "cat_track"),
    news:    unread.filter((e) => e.category_id === "cat_news"),
    review,
  };
}

// System prompt used in addition to the per-call user prompt. The four section
// values are single dense paragraphs (NOT bullets, NOT arrays). Density >
// length — every word must carry information.
const SYSTEM_PROMPT = `You produce structured JSON for an inbox digest. The four section values (primary, track, news, review) are single dense English paragraphs — NOT bullets, NOT lists, NOT JSON arrays. Maximum information density: cut filler ("has sent", "regarding", "various"), use strong verbs, chain facts with commas. If a section has nothing worth surfacing, return "(No activity)". Do not wrap output in code fences. Begin response with { and end with }.`;

// Use --system-prompt (full replacement) NOT --append-system-prompt: the
// latter appends to Claude Code's lengthy default system prompt, which
// drowns out the format directive. Full replacement gives the model exactly
// one role description: "JSON digest writer".
async function runDigestModel(prompt: string, timeoutMs = 120_000): Promise<string> {
  const { text } = await runClaude({
    label: "email-digest",
    prompt,
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    timeoutMs,
  });
  return text;
}

/** Run the LLM and persist. Safe to call even if a previous run is in flight — caller guards. */
export async function generateEmailDigest(): Promise<EmailDigest> {
  const grouped = fetchCategoriedEmails();
  const unreadTotal = grouped.primary.length + grouped.track.length + grouped.news.length;
  const reviewTotal = grouped.review.length;

  // Zero unread + zero review → empty digest, skip Claude call
  if (unreadTotal === 0 && reviewTotal === 0) {
    const empty: EmailDigest = {
      generated_at: Math.floor(Date.now() / 1000),
      primary: "(No activity)",
      track: "(No activity)",
      news: "(No activity)",
      review: "(No activity)",
      email_count: 0,
      review_count: 0,
      push_summary: "",
    };
    setAppState("email_digest", JSON.stringify(empty));
    return empty;
  }

  const prompt = buildPrompt(grouped);
  const raw = await runDigestModel(prompt);
  // Each section value is a single dense paragraph string. We tolerate the
  // legacy array shape (from the previous bullets-era prompt) by joining
  // with ", " — protects against rolled-back PROD seeing fresh model output
  // before the new prompt wins.
  const parsed = parseJsonObject<{
    primary?: string[] | string;
    track?: string[] | string;
    news?: string[] | string;
    review?: string[] | string;
    push_summary?: string;
  }>(raw);
  if (!parsed) {
    // Capture the raw output for inspection — parse failure here usually
    // means Sonnet wrapped JSON in extra prose, hit max-tokens, or emitted
    // multiple JSON blocks. Filename includes timestamp so multiple
    // failures can be diffed.
    try {
      const fs = await import("fs");
      const path = await import("path");
      const debugPath = path.join(os.tmpdir(), `digest-parse-fail-${Date.now()}.txt`);
      fs.writeFileSync(debugPath, raw);
      dlog.error("parse failed", { debugPath, rawLength: raw.length });
    } catch { /* logging best-effort */ }
    throw new Error("email digest: parseJsonObject returned null — LLM output not valid JSON");
  }

  // Coerce to a single paragraph. If Sonnet regresses and emits an array of
  // bullet strings, glue them with ", " into a paragraph rather than render
  // as bullets — the new contract is paragraph-only.
  const toParagraph = (v: unknown): string => {
    if (Array.isArray(v)) {
      const joined = v
        .map((s) => (typeof s === "string" ? s.trim() : String(s).trim()))
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/^[-•*]\s*/, ""))
        .join(", ");
      return joined || "(No activity)";
    }
    if (typeof v === "string") {
      const trimmed = v.trim().replace(/^[-•*]\s*/, "");
      return trimmed || "(No activity)";
    }
    return "(No activity)";
  };

  const digest: EmailDigest = {
    generated_at: Math.floor(Date.now() / 1000),
    primary: toParagraph(parsed.primary),
    track:   toParagraph(parsed.track),
    news:    toParagraph(parsed.news),
    review:  toParagraph(parsed.review),
    email_count: unreadTotal,
    review_count: reviewTotal,
    push_summary: parsed.push_summary?.trim() || "",
  };
  setAppState("email_digest", JSON.stringify(digest));

  // Fire-and-forget push. Failures here must NOT break digest generation —
  // the digest is the user-visible source of truth; push is a nudge.
  if (digest.push_summary && !isDemoMode()) {
    triggerPushIfReady(digest).catch((e) => plog.error("trigger failed", { err: e }));
  }

  return digest;
}

/**
 * Send the digest's push_summary to all subscribed devices, gated on:
 *  - VAPID configured (lib/push.ts isPushConfigured)
 *  - at least one push subscription exists
 *  - non-empty push_summary
 *  - **PT slot gate**: digest data refreshes every 2h, but we push at most
 *    3x/day (9/15/21 PT). Tracked via app_state.push_last_slot_pushed_at.
 *
 * Caller already checked push_summary, but we re-check defensively so
 * direct calls (tests, manual ops) follow the same contract.
 */
async function triggerPushIfReady(digest: EmailDigest): Promise<void> {
  if (!digest.push_summary) return;

  // PT slot gate. Look up most-recent 9/15/21 PT slot; if we already pushed
  // for that slot, skip. Otherwise proceed and update marker after success.
  const slot = lastPushSlotSec();
  const lastPushed = Number(getAppState("push_last_slot_pushed_at") ?? 0);
  if (lastPushed >= slot) {
    plog.info("skipped: already pushed this slot", { slot, lastPushed });
    return;
  }

  // Lazy import: avoid loading web-push at module init (runs in any
  // codepath that imports email-digest, e.g. the Dashboard API route).
  const { sendPushToAll, isPushConfigured } = await import("./push");
  if (!isPushConfigured()) return;
  const { countPushSubscriptions } = await import("./db");
  if (countPushSubscriptions() === 0) return;

  const count = digest.email_count;
  // The OS already shows the app name next to the title; the title carries the count.
  const title = count > 0 ? `${count} new ${count === 1 ? "email" : "emails"}` : "EmailDigest";
  const result = await sendPushToAll({
    title,
    body: digest.push_summary,
    tag: `digest-${slot}`,
    url: "/",
  });
  // Mark slot as pushed only on at-least-one success — failures may retry
  // on the next digest regen within the same slot.
  if (result.sent > 0) {
    setAppState("push_last_slot_pushed_at", String(slot));
  }
  plog.info("send result", { slot, sent: result.sent, failed: result.failed, deleted: result.deleted, total: result.total });
}

/* ── lazy-stale orchestration (in-process lock) ───────────── */

let regenInFlight: Promise<EmailDigest> | null = null;
let lastError: { message: string; at: number } | null = null;

export interface EmailDigestState {
  digest: EmailDigest | null;
  refreshing: boolean;
  error: { message: string; at: number } | null;
}

/**
 * Return the current cached digest (may be null on first run) together
 * with `refreshing` and `error` flags. If stale, triggers an async
 * regeneration and returns the stale copy immediately. On regen failure
 * the error is captured into `lastError` so the UI can stop polling and
 * show a retry button — without this the client would poll forever.
 */
export function ensureEmailDigest(): EmailDigestState {
  const cached = getEmailDigest();
  // DEMO_MODE: a page view must never start a model call (the gateway only
  // counts explicit AI actions). Regeneration happens on POST only.
  const stale = !isDemoMode() && isEmailDigestStale(cached);

  if (stale && !regenInFlight) {
    lastError = null;   // clear prior error on new attempt
    regenInFlight = generateEmailDigest()
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = { message: msg.slice(0, 300), at: Math.floor(Date.now() / 1000) };
        dlog.error("regen failed", { err: e });
        throw e;
      })
      .finally(() => { regenInFlight = null; });
  }

  return {
    digest: cached,
    refreshing: stale || regenInFlight !== null,
    error: lastError,
  };
}

export function clearEmailDigestError() { lastError = null; }
