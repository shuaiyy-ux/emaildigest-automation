/**
 * TTL rules — deterministic extraction of "valid until" timestamps from email
 * text. Runs on every email regardless of Inbox classification path (MiniLM
 * confident or LLM escalated), orthogonal to category decision.
 *
 * NOT a classifier: does not decide which bucket the email belongs to.
 * Only answers "is there a time-sensitive claim inside this email, and if so
 * when does it expire?". Returns epoch seconds or null. The email's
 * category_id is set by MiniLM/LLM; primary_until is the temporary
 * promotion-to-Primary timer driven by this file.
 *
 * Four high-value rules, ordered by precision:
 *   1a. Strict auth code: 4-8 digit near "verification / verify / OTP / 2FA /
 *       one-time code / passcode"  → anchor + 30 minutes
 *   1b. Pickup/bill:     subject/body contains "package / locker / bill /
 *       invoice / payment due / overdue"  → anchor + 24 hours (or Rule 3 date
 *       if also present — explicit deadline beats the 24h default)
 *   2.  Same-day urgency: "expires today / last chance / final reminder / EOD"
 *       → today 23:59 (local)
 *   3.  Explicit date:   "due Oct 15 / deadline Friday / by Nov 3 2026"
 *       → parsed date at end-of-day
 *
 * Why 1a and 1b are separate:
 * The old single Rule 1 used a wide trigger set (security/access/login/code)
 * and a fixed 30-minute window. That caught real OTP codes but also fired on
 * package pickup codes, bill account numbers, and security update notices,
 * where the 30-minute window disappeared long before the actual deadline
 * (packages typically 1 day, bills longer). Splitting by intent gives each
 * class the right window.
 *
 * clampTtl enforces a 7-day upper bound to prevent runaway Primary promotions
 * from bad parses.
 */

export interface TtlContext {
  subject: string;
  body: string;
  receivedAt: number;  // epoch seconds
}

const MAX_TTL_DAYS = 7;
const MIN_TTL_MINUTES = 5;

// ── Rule 1a: Strict auth code (30 min) ──────────────────────────────────
// Narrow — only words that unambiguously refer to a real-time authentication
// token. Old version matched `security|access|login|sign-in|code|pin` which
// fired on package pickup codes, bill account numbers, and security-update
// notices, giving them a 30-min window that was far too short for the real
// use case (see Rule 1b).
const VERIFY_STRICT_RE =
  /(?:verification|verify|one[-\s]?time\s+code|authentication\s+code|2FA|OTP|passcode)[\s\S]{0,80}?\b\d{4,8}\b|\b\d{4,8}\b[\s\S]{0,40}(?:verification|verify|one[-\s]?time\s+code|authentication\s+code|2FA|OTP|passcode)/i;

// ── Rule 1b: Pickup / bill (24h) ────────────────────────────────────────
// Physical-delivery pickups and financial statements. Users have a real
// action deadline but the email usually doesn't include a precise time,
// so we use a 24-hour default. If Rule 3 also matches (explicit "due May
// 15"), Rule 3 wins because it's more precise.
const PICKUP_BILL_RE =
  /\b(pick[-\s]?up|package|parcel|locker|delivery|shipment|tracking|bill|invoice|statement|payment\s+due|amount\s+due|balance\s+due|overdue|past\s+due)\b/i;

// ── Rule 2: Same-day urgency ────────────────────────────────────────────
const SAME_DAY_RE =
  /\b(?:expires?\s+today|today\s+only|ends?\s+today|last\s+chance|final\s+reminder|final\s+notice|due\s+today|action\s+required\s+today|by\s+(?:end\s+of\s+day|eod|midnight)|ASAP)\b/i;

// ── Rule 3: Explicit date (English + basic Chinese) ─────────────────────
const MONTH_RE =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE =
  "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)";

const DEADLINE_RE = new RegExp(
  "\\b(?:due|deadline|expires?|expire\\s+on|closes?\\s+(?:on|at)?|submit(?:ted)?\\s+by|rsvp\\s+by|respond\\s+by|apply\\s+by|complete\\s+by|close\\s+of\\s+business|EOB|EOD|no\\s+later\\s+than)\\s+" +
    "(?:(?:on\\s+)?(?:" + WEEKDAY_RE + "|tomorrow|tonight|today)|" +
    "(?:" + MONTH_RE + "\\s+\\d{1,2}(?:,?\\s+\\d{4})?)|" +
    "(\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?))",
  "i"
);

// ── Weekday / relative helpers ──────────────────────────────────────────
const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 0, 0);
  return d;
}

function nextWeekday(anchor: Date, weekday: number): Date {
  const d = new Date(anchor);
  const cur = d.getDay();
  let diff = weekday - cur;
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return endOfDay(d);
}

