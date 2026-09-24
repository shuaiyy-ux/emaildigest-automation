/**
 * Web Push (VAPID) — server-side send + config health.
 *
 * Reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT from env on
 * import. If any is missing, sets app_state.push_config_status = 'missing'
 * and sendPushToAll() becomes a no-op. The settings page reads
 * push_config_status to surface a red banner.
 *
 * Failure handling on send:
 *  - 404 / 410  → endpoint is dead, delete the row (it will never recover)
 *  - other      → keep the row but record last_error so the user can see
 *                 why their device stopped getting notifications
 *
 * No retry loop. Push delivery is best-effort by design — the source of
 * truth is still EmailDigest's UI; a missed digest just means the user
 * opens the app to catch up.
 *
 * DEMO_MODE: web push is off entirely — VAPID keys are ignored, nothing is
 * sent, and the settings page shows push as not configured.
 */
import webpush, { type PushSubscription } from "web-push";
import {
  setAppState,
  listPushSubscriptions,
  deletePushSubscriptionByEndpoint,
  recordPushFailure,
  bumpPushLastSeen,
} from "./db";
import { isDemoMode } from "./demo";

const DEMO = isDemoMode();
const PUBLIC_KEY = DEMO ? "" : process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = DEMO ? "" : process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = DEMO ? "" : process.env.VAPID_SUBJECT || "";

let configured = false;
let configError = "";

if (DEMO) {
  configError = "web push is disabled in DEMO_MODE";
  setAppState("push_config_status", "missing");
  setAppState("push_config_error", configError);
} else if (PUBLIC_KEY && PRIVATE_KEY && SUBJECT) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
    setAppState("push_config_status", "ok");
    setAppState("push_config_error", "");
    console.log("[push] config: ok");
  } catch (e) {
    configError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    setAppState("push_config_status", "error");
    setAppState("push_config_error", configError);
    console.error("[push] setVapidDetails failed:", configError);
  }
} else {
  const missing = [
    !PUBLIC_KEY && "VAPID_PUBLIC_KEY",
    !PRIVATE_KEY && "VAPID_PRIVATE_KEY",
    !SUBJECT && "VAPID_SUBJECT",
  ].filter(Boolean).join(", ");
  configError = `missing env: ${missing}`;
  setAppState("push_config_status", "missing");
  setAppState("push_config_error", configError);
  console.warn(`[push] VAPID not configured (${configError}) — push silently disabled`);
}

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string {
  return configured ? PUBLIC_KEY : "";
}

export function getPushConfigStatus(): { ok: boolean; error: string } {
  return { ok: configured, error: configError };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * Send to every subscription. Best-effort — gathers per-row results, no
 * retries. Returns counts so callers can log / surface to UI.
 *
 * Caller responsible for deciding *whether* to push (e.g. only when there's
 * actually something actionable to say). This function just delivers.
 */
export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; failed: number; deleted: number; total: number }> {
  if (DEMO || !configured) return { sent: 0, failed: 0, deleted: 0, total: 0 };

  const subs = listPushSubscriptions();
  if (subs.length === 0) return { sent: 0, failed: 0, deleted: 0, total: 0 };

  const body = JSON.stringify(payload);
  let sent = 0, failed = 0, deleted = 0;

  await Promise.all(subs.map(async (s) => {
    const sub: PushSubscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600, topic: payload.tag?.slice(0, 32) });
      bumpPushLastSeen(s.endpoint);
      sent++;
    } catch (e: unknown) {
      const status = (e as { statusCode?: number })?.statusCode;
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 404 || status === 410) {
        deletePushSubscriptionByEndpoint(s.endpoint);
        deleted++;
      } else {
        recordPushFailure(s.endpoint, `${status || "?"}: ${msg}`);
        failed++;
      }
    }
  }));

  if (sent > 0) setAppState("push_last_sent_at", String(Math.floor(Date.now() / 1000)));
  return { sent, failed, deleted, total: subs.length };
}
