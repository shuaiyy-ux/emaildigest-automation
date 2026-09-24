/**
 * Event extraction from emails via direct Claude CLI subprocess.
 *
 * Triggering:
 *   Manual only — user clicks /calendar "Scan inbox" button →
 *   /api/events action=scanInbox → extractEventsForBatch().
 *   The earlier auto-extract path in prefetch Step 5 was the dominant
 *   spawn-count contributor and was removed 2026-05-01.
 *
 * Cost-optimized path:
 *   - empty cwd (lib/claude-cli.ts) → skip CLAUDE.md + 7 design-doc auto-load.
 *     Drops cache_creation from ~70K/spawn to ~5K/spawn (~94% reduction).
 *   - --model haiku (4.5) → ~3x cheaper input/output vs Sonnet.
 *   - No MCP, no safety.txt, no inquiry.txt — the prompt is self-contained
 *     (this is a structured-output extraction, not a tool-using task).
 *   - Single batched spawn for all candidates (≤50/scan) instead of
 *     per-email — Anthropic rate limits count requests, not tokens.
 *
 * Combined with the `hasTimeSignal` gate (2-of-3 signals + subject blacklist)
 * the SQL pool typically shrinks to 20-30 candidates per scan.
 *
 * Spawned through lib/claude-cli.ts like every other model call.
 */
import { parseJsonArray } from "./parse";
import type { EmailRow } from "./db";
import { upsertEvent, findEventByNormalizedKey, updateEventFields } from "./db";
import { hasTimeSignal } from "./time-signal";
import { stripQuotedReply } from "./reply-quote";
import { parseLLMTimestamp } from "./parse-time";
import { runClaude } from "./claude-cli";
import crypto from "crypto";

const EVENT_MODEL = process.env.EMAILDIGEST_EVENT_MODEL || "haiku";

// Emergency stop: when set to "1", extractEventsForBatch returns 0 immediately
// without spawning. Use to halt all event-extract LLM calls without code
// changes (e.g. when the Anthropic account is rate-limited or banned).
// Re-enable by removing the env var and restarting the service.
const DISABLED = process.env.EMAILDIGEST_DISABLE_EVENT_EXTRACT === "1";

// Wall-clock timezone for parsing tz-less LLM timestamps. Same default as
// prefetch.ts — see lib/parse-time.ts for the bug this avoids.
const USER_TZ = process.env.EMAILDIGEST_USER_TZ || "America/Los_Angeles";

export interface ExtractedEvent {
  title: string;
  start: string;        // ISO 8601
  end?: string;         // ISO 8601
  allDay?: boolean;
  location?: string;
  rsvpBy?: string;      // ISO 8601
  sourceText?: string;  // the substring of email body the event came from
}

