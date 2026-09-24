/**
 * Format an email's received-at epoch consistently across the UI, independent
 * of whatever free-text date string the ingest pipeline happened to save.
 *
 *   Today           → "3:45 PM"
 *   Yesterday       → "Yesterday 3:45 PM"
 *   This week       → "Tue 3:45 PM"
 *   This year       → "Apr 15"
 *   Older           → "2024-12-10"
 */
export function formatEmailDate(receivedAtSec: number, fallback = ""): string {
  if (!receivedAtSec || receivedAtSec < 1e9) return fallback;
  const d = new Date(receivedAtSec * 1000);
  const now = new Date();

  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return timeFmt.format(d);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${timeFmt.format(d)}`;

  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400_000);
  if (diffDays >= 0 && diffDays < 7) return `${weekdayFmt.format(d)} ${timeFmt.format(d)}`;

  if (d.getFullYear() === now.getFullYear()) return monthDayFmt.format(d);

  return yyyyMmDd(d);
}

// Fixed to en-US: the UI is English, and the browser default mixed a
// localized weekday ("周一") with the English "Yesterday".
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const monthDayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function yyyyMmDd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
