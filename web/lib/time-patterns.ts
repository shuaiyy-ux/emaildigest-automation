/**
 * Shared date/time regex constants.
 *
 * One source of truth for "does this text mention a date/time?" — consumed by:
 *   - lib/time-signal.ts        (event_extractor gate: "worth asking LLM?")
 *   - lib/ttl-rules.ts          (TTL Rule 3 / deadline parser)
 *
 * Rationale: without this shared module, the two systems each kept their own
 * regex. When one side added a pattern (e.g. ISO `YYYY-MM-DD`), the other
 * silently diverged, producing inconsistent behavior ("TTL pills it but
 * event_extractor ignores it", or vice versa). See gleaming-jumping-bentley
 * plan for the full architecture rationale.
 *
 * Do NOT add weekday-only patterns (`Mon`, `Thu`) here — they match noise
 * substrings like "mon" or "Thu" out of context and caused 3-10 day date drift
 * in local validation. Weekday matching belongs to full date parsing (ttl-rules
 * parseDateClause), not to the "is this a date?" gate.
 */

// Clock times: "3:30pm" / "11 AM" / "noon" / "midnight"
export const TIME_RE =
  /\b(\d{1,2}:\d{2}\s*(am|pm|AM|PM)?|\d{1,2}\s*(am|pm|AM|PM)\b|noon|midnight)\b/;

// Numeric dates: "4/29" / "04/29/2026" / "2026-04-29"
export const EXPLICIT_DATE_RE =
  /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/;

// Month name + day: "April 27th", "Apr 27", "May 5, 2026"
export const MONTH_DAY_RE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)(uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\s+\d{1,2}(st|nd|rd|th)?\b/i;

// Chinese date markers: "4月27日" / "下午3点" / "截止" etc.
export const CHINESE_DATE_RE =
  /(\d+月\d+[日号]|\d+[点时]\d*分?|[上下]午\s*\d+|截止|截至|截单|前截|号前|日前)/;