function parseDateClause(clause: string, anchor: Date): Date | null {
  const s = clause.trim().toLowerCase();

  // today / tonight / tomorrow
  if (/^today|tonight$/.test(s)) return endOfDay(anchor);
  if (/^tomorrow$/.test(s)) {
    const d = new Date(anchor); d.setDate(d.getDate() + 1);
    return endOfDay(d);
  }

  // weekday
  const wd = WEEKDAY_INDEX[s];
  if (wd !== undefined) return nextWeekday(anchor, wd);

  // "Oct 15" / "October 15, 2026"
  const monthMatch = s.match(new RegExp("^(" + MONTH_RE + ")\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$", "i"));
  if (monthMatch) {
    const month = MONTH_INDEX[monthMatch[1].toLowerCase()];
    const day = parseInt(monthMatch[2]);
    let year = monthMatch[3] ? parseInt(monthMatch[3]) : anchor.getFullYear();
    if (month === undefined || Number.isNaN(day)) return null;
    let d = new Date(year, month, day);
    if (d < anchor && !monthMatch[3]) {
      // bare month-day earlier than anchor → roll to next year
      year += 1;
      d = new Date(year, month, day);
    }
    return endOfDay(d);
  }

  // "10/15" or "10/15/26"
  const numMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (numMatch) {
    const m = parseInt(numMatch[1]) - 1;
    const day = parseInt(numMatch[2]);
    let year = numMatch[3]
      ? (numMatch[3].length === 2 ? 2000 + parseInt(numMatch[3]) : parseInt(numMatch[3]))
      : anchor.getFullYear();
    if (m < 0 || m > 11 || day < 1 || day > 31) return null;
    let d = new Date(year, m, day);
    if (d < anchor && !numMatch[3]) {
      year += 1;
      d = new Date(year, m, day);
    }
    return endOfDay(d);
  }

  return null;
}

function clampTtl(ts: number, anchorSec: number): number | null {
  const maxTs = anchorSec + MAX_TTL_DAYS * 86400;
  const minTs = anchorSec + MIN_TTL_MINUTES * 60;
  if (ts > maxTs) return maxTs;
  if (ts < minTs) return null;  // already expired / too soon to matter
  return ts;
}

// Rule 3 extracted as a helper so Rule 1b can consult it (explicit date in a
// pickup/bill email should preempt the 24-hour default).
function tryRule3(text: string, anchor: Date, anchorSec: number): number | null {
  const m = text.match(DEADLINE_RE);
  if (!m) return null;
  const fullMatch = m[0];
  const kwMatch = fullMatch.match(/^(?:due|deadline|expires?|expire\s+on|closes?\s+(?:on|at)?|submit(?:ted)?\s+by|rsvp\s+by|respond\s+by|apply\s+by|complete\s+by|close\s+of\s+business|EOB|EOD|no\s+later\s+than)\s+(?:on\s+)?(.+)$/i);
  if (!kwMatch) return null;
  const parsed = parseDateClause(kwMatch[1], anchor);
  if (!parsed) return null;
  return clampTtl(Math.floor(parsed.getTime() / 1000), anchorSec);
}

/**
 * Returns epoch seconds when the Primary promotion should expire, or null
 * if the email has no time-sensitive claim. Deterministic, idempotent.
 *
 * Priority: 1a > 2 > 3 > 1b (most-specific signal wins).
 *   - 1a (OTP/2FA): overrides everything — a code is always 30 min
 *   - 2 (same-day "today"/"ASAP"): more specific than 1b, even if email
 *     is a bill with a "payment due today" phrasing
 *   - 3 (explicit "due Oct 15"): specific date, use it
 *   - 1b (pickup/bill fallback): 24h default when no explicit date was
 *     parsed and no same-day urgency, but the email is still clearly
 *     a pickup / billing notification
 */
export function inferPrimaryUntil(ctx: TtlContext): number | null {
  const anchor = new Date(ctx.receivedAt * 1000);
  const anchorSec = ctx.receivedAt;
  const text = `${ctx.subject}\n${ctx.body || ""}`;

  // Rule 1a: strict auth code — 30 min (most specific, always wins)
  if (VERIFY_STRICT_RE.test(text)) {
    return clampTtl(anchorSec + 30 * 60, anchorSec);
  }

  // Rule 2: same-day urgency — today 23:59 local (specific "today" semantics)
  if (SAME_DAY_RE.test(ctx.subject) || SAME_DAY_RE.test(ctx.body || "")) {
    return clampTtl(Math.floor(endOfDay(anchor).getTime() / 1000), anchorSec);
  }

  // Rule 3: explicit date (parseable "due/deadline/by ...")
  const explicit = tryRule3(text, anchor, anchorSec);
  if (explicit !== null) return explicit;

  // Rule 1b: pickup / bill fallback — 24h default when no date could be
  // extracted but the email is clearly a pickup or billing notification.
  if (PICKUP_BILL_RE.test(text)) {
    return clampTtl(anchorSec + 24 * 3600, anchorSec);
  }

  return null;
}

/**
 * Format remaining TTL as a human-readable hint for UI display.
 * Input: primary_until (epoch sec), now (epoch sec).
 * Returns strings like "Valid for 28m" / "Valid for 3h" / "Valid for 2d".
 * Returns null if expired or no TTL.
 */
export function formatTtlHint(primaryUntil: number | null | undefined, nowSec: number): string | null {
  if (!primaryUntil || primaryUntil <= nowSec) return null;
  const remaining = primaryUntil - nowSec;
  if (remaining < 60) return `Valid for <1m`;
  if (remaining < 3600) return `Valid for ${Math.floor(remaining / 60)}m`;
  if (remaining < 86400) return `Valid for ${Math.floor(remaining / 3600)}h`;
  return `Valid for ${Math.floor(remaining / 86400)}d`;
}
