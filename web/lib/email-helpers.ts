/**
 * Display + visual helpers for inbox list rows. UI-only — no DB / network.
 */

const DOMAIN_NOISE_PREFIX = /^(email|mail|mailer|notifications?|no-?reply|alerts?|info|updates?|news)\./i;

/**
 * Friendly sender label.
 *   "Aaron Smith" + "aaron@x.com"  → "Aaron Smith"
 *   "" + "no-reply@agency.example.gov" → "agency.example.gov"
 *   "noreply@x.com" + same         → "x.com"
 *   "" + ""                        → "(unknown)"
 */
export function displayFromName(from: string, fromEmail?: string): string {
  const f = (from || "").trim();
  const e = (fromEmail || "").trim().toLowerCase();
  if (f && f.toLowerCase() !== e) return f;
  if (!e) return f || "(unknown)";
  const at = e.indexOf("@");
  const domain = at >= 0 ? e.slice(at + 1) : e;
  return domain.replace(DOMAIN_NOISE_PREFIX, "");
}

/** Single-letter avatar initial. Uses display name first, falls back to email. */
export function senderInitial(from: string, fromEmail?: string): string {
  const label = displayFromName(from, fromEmail);
  const first = label.replace(/[^A-Za-z0-9]/g, "")[0];
  return (first || "?").toUpperCase();
}

const AVATAR_PALETTE = [
  "bg-rose-500/85",
  "bg-orange-500/85",
  "bg-amber-500/85",
  "bg-lime-500/85",
  "bg-teal-500/85",
  "bg-sky-500/85",
  "bg-violet-500/85",
  "bg-pink-500/85",
];

/** Deterministic background color class — same sender always gets same color. */
export function senderColorClass(fromEmail?: string): string {
  const key = (fromEmail || "?").toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash + key.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

/** Tiny color dot indicating category. Returns Tailwind bg-* class. */
export function categoryDotClass(categoryId?: string | null, categoryLegacy?: string): string {
  const id = categoryId || (categoryLegacy ? `cat_${categoryLegacy}` : "");
  switch (id) {
    case "cat_primary": return "bg-blue-500";
    case "cat_track":   return "bg-emerald-500";
    case "cat_news":    return "bg-zinc-500";
    case "cat_junk":    return "bg-amber-500";
    default:            return "bg-zinc-700";
  }
}

/** Small text pill class for category display. Themed by category. */
export function categoryPillClass(categoryId?: string | null, categoryLegacy?: string): string {
  const id = categoryId || (categoryLegacy ? `cat_${categoryLegacy}` : "");
  switch (id) {
    case "cat_primary": return "bg-blue-500/15 text-blue-300 border-blue-500/30";
    case "cat_track":   return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "cat_news":    return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
    case "cat_junk":    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    default:            return "bg-zinc-700/30 text-zinc-400 border-zinc-700/40";
  }
}

/** Display label for category pill. */
export function categoryLabel(categoryId?: string | null, categoryLegacy?: string): string {
  const id = categoryId || (categoryLegacy ? `cat_${categoryLegacy}` : "");
  switch (id) {
    case "cat_primary": return "Primary";
    case "cat_track":   return "Track";
    case "cat_news":    return "News";
    case "cat_junk":    return "Junk";
    default:            return categoryLegacy || "";
  }
}
