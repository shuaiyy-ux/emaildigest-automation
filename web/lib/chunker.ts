/**
 * Email body chunker for Ask AI RAG.
 *
 * Rationale: MiniLM has max_seq_length=256 tokens (~1000 chars) and
 * mean-pools all token vectors into one 384-d vector. Long emails thus
 * suffer two compounding problems:
 *   - hard truncation past ~1000 chars
 *   - semantic dilution of key content by boilerplate/URLs
 *
 * Chunking fixes both by producing several ~400-char chunks per email,
 * each independently embedded. Event info ("MAY 5 / Tuesday") lives in
 * its own chunk, not diluted by marketing headers.
 */

const TARGET_CHARS = 400;
const MAX_CHARS = 500;          // hard cap; below MiniLM's ~1000-char token budget
const MIN_CHARS = 20;           // below this a chunk is noise
const MAX_CHUNKS = 6;           // footers / unsub / legal at the tail — drop safely

/** Strip URL strings, collapse whitespace but preserve paragraph breaks. */
function normalize(body: string): string {
  return body
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[ \t]+/g, " ")           // collapse runs of spaces/tabs
    .replace(/\n{3,}/g, "\n\n")        // collapse 3+ newlines
    .trim();
}

/** Split a paragraph into sentences by terminal punctuation + newline. */
function splitSentences(para: string): string[] {
  const parts = para.split(/(?<=[.?!。？！])\s+|\n+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Greedy bin-pack sentences into ~TARGET_CHARS boxes, respecting MAX_CHARS. */
function packSentences(sentences: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const candidate = cur ? `${cur} ${s}` : s;
    if (candidate.length <= MAX_CHARS) {
      cur = candidate;
      // Close box once we're near target (don't over-pack)
      if (cur.length >= TARGET_CHARS) {
        out.push(cur);
        cur = "";
      }
    } else {
      if (cur) out.push(cur);
      // Single sentence longer than MAX_CHARS — hard-slice it
      if (s.length > MAX_CHARS) {
        for (let i = 0; i < s.length; i += MAX_CHARS) {
          out.push(s.slice(i, i + MAX_CHARS));
        }
        cur = "";
      } else {
        cur = s;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split email body into chunks suitable for MiniLM embedding.
 * Returns at most MAX_CHUNKS chunks, each MIN_CHARS..MAX_CHARS long.
 */
export function chunkText(body: string): string[] {
  if (!body || body.length < MIN_CHARS) return [];

  const cleaned = normalize(body);
  const paragraphs = cleaned.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (chunks.length >= MAX_CHUNKS) break;
    if (para.length <= MAX_CHARS) {
      chunks.push(para);
    } else {
      const packed = packSentences(splitSentences(para));
      for (const p of packed) {
        if (chunks.length >= MAX_CHUNKS) break;
        chunks.push(p);
      }
    }
  }

  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length >= MIN_CHARS)
    .slice(0, MAX_CHUNKS);
}
