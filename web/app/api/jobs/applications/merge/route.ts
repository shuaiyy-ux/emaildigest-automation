import { mergeApplications } from "@/lib/applications";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter((x): x is string => typeof x === "string") : [];
  if (!targetId || sourceIds.length === 0) {
    return Response.json({ error: "targetId and sourceIds required" }, { status: 400 });
  }

  try {
    mergeApplications(targetId, sourceIds);
    return Response.json({ merged: sourceIds.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
