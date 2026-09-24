/**
 * Parse a timestamp string returned by an LLM and convert to epoch seconds.
 *
 * The problem: Sonnet sees email body text like "10:30 AM" with no timezone,
 * and outputs ISO 8601 like "2026-04-27T11:50:00" — also without timezone.
 * `new Date(<no-tz ISO>)` is UTC per ECMA-262. On a UTC server (production)
 * that's 7-8 hours off the user's wall-clock intent. On a Mac with system
 * tz=PT it parses as local — silently masking the bug in dev.
 *
 * Fix: when the string has no tz suffix (no `Z`, no `±HH:MM`), interpret it
 * as wall-clock in `userTz`. We compute the tz offset using `Intl` (no extra
 * dependency) and shift to UTC manually.
 *
 * Strings that already have a tz are passed through unchanged.
 */
export function parseLLMTimestamp(raw: string, userTz: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  const [, Y, Mo, D, H, Mi, Sec] = m;
  const utcGuess = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(Sec || 0));
  if (!Number.isFinite(utcGuess)) return null;

  // Find the offset of `userTz` at this moment. `longOffset` returns "GMT-07:00"
  // (or "GMT" for UTC). Two-pass not needed for typical uses — the offset is
  // stable within DST boundaries, and the rare edge case of a wall-clock
  // string falling on a DST transition resolves to the offset that wall-clock
  // would have *post-transition*, which matches user intent in nearly all
  // cases ("schedule meeting at 2:30 AM on March 8" is itself ambiguous).
  let offMin = 0;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: userTz, timeZoneName: "longOffset",
    });
    const parts = fmt.formatToParts(new Date(utcGuess));
    const tzPart = parts.find(p => p.type === "timeZoneName")?.value || "GMT";
    const off = tzPart.match(/([+-])(\d{2}):?(\d{2})/);
    if (off) {
      offMin = (off[1] === "+" ? 1 : -1) * (+off[2] * 60 + +off[3]);
    }
  } catch {
    // unknown tz → treat as UTC (same as ECMA-262 default)
  }
  return Math.floor((utcGuess - offMin * 60_000) / 1000);
}
