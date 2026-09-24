import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Email } from "./types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getBadgeVariant(category: string) {
  switch (category) {
    case "assignment": return "destructive" as const;
    case "job": return "default" as const;
    case "academic": return "default" as const;
    default: return "secondary" as const;
  }
}

/**
 * Priority view filter — `cat_primary` emails plus any email whose
 * `primary_until` is still in the future (TTL elevation).
 *
 * Junk is short-circuited so it never reaches Priority/Other/All tabs.
 */
export function isPriority(e: Email, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (e.categoryId === "cat_junk" || e.category === "junk") return false;
  if (e.categoryId === "cat_primary" || e.category === "primary") return true;
  // News is broadcast content — TTL upgrades don't apply (defensive belt to the
  // prefetch.ts write-side block that strips primary_until on cat_news rows).
  if (e.categoryId === "cat_news" || e.category === "news") return false;
  if (e.primaryUntil && e.primaryUntil > nowSec) return true;
  return false;
}

/** Other view filter — non-Priority, non-Junk. */
export function isOther(e: Email): boolean {
  if (e.categoryId === "cat_junk" || e.category === "junk") return false;
  return !isPriority(e);
}
