import { splitApplication, getApplication } from "@/lib/applications";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!getApplication(id)) {
    return Response.json({ error: "Application not found" }, { status: 404 });
  }

  const emailIds = Array.isArray(body.emailIds) ? body.emailIds.filter((x): x is string => typeof x === "string") : [];
  if (emailIds.length === 0) return Response.json({ error: "emailIds required" }, { status: 400 });

  try {
    const newId = splitApplication({
      applicationId: id,
      emailIds,
      newCompany: typeof body.newCompany === "string" ? body.newCompany : undefined,
      newRole: typeof body.newRole === "string" ? body.newRole : undefined,
    });
    return Response.json({ newApplicationId: newId });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
