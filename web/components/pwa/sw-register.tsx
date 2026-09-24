"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js once on mount. Idempotent — the browser dedupes
 * registrations against the existing one. Failures are non-fatal (no SW =
 * no PWA install prompt + no push, but the app still runs).
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((e) => console.error("[sw] register failed:", e));
  }, []);
  return null;
}
