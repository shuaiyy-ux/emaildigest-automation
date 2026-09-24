"use client";

import { useEffect, useState } from "react";
import { Smartphone, X } from "lucide-react";
import { useDemo } from "@/components/demo/demo-context";

const STORAGE_KEY = "pwa-install-dismissed";

/**
 * Soft banner shown to iOS Safari users (browser, not standalone) on
 * Dashboard. Tells them how to add to home screen — required for Web Push
 * to work on iOS. Dismissible; localStorage persists across reloads.
 *
 * Render only when ALL conditions are true:
 *  - mounted (avoid SSR mismatch)
 *  - mobile viewport
 *  - iOS UA (Android has its own native install prompt)
 *  - NOT currently in standalone PWA mode
 *  - user hasn't dismissed before
 *  - not DEMO_MODE (web push is off there, so the hint would promise nothing)
 */
export function InstallHint({ mobile }: { mobile: boolean }) {
  const demo = useDemo();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!mobile || demo) return;
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!isIOS) return;
    const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    const dmStandalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    if (iosStandalone || dmStandalone) return;
    if (window.localStorage?.getItem(STORAGE_KEY)) return;
    setShow(true);
  }, [mobile, demo]);

  if (!show) return null;

  const dismiss = () => {
    try { window.localStorage?.setItem(STORAGE_KEY, "1"); } catch { /* ignore quota */ }
    setShow(false);
  };

  return (
    <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-amber-100 text-sm flex items-start gap-2">
      <Smartphone className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="font-medium">Add to Home Screen for digest notifications</div>
        <div className="text-xs opacity-90 leading-relaxed">
          In Safari, tap Share, then Add to Home Screen. Open EmailDigest from the Home Screen and turn push on in Notifications.
        </div>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 p-1 -m-1 rounded hover:bg-amber-500/20 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
