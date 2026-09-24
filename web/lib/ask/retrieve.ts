/**
 * Ask AI — RAG retrieval (chunk-based).
 *
 * Strategy: embed each email body as multiple ~400-char chunks, score
 * every chunk against the query, then dedupe by email_id keeping the
 * top-scoring chunk as the email's representative.
 *
 * Why chunks, not single vectors:
 *   - MiniLM has max_seq_length ~256 tokens (~1000 chars) — anything past
 *     that was silently truncated in the old single-vector pipeline.
 *   - Mean-pooling dilutes rare-but-critical tokens (a single "May 5"
 *     line in a 1200-char marketing email gets ~2% weight).
 * See docs/design/ask-rag.md + plan
 *   ~/.claude/plans/html-html-darkmode-iridescent-harp.md for rationale.
 *
 * Threshold calibrated downstream via `scripts/validate-rag.ts`.
 */
import db from "../db";
import { embedText, blobToEmbedding, cosineSimilarity } from "../embedder";

// Chunk-granularity cosine tends to run higher than the old single-vector
// setup because each chunk is more focused. Start 0.35; re-calibrate via
// validate-rag.ts after the first end-to-end run.
export const SIMILARITY_THRESHOLD = 0.35;
export const MAX_HITS = 100;
export const POOL_SIZE = 1000;
export const WINDOW_DAYS = 180;

interface ChunkRow {
  id: string;                    // "<email_id>_<chunk_idx>"
  email_id: string;
  chunk_idx: number;
  chunk_text: string;
  embedding: Buffer;
  received_at: number;
  subject: string;
  from_name: string;
  from_email: string;
  date: string;
  category_id: string | null;
  is_unread: number;
  primary_until: number | null;
  classifier: string;
}

export interface RetrievedEmail {
  id: string;
  date: string;
  from: string;
  subject: string;
  body_excerpt: string;          // the best-matching chunk (not the first 500 chars)
  chunk_idx: number;             // which chunk won (debug/citations)
  category: string;
  unread: boolean;
  primary_until: string | null;
  job: {
    stage: string;
    company: string;
    role: string;
    deadline: string | null;
    needs_action: boolean;
    salary: string | null;
    location: string | null;
    remote_mode: string | null;
  } | null;
  event: {
    title: string;
    start: string;
    location: string | null;
  } | null;
  similarity: number;
}

export interface RetrieveStats {
  pool_size: number;             // total chunks scanned (not emails)
  email_count: number;           // distinct emails in the pool
  hit_count: number;
  threshold: number;
  mean_similarity: number;
  max_similarity: number;
  min_similarity: number;
  unread_count: number;
  job_count: number;
  event_count: number;
}

export interface RetrieveResult {
  stats: RetrieveStats;
  hits: RetrievedEmail[];
}

/** Pull all chunks in the retrieval window, with email metadata joined. */
function fetchChunkPool(): ChunkRow[] {
  return db.prepare(`
    SELECT
      c.id, c.email_id, c.chunk_idx, c.chunk_text, c.embedding,
      e.received_at, e.subject, e.from_name, e.from_email, e.date,
      e.category_id, e.is_unread, e.primary_until, e.classifier
    FROM email_chunks c
    JOIN emails e ON e.id = c.email_id
    WHERE e.body != ''
      AND e.received_at > unixepoch() - ?*86400
      AND (e.category_id != 'cat_junk' OR e.category_id IS NULL)
    ORDER BY e.received_at DESC
    LIMIT ?
  `).all(WINDOW_DAYS, POOL_SIZE * 6) as ChunkRow[];
}

interface AuxRow {
  stage: string | null;
  company: string | null;
  role: string | null;
  deadline: number | null;
  needs_action: number | null;
  salary: string | null;
  location: string | null;
  remote_mode: string | null;
  event_title: string | null;
  event_start: number | null;
  event_location: string | null;
}

