import { addPushSubscription } from "@/lib/db";
import { isPushConfigured } from "@/lib/push";

export async function POST(request: Request) {
  if (!isPushConfigured()) {
    return Response.json({ error: "VAPID not configured" }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const endpoint = body.endpoint as string | undefined;
  const keys = body.keys as { p256dh?: string; auth?: string } | undefined;
  const userAgent = (body.userAgent as string | undefined) || "";

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return Response.json({ error: "endpoint + keys.p256dh + keys.auth required" }, { status: 400 });
  }

  addPushSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent });
  return Response.json({ ok: true });
}