function eventHash(ev: ExtractedEvent): string {
  const key = `${ev.title}|${ev.start}|${ev.location || ""}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/** Normalize an event title for cross-email duplicate detection.
 *  lowercase + strip punctuation + collapse whitespace. Keeps enough signal
 *  that "Faculty Expert Meeting" and "FACULTY EXPERT MEETING" match, but
 *  "A2C Drop-in Help Session" still differs from "A2C Drop-in Session". */
function normalizeEventTitle(s: string): string {
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Epoch seconds → local YYYY-MM-DD. Two extractions of "Apr 27 10:30am" and
 *  "Apr 27 10:35am" for the same meeting collapse to the same startDay. */
function startDayLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Dedup key used to detect "same real-world event from a different email". */
function dedupKey(title: string, startTs: number, location: string): string {
  return `${normalizeEventTitle(title)}|${startDayLocal(startTs)}|${normalizeEventTitle(location || "")}`;
}

function findSpan(body: string, needle: string | undefined): { start: number; end: number } | null {
  if (!needle) return null;
  const idx = body.indexOf(needle);
  if (idx < 0) return null;
  return { start: idx, end: idx + needle.length };
}

function buildBatchPrompt(emails: EmailRow[]): string {
  // stripQuotedReply removes inline quoted-reply history (Outlook From/Sent
  // blocks, Gmail "On X wrote:" tails, `>` quote lines). Without this, the
  // 5th email in a back-and-forth contains 4 prior turns as quoted text
  // → LLM extracts the same event N times across N emails in the thread.
  const blocks = emails.map((e, i) => {
    const body = stripQuotedReply(e.body || "").slice(0, 3000);
    return `[email_${i + 1}] id=${e.id}
From: ${e.from_name} <${e.from_email}>
Subject: ${e.subject}
Received: ${new Date(e.received_at * 1000).toISOString()}
Body:
${body}`;
  }).join("\n\n---\n\n");
  const now = new Date().toISOString();

  return `Extract **real, user-facing scheduled events** from each email below: interviews, assignment/exam deadlines, meetings, lectures, office hours, RSVP deadlines, conference/networking events, presentations.

**Do NOT** extract:
- historical dates already past
- "save the date" in marketing emails
- promotion expiration / discount-end times
- dates in signature blocks (e.g. "Work hours: 7AM-4PM")
- past application confirmations
- validity windows ("address valid through X", "permit good until Y") — these are NOT user deadlines

Now: ${now}

There are ${emails.length} emails below, separated by "---".

${blocks}

Return a strict JSON array (no code fences). One entry per email IN INPUT ORDER. Entries with no events still required, with empty events: [], so caller can map back. Each entry:
{
  "email_id": "<id from header above>",
  "events": [
    {
      "title": "short event name (≤50 chars)",
      "start": "ISO 8601 with timezone (resolve relative dates against email received time)",
      "end": "ISO 8601 (optional; omit if not mentioned)",
      "allDay": false,
      "location": "string (optional; Zoom link / classroom / city)",
      "rsvpBy": "ISO 8601 (optional; RSVP cutoff)",
      "sourceText": "exact body substring where event appears"
    }
  ]
}

Output only the JSON array. No code fences. No commentary.`;
}

/**
 * One tool-less Haiku run via lib/claude-cli.ts (empty cwd, no MCP, prompt
 * on stdin). Resolves with the model's text; rejects on timeout / failure.
 */
async function spawnHaikuExtract(prompt: string, timeoutMs: number): Promise<string> {
  const { text } = await runClaude({
    label: "event-extract",
    prompt,
    model: EVENT_MODEL,
    timeoutMs,
  });
  return text;
}

interface BatchEntry {
  email_id: string;
  events?: ExtractedEvent[];
}

export interface BatchExtractResult {
  inserted: number;
  perEmail: { id: string; n: number }[];
  error?: string;
}

/**
 * Extract events from a batch of emails in a SINGLE Haiku spawn.
 *
 * Reasons for batching (vs. one spawn per email):
 *   - Anthropic rate limits count requests, not tokens. 26 emails = 1 spawn
 *     instead of 26 reduces spawn pressure 26x, the dominant cost driver
 *     after the 2026-04 account ban incident.
 *   - One circuit-breaker record per scan instead of N — failure attribution
 *     stays meaningful.
 *   - Shared prompt overhead (now / instructions) amortized once.
 *
 * Trade-off: batch JSON parse failure loses all N entries. Acceptable —
 * SQL gate keeps the same emails eligible for the next manual scan.
 *
 * Caller (typically /api/events action=scanInbox) is responsible for
 * upstream filtering. We still re-apply hasTimeSignal at the function
 * boundary so external callers (scripts, future API routes) can't bypass
 * the gate.
 */
export async function extractEventsForBatch(
  emails: EmailRow[],
  timeoutMs = 240_000,
): Promise<BatchExtractResult> {
  if (DISABLED) return { inserted: 0, perEmail: [] };

  // Defense in depth: filter at function boundary even if SQL+regex gate
  // already ran. Same invariant as the old per-email path.
  const eligible = emails.filter(
    (e) =>
      e.body &&
      e.body.length >= 20 &&
      hasTimeSignal({ subject: e.subject, body: e.body }),
  );
  if (eligible.length === 0) return { inserted: 0, perEmail: [] };

  let raw: string;
  try {
    raw = await spawnHaikuExtract(buildBatchPrompt(eligible), timeoutMs);
  } catch (e) {
    return { inserted: 0, perEmail: [], error: String(e) };
  }

  const entries = parseJsonArray<BatchEntry>(raw);
  if (!entries || entries.length === 0) {
    return { inserted: 0, perEmail: [], error: "empty or unparseable LLM output" };
  }

  // Build email_id → row lookup so we can correlate even if the LLM
  // shuffles or drops entries (it shouldn't, but defensive).
  const byId = new Map(eligible.map((e) => [e.id, e]));
  let totalInserted = 0;
  const perEmail: { id: string; n: number }[] = [];

  for (const entry of entries) {
    if (!entry?.email_id) continue;
    const email = byId.get(entry.email_id);
    if (!email) continue;  // LLM hallucinated an id not in batch
    const events = Array.isArray(entry.events) ? entry.events : [];

    let inserted = 0;
    for (const ev of events) {
      if (!ev?.title || !ev?.start) continue;
      // LLM returns ISO without tz suffix; on UTC servers raw new Date(...)
      // shifts wall-clock 7-8h. parseLLMTimestamp interprets tz-less strings
      // as user wall-clock (PT). See lib/parse-time.ts.
      const startTs = parseLLMTimestamp(ev.start, USER_TZ);
      if (startTs === null || !Number.isFinite(startTs) || startTs <= 0) continue;
      const endTs = ev.end ? parseLLMTimestamp(ev.end, USER_TZ) : null;
      const rsvpTs = ev.rsvpBy ? parseLLMTimestamp(ev.rsvpBy, USER_TZ) : null;
      const span = findSpan(email.body || "", ev.sourceText);
      const hash = eventHash(ev);
      const title = ev.title.slice(0, 140);
      const location = (ev.location || "").slice(0, 200);
      const endTsFinal = endTs && Number.isFinite(endTs) && endTs > 0 ? endTs : null;
      const rsvpFinal = rsvpTs && Number.isFinite(rsvpTs) && rsvpTs > 0 ? rsvpTs : null;

      // Cross-email dedup: if a previous email already extracted this event
      // (normalized title + local start-day + location), don't insert a new
      // row. Opportunistically merge in any field the earlier row was
      // missing (later email often has more complete details).
      const key = dedupKey(title, startTs, location);
      const existing = findEventByNormalizedKey(
        (r) => dedupKey(r.title, r.start_ts, r.location) === key,
      );
      if (existing) {
        const patch: Parameters<typeof updateEventFields>[1] = {};
        if (!existing.location && location) patch.location = location;
        if (existing.end_ts == null && endTsFinal != null) patch.end_ts = endTsFinal;
        if (existing.rsvp_by == null && rsvpFinal != null) patch.rsvp_by = rsvpFinal;
        if (Object.keys(patch).length > 0) updateEventFields(existing.id, patch);
        continue;
      }

      upsertEvent({
        id: `ev_${email.id.slice(0, 10)}_${hash}`,
        email_id: email.id,
        title,
        start_ts: startTs,
        end_ts: endTsFinal,
        all_day: ev.allDay ? 1 : 0,
        location,
        rsvp_by: rsvpFinal,
        source_start: span?.start ?? null,
        source_end: span?.end ?? null,
        hash,
      });
      inserted++;
    }
    totalInserted += inserted;
    perEmail.push({ id: email.id, n: inserted });
  }

  return { inserted: totalInserted, perEmail };
}