/** Fetch job/event metadata for a set of email_ids in one round-trip. */
function fetchAux(emailIds: string[]): Map<string, AuxRow> {
  if (emailIds.length === 0) return new Map();
  const placeholders = emailIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT e.id,
           je.stage, je.company, je.role, je.deadline, je.needs_action,
           je.salary, je.location, je.remote_mode,
           ev.title AS event_title, ev.start_ts AS event_start,
           ev.location AS event_location
      FROM emails e
 LEFT JOIN job_emails je ON je.email_id = e.id
 LEFT JOIN events ev ON ev.email_id = e.id
     WHERE e.id IN (${placeholders})
  `).all(...emailIds) as Array<AuxRow & { id: string }>;
  const map = new Map<string, AuxRow>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

function toPayload(best: ChunkRow, aux: AuxRow | undefined, similarity: number): RetrievedEmail {
  const from = best.from_email
    ? `${best.from_name} <${best.from_email}>`
    : best.from_name || "(unknown)";
  const category = (best.category_id || "unknown").replace(/^cat_/, "");
  const primaryUntil =
    best.primary_until && best.primary_until > Math.floor(Date.now() / 1000)
      ? new Date(best.primary_until * 1000).toISOString().slice(0, 16)
      : null;

  const job = aux && aux.stage
    ? {
        stage: aux.stage,
        company: aux.company || "",
        role: aux.role || "",
        deadline: aux.deadline ? new Date(aux.deadline * 1000).toISOString().slice(0, 10) : null,
        needs_action: !!aux.needs_action,
        salary: aux.salary || null,
        location: aux.location || null,
        remote_mode: aux.remote_mode || null,
      }
    : null;

  const event = aux && aux.event_title
    ? {
        title: aux.event_title,
        start: aux.event_start ? new Date(aux.event_start * 1000).toISOString().slice(0, 16) : "",
        location: aux.event_location || null,
      }
    : null;

  return {
    id: best.email_id,
    date: best.date,
    from,
    subject: best.subject,
    body_excerpt: best.chunk_text,        // the actual matched chunk, not blind 500 chars
    chunk_idx: best.chunk_idx,
    category,
    unread: !!best.is_unread,
    primary_until: primaryUntil,
    job,
    event,
    similarity: Math.round(similarity * 1000) / 1000,
  };
}

/** Main retrieval: score every chunk, keep best per email, filter by threshold. */
export async function retrieveRelevant(
  query: string,
  opts: { threshold?: number; maxHits?: number } = {}
): Promise<RetrieveResult> {
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
  const maxHits = opts.maxHits ?? MAX_HITS;

  // Query embedding — plain text, no Sender/Subject template.
  // (That template is an Inbox-classifier artifact; here we want the
  // query vector in the same space as chunk vectors.)
  const queryVec = await embedText(query);

  const pool = fetchChunkPool();

  // Score every chunk, keep the best chunk per email_id.
  const bestPerEmail = new Map<string, { row: ChunkRow; sim: number }>();
  for (const row of pool) {
    const vec = blobToEmbedding(row.embedding);
    const sim = cosineSimilarity(queryVec, vec);
    const prev = bestPerEmail.get(row.email_id);
    if (!prev || sim > prev.sim) {
      bestPerEmail.set(row.email_id, { row, sim });
    }
  }

  // Apply threshold at email-level (after picking best chunk).
  const above = Array.from(bestPerEmail.values()).filter((x) => x.sim >= threshold);
  above.sort((a, b) => b.sim - a.sim);
  const top = above.slice(0, maxHits);

  const aux = fetchAux(top.map((t) => t.row.email_id));
  const hits = top.map(({ row, sim }) => toPayload(row, aux.get(row.email_id), sim));

  const sims = top.map((t) => t.sim);
  const stats: RetrieveStats = {
    pool_size: pool.length,
    email_count: bestPerEmail.size,
    hit_count: hits.length,
    threshold,
    mean_similarity: sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 0,
    max_similarity: sims.length ? Math.max(...sims) : 0,
    min_similarity: sims.length ? Math.min(...sims) : 0,
    unread_count: hits.filter((h) => h.unread).length,
    job_count: hits.filter((h) => h.job !== null).length,
    event_count: hits.filter((h) => h.event !== null).length,
  };

  return { stats, hits };
}

/**
 * Debug helper — returns raw chunk-level cosines across the whole pool
 * without deduping or thresholding. Used by scripts/validate-rag.ts and
 * scripts/debug-chunk-cos.ts.
 */
export async function scorePool(query: string) {
  const queryVec = await embedText(query);
  const pool = fetchChunkPool();
  const scored = pool
    .map((row) => ({
      id: row.email_id,
      chunk_idx: row.chunk_idx,
      subject: row.subject,
      from: row.from_email,
      chunk_text: row.chunk_text,
      sim: cosineSimilarity(queryVec, blobToEmbedding(row.embedding)),
    }))
    .sort((a, b) => b.sim - a.sim);
  return { pool_size: pool.length, scored };
}
