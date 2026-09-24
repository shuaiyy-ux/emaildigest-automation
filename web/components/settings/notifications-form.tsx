"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, AlertCircle, Check, Smartphone, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushSubscription } from "@/lib/hooks/usePushSubscription";
import { useDemo } from "@/components/demo/demo-context";

interface PushStatus {
  configured: boolean;
  error: string;
  subscriptionCount: number;
  lastSentAt: number | null;
}

function timeAgo(epochSec: number | null): string {
  if (!epochSec) return "—";
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function NotificationsForm() {
  // DEMO_MODE turns web push off on the server (lib/push.ts). That is a
  // setting of the demo, not a fault, so it gets a neutral note instead of
  // the red "not configured" banner, and the device-setup hints are skipped.
  const demo = useDemo();
  const push = usePushSubscription();
  const [serverStatus, setServerStatus] = useState<PushStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetch("/api/push/status")
      .then((r) => r.json())
      .then((d: PushStatus) => setServerStatus(d))
      .finally(() => setStatusLoading(false));
  }, [push.subscribed]);

  const refreshServerStatus = () =>
    fetch("/api/push/status").then((r) => r.json()).then((d) => setServerStatus(d)).catch(() => {});

  const handleEnable = async () => {
    setActionMsg(null);
    const r = await push.subscribe();
    if (r.ok) { setActionMsg({ kind: "ok", text: "Notifications on" }); refreshServerStatus(); }
    else setActionMsg({ kind: "err", text: r.error || "Enable failed" });
  };

  const handleDisable = async () => {
    setActionMsg(null);
    const r = await push.unsubscribe();
    if (r.ok) { setActionMsg({ kind: "ok", text: "Notifications off" }); refreshServerStatus(); }
    else setActionMsg({ kind: "err", text: r.error || "Disable failed" });
  };

  const handleTest = async () => {
    setTesting(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg({ kind: "err", text: data.error || `Test failed. HTTP ${res.status}` });
      } else {
        setActionMsg({ kind: "ok", text: `Sent to ${data.sent} devices, ${data.failed} failed, ${data.deleted} expired removed` });
        refreshServerStatus();
      }
    } finally {
      setTesting(false);
    }
  };

  const ios = isIOS();
  const iosNeedsInstall = !demo && ios && !push.standalone;
  const vapidMissing = serverStatus && !serverStatus.configured;

  return (
    <div className="space-y-5">

      {/* Demo: push is switched off on purpose */}
      {demo && (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5 text-sm text-muted-foreground flex gap-2 items-center">
          <BellOff className="h-4 w-4 shrink-0" />
          Push notifications are off in this demo.
        </div>
      )}

      {/* Server config banner: VAPID keys missing */}
      {!demo && !statusLoading && vapidMissing && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300 flex gap-2 items-start">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">Push is not configured on the server</div>
            <div className="text-xs opacity-90">
              Add <code className="text-[11px]">VAPID_PUBLIC_KEY</code>, <code className="text-[11px]">VAPID_PRIVATE_KEY</code> and <code className="text-[11px]">VAPID_SUBJECT</code> to <code className="text-[11px]">.env.local</code>, then restart.
            </div>
            {serverStatus.error && <div className="text-xs font-mono opacity-70">{serverStatus.error}</div>}
          </div>
        </div>
      )}

      {/* iOS hard gate */}
      {iosNeedsInstall && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200 flex gap-2 items-start">
          <Smartphone className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">On iOS, add EmailDigest to the Home Screen first</div>
            <div className="text-xs opacity-90">
              Safari tabs cannot receive push. Tap Share, choose Add to Home Screen, open EmailDigest from the Home Screen, then turn notifications on here.
            </div>
          </div>
        </div>
      )}

      {/* Browser support fallback */}
      {!demo && !push.supported && (
        <div className="rounded-md border border-zinc-500/30 bg-zinc-500/10 px-3 py-2.5 text-sm text-zinc-300">
          This browser does not support push notifications.
        </div>
      )}

      {/* Permission denied */}
      {!demo && push.permission === "denied" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200 flex gap-2 items-start">
          <BellOff className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-xs">
            Notifications are blocked. Allow them for EmailDigest in the system Settings app, under Notifications.
          </div>
        </div>
      )}

      {/* Main toggle */}
      <div className="rounded-md border border-border/60 bg-card/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            {push.subscribed ? <Bell className="h-4 w-4 text-emerald-400" /> : <BellOff className="h-4 w-4 text-muted-foreground" />}
            <span className="text-sm font-medium">Push notifications</span>
            {push.subscribed && <span className="text-[11px] text-emerald-400 px-1.5 py-0.5 rounded bg-emerald-500/10">On</span>}
          </div>
          <div className="shrink-0">
            {push.subscribed ? (
              <Button variant="outline" size="sm" onClick={handleDisable} disabled={push.loading}>
                {push.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disable"}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleEnable}
                disabled={demo || push.loading || !push.supported || iosNeedsInstall || vapidMissing || push.permission === "denied"}
              >
                {push.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Enable"}
              </Button>
            )}
          </div>
        </div>

        {/* Test button, only meaningful when subscribed */}
        {push.subscribed && (
          <div className="mt-3 pt-3 border-t border-border/40 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
              Send test notification
            </Button>
            <span className="text-xs text-muted-foreground">
              Hidden while the app is in the foreground
            </span>
          </div>
        )}
      </div>

      {/* Action result */}
      {actionMsg && (
        <div className={`text-xs flex items-center gap-1.5 ${actionMsg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
          {actionMsg.kind === "ok" ? <Check className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {actionMsg.text}
        </div>
      )}

      {/* Stats */}
      {!statusLoading && serverStatus && (
        <div className="rounded-md border border-border/60 bg-card/20 p-4 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subscribed devices</span>
            <span className="tabular-nums">{serverStatus.subscriptionCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last push</span>
            <span className="tabular-nums">{timeAgo(serverStatus.lastSentAt)}</span>
          </div>
          {/* Demo: the note at the top already says push is off */}
          {!demo && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Server setup</span>
              <span className={serverStatus.configured ? "text-emerald-400" : "text-red-400"}>
                {serverStatus.configured ? "Configured" : "Not configured"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
