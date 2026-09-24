"use client";

import { useEffect, useState, useCallback } from "react";

/**
 * Browser-side push subscription state. Wraps:
 *  - SW registration check
 *  - pushManager.getSubscription() / subscribe / unsubscribe
 *  - upstream POST to /api/push/{subscribe,unsubscribe}
 *
 * iOS quirk: even on iOS 16.4+, Notification.requestPermission outside a
 * standalone PWA returns "denied" with no UI. The settings page gates the
 * Enable button on standalone detection so this hook only runs in valid
 * environments.
 */

export interface PushState {
  supported: boolean;          // browser supports Web Push at all
  standalone: boolean;         // running in installed PWA mode
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error: string | null;
}

function urlB64ToUint8(base64: string): ArrayBuffer {
  // Returns a freshly-owned ArrayBuffer so the Uint8Array view satisfies
  // BufferSource = ArrayBufferView<ArrayBuffer> (TS is strict about
  // SharedArrayBuffer vs ArrayBuffer in PushSubscriptionOptions).
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS exposes navigator.standalone; everyone else uses display-mode media.
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const dm = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  return iosStandalone || dm;
}

export function usePushSubscription() {
  const [state, setState] = useState<PushState>({
    supported: false,
    standalone: false,
    permission: "default",
    subscribed: false,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const standalone = detectStandalone();
    const permission: NotificationPermission | "unsupported" = supported ? Notification.permission : "unsupported";

    if (!supported) {
      setState({ supported, standalone, permission, subscribed: false, loading: false, error: null });
      return;
    }

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setState({ supported, standalone, permission, subscribed: !!sub, loading: false, error: null });
    } catch (e) {
      setState({ supported, standalone, permission, subscribed: false, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const subscribe = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // Permission first — must run inside the user gesture click handler.
      if (Notification.permission === "default") {
        const result = await Notification.requestPermission();
        if (result !== "granted") {
          setState((s) => ({ ...s, permission: result, loading: false }));
          return { ok: false, error: `permission ${result}` };
        }
      }
      if (Notification.permission !== "granted") {
        return { ok: false, error: `permission ${Notification.permission}` };
      }

      // Fetch VAPID pubkey from server.
      const keyRes = await fetch("/api/push/vapid-key");
      if (!keyRes.ok) {
        const j = await keyRes.json().catch(() => ({}));
        return { ok: false, error: j.error || `vapid-key ${keyRes.status}` };
      }
      const { publicKey } = await keyRes.json();
      if (!publicKey) return { ok: false, error: "missing VAPID public key" };

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(publicKey),
      });

      const json = sub.toJSON();
      const upRes = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          userAgent: navigator.userAgent,
        }),
      });
      if (!upRes.ok) {
        const j = await upRes.json().catch(() => ({}));
        // Roll back the browser subscription if the server rejected it,
        // otherwise we'd have a ghost sub the server doesn't know about.
        await sub.unsubscribe().catch(() => {});
        return { ok: false, error: j.error || `subscribe ${upRes.status}` };
      }

      await refresh();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, loading: false, error: msg }));
      return { ok: false, error: msg };
    }
  }, [refresh]);

  const unsubscribe = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) { await refresh(); return { ok: true }; }
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
      await refresh();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, loading: false, error: msg }));
      return { ok: false, error: msg };
    }
  }, [refresh]);

  return { ...state, subscribe, unsubscribe, refresh };
}
