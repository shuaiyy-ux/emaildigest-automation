import { deletePushSubscriptionByEndpoint } from "@/lib/db";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const endpoint = body.endpoint as string | undefined;
  if (!endpoint) return Response.json({ error: "endpoint required" }, { status: 400 });
  deletePushSubscriptionByEndpoint(endpoint);
  return Response.json({ ok: true });
}
