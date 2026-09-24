/**
 * Debug: for a given email_id, print every chunk's cosine similarity
 * to a given query, so you can eyeball which chunks are "event/intent"
 * vs "marketing/URL noise."
 *
 *   cd web && npx tsx scripts/debug-chunk-cos.ts 19d9dea91ea9252a "May AI event"
 */
import { listChunksForEmail } from "../lib/db";
import { embedText, blobToEmbedding, cosineSimilarity } from "../lib/embedder";

async function main() {
  const emailId = process.argv[2];
  const query = process.argv[3] || "May AI event";
  if (!emailId) {
    console.error("Usage: tsx scripts/debug-chunk-cos.ts <email_id> <query>");
    process.exit(1);
  }

  const chunks = listChunksForEmail(emailId);
  if (chunks.length === 0) {
    console.error(`No chunks for ${emailId}. Run backfill-chunks.ts first.`);
    process.exit(1);
  }

  const qVec = await embedText(query);
  console.log(`\nquery: "${query}"\n`);
  console.log(`email: ${emailId}  (${chunks.length} chunks)\n`);

  const scored = chunks.map((c) => ({
    idx: c.chunk_idx,
    sim: cosineSimilarity(qVec, blobToEmbedding(c.embedding)),
    text: c.chunk_text,
  }));
  scored.sort((a, b) => b.sim - a.sim);

  for (const c of scored) {
    const pct = (c.sim * 100).toFixed(1).padStart(5);
    const preview = c.text.replace(/\s+/g, " ").slice(0, 100);
    console.log(`  chunk ${c.idx}  cos=${pct}%  ${preview}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
