/**
 * Internal endpoint called by the MCP server's search_emails tool.
 *
 * SECURITY: middleware.ts bypasses auth for /api/internal/* paths ONLY when
 * the Host header is 127.0.0.1 / localhost. External callers get 401.
 */
import { retrieveRelevant } from "@/lib/ask/retrieve";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { query?: string; max_results?: number; days_back?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = (body.query || "").trim();
  if (!query) return Response.json({ error: "Missing query" }, { status: 400 });

  const maxResults = Math.max(1, Math.min(body.max_results || 50, 100));

  const result = await retrieveRelevant(query, { maxHits: maxResults });

  // Each hit's `body` is the best-matching chunk (~400 chars max already).
  // chunk_idx tells Claude which segment won — useful if it needs to ask
  // read_full_email for surrounding context.
  const compactHits = result.hits.map((h) => ({
    id: h.id,
    date: h.date,
    from: h.from,
    subject: h.subject,
    body: h.body_excerpt,
    chunk_idx: h.chunk_idx,
    category: h.category,
    unread: h.unread,
    primary_until: h.primary_until,
    job: h.job,
    event: h.event,
    similarity: h.similarity,
  }));

  return Response.json({ stats: result.stats, hits: compactHits });
}
