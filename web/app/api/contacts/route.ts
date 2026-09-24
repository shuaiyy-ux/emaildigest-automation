import { getContacts } from "@/lib/db";

export async function GET() {
  try {
    return Response.json({ contacts: getContacts() });
  } catch (e) {
    console.error("[contacts GET] error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
