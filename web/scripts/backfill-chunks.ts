/**
 * One-shot backfill: chunk + embed every email that doesn't have rows
 * in email_chunks yet. Run once after deploying the chunked-embedding
 * change; after that, prefetch Step 1.6 keeps it up to date incrementally.
 *
 *   cd web && npx tsx scripts/backfill-chunks.ts
 */
import { listEmailsNeedingChunks, replaceChunksForEmail, countChunks } from "../lib/db";
import { chunkText } from "../lib/chunker";
import { embedText, embeddingToBlob } from "../lib/embedder";

async function main() {
  console.log(`[backfill-chunks] starting — existing chunks: ${countChunks()}`);

  const BATCH = 50;
  let totalEmails = 0, totalChunks = 0, errors = 0;
  const startT = Date.now();

  while (true) {
    const batch = listEmailsNeedingChunks(BATCH);
    if (batch.length === 0) break;
    console.log(`[backfill-chunks] batch of ${batch.length}...`);

    for (const e of batch) {
      try {
        const parts = chunkText(e.body || "");
        if (parts.length === 0) {
          console.log(`  [${e.id.slice(0, 8)}] empty after chunking — skip`);
          continue;
        }
        const rows = [];
        for (let i = 0; i < parts.length; i++) {
          const vec = await embedText(parts[i]);
          rows.push({ chunk_idx: i, chunk_text: parts[i], embedding: embeddingToBlob(vec) });
        }
        replaceChunksForEmail(e.id, rows);
        totalEmails++;
        totalChunks += rows.length;
        if (totalEmails % 10 === 0) {
          console.log(`  ${totalEmails} emails / ${totalChunks} chunks so far (${((Date.now() - startT) / 1000).toFixed(1)}s)`);
        }
      } catch (err) {
        errors++;
        console.error(`  [${e.id.slice(0, 8)}] error:`, err);
      }
    }
  }

  const totalSec = ((Date.now() - startT) / 1000).toFixed(1);
  console.log(`\n[backfill-chunks] done: ${totalEmails} emails, ${totalChunks} chunks, ${errors} errors in ${totalSec}s`);
  console.log(`[backfill-chunks] DB now has ${countChunks()} chunks total`);
}

main().catch((err) => {
  console.error("[backfill-chunks] fatal:", err);
  process.exit(1);
});
