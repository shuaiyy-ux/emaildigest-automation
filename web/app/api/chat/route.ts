/**
 * POST /api/chat — Ask AI chat endpoint (Vercel AI SDK v5 UIMessageStream / SSE).
 *
 * Protocol: text/event-stream, one JSON part per `data: ...\n\n` line, per
 * @ai-sdk/react useChat specification.
 *
 * Contract:
 *   Request: { messages: UIMessage[] | [{role,content}], sid?: string }
 *   Response: SSE — text-delta / tool-input-available / tool-output-available /
 *             data-session / finish parts. Terminated by `data: [DONE]\n\n`.
 *
 * No upfront RAG retrieval. Claude agentically calls `search_emails` MCP tool
 * when needed (see lib/prompts/ask.txt and lib/claude-cli.ts).
 *
 * `sid` resumes an earlier conversation only when it belongs to the same
 * visitor (X-Demo-User); anything else is rejected before a spawn.
 */
import * as path from "path";
import { streamChat } from "@/lib/ask/stream";
import { getConversation } from "@/lib/db";
import { getDemoUser } from "@/lib/demo";

export const runtime = "nodejs";
export const maxDuration = 300;

type MaybeUIMessage =
  | { role: "user" | "assistant" | "system"; content: string }
  | { role: "user" | "assistant" | "system"; parts: Array<{ type: string; text?: string }> };

const SYSTEM_PROMPT_PATH = path.join(process.cwd(), "lib", "prompts", "ask.txt");
const MAX_PROMPT_CHARS = 4000;

/** Extract plain text from either v5 UIMessage shape ({parts}) or legacy {content}. */
function extractText(m: MaybeUIMessage): string {
  if ("content" in m && typeof m.content === "string") return m.content;
  if ("parts" in m && Array.isArray(m.parts)) {
    return m.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("");
  }
  return "";
}

export async function POST(req: Request) {
  let body: { messages?: MaybeUIMessage[]; sid?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const messages = body.messages || [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    return new Response("last message must be user", { status: 400 });
  }

  const userPrompt = extractText(last).trim();
  if (!userPrompt) return new Response("empty prompt", { status: 400 });
  if (userPrompt.length > MAX_PROMPT_CHARS) {
    return Response.json({ error: "prompt_too_long", message: `Questions are limited to ${MAX_PROMPT_CHARS} characters.` }, { status: 400 });
  }

  const user = getDemoUser(req);
  const sid = typeof body.sid === "string" && body.sid ? body.sid : undefined;
  if (sid && !getConversation(sid, user)) {
    return Response.json({ error: "unknown_session", message: "This conversation is not available. Start a new one." }, { status: 404 });
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = streamChat({
      prompt: userPrompt,
      systemPromptPath: SYSTEM_PROMPT_PATH,
      sessionId: sid,
      user,
      signal: req.signal,
    });
  } catch (e) {
    console.error("[chat] spawn failed:", e);
    return Response.json({ error: "ask_unavailable", message: "Ask AI is unavailable right now." }, { status: 500 });
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
      "x-accel-buffering": "no",
    },
  });
}
