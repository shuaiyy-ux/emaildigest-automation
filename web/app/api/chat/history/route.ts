/**
 * GET /api/chat/history — list the requesting visitor's recent Ask AI
 * conversations (conversations table, filtered by X-Demo-User).
 */
import { listConversations } from "@/lib/db";
import { getDemoUser } from "@/lib/demo";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const rows = listConversations(getDemoUser(req), 50).map((r) => ({
    sid: r.sid,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return Response.json({ conversations: rows });
}
