/**
 * /api/chat/history/[sid]
 *
 *   GET    → the conversation's user / assistant text turns as v5
 *            UIMessage[], read from conversation_messages. Only the visitor
 *            who owns the conversation (X-Demo-User) gets it; others get 404.
 *
 *   DELETE → drop the conversation and its messages (owner only).
 */
import { getConversation, listConversationMessages, deleteConversation } from "@/lib/db";
import { getDemoUser } from "@/lib/demo";

export const runtime = "nodejs";

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  parts: Array<{ type: "text"; text: string }>;
}

export async function GET(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const { sid } = await ctx.params;
  if (!SID_RE.test(sid)) return new Response("invalid sid", { status: 400 });

  const user = getDemoUser(req);
  if (!getConversation(sid, user)) return new Response("not found", { status: 404 });

  const messages: UIMessage[] = listConversationMessages(sid, user).map((m) => ({
    id: `m_${m.id}`,
    role: m.role,
    parts: [{ type: "text", text: m.text }],
  }));
  return Response.json({ messages });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const { sid } = await ctx.params;
  if (!SID_RE.test(sid)) return new Response("invalid sid", { status: 400 });

  if (!deleteConversation(sid, getDemoUser(req))) return new Response("not found", { status: 404 });
  return Response.json({ ok: true });
}
