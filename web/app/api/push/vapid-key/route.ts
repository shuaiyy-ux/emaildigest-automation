import { getVapidPublicKey, isPushConfigured } from "@/lib/push";

export async function GET() {
  if (!isPushConfigured()) {
    return Response.json({ error: "VAPID not configured" }, { status: 503 });
  }
  return Response.json({ publicKey: getVapidPublicKey() });
}
