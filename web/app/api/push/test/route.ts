import { sendPushToAll, isPushConfigured } from "@/lib/push";

export async function POST() {
  if (!isPushConfigured()) {
    return Response.json({ error: "VAPID not configured" }, { status: 503 });
  }
  const result = await sendPushToAll({
    title: "EmailDigest test notification",
    body: "Notifications work. The next digest summary arrives at 9 AM, 3 PM or 9 PM PT.",
    tag: "test-" + Math.floor(Date.now() / 1000),
    url: "/",
  });
  return Response.json({ ok: true, ...result });
}
