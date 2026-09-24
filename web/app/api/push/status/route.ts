import { isPushConfigured, getPushConfigStatus } from "@/lib/push";
import { countPushSubscriptions, getAppState } from "@/lib/db";

export async function GET() {
  const status = getPushConfigStatus();
  const lastSent = Number(getAppState("push_last_sent_at") || "0");
  return Response.json({
    configured: isPushConfigured(),
    error: status.error,
    subscriptionCount: countPushSubscriptions(),
    lastSentAt: lastSent || null,
  });
}
