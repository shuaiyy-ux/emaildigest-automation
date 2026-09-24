/**
 * SetFit-classify embedding backfill.
 *
 * Reason: the runtime warm-start retrain (lib/setfit-classify-head.ts) reads
 * training rows via SQL JOIN to emails.classify_embedding. Emails classified
 * BEFORE SetFit shipped (2026-05-07) have NULL in that column — their
 * category_examples rows are invisible to warm-start, even though the
 * original ship-time Python training saw them. Result: the head silently
 * trains on a subset (220/504 on PROD as of 2026-05-13), degrading from
 * the ship eval's 97.8% train acc to 81.1%. See docs/lessons-learned.md §24.
 *
 * Fix: on startup, encode the orphans and write to emails.classify_embedding
 * so the next retrain sees the full training set. Fire-and-forget; bounded
 * batch per call (default 50/min) to avoid blocking startup or other work.
 */
import { log } from "./logger";
import {
  listOrphanedClassifyExamples,
  updateClassifyEmbedding,
} from "./db";
import {
  isClassifyEmbedderAvailable,
  embedTextForClassify,
  classifyEmbeddingToBlob,
} from "./classify-embedder";

const l = log.child("embed-backfill");
let running = false;

function buildClassifyText(row: { subject: string; snippet: string }): string {
  // Mirrors prefetch.ts Step 2a construction so the cached embedding is
  // identical to what a freshly arriving email would get.
  return (row.subject || "").slice(0, 200) + "\n" + (row.snippet || "").slice(0, 1500);
}

/**
 * One-pass backfill of missing classify_embedding for category_examples
 * orphans. Idempotent: re-running after completion is a no-op (no orphans
 * left to find). Caller controls batch size; default 50 keeps startup cost
 * low (~1s) while still chipping away at backlogs of ~250 rows in 5 calls.
 */
export async function ensureClassifyEmbeddingsBackfilled(opts: {
  batchSize?: number;
} = {}): Promise<{ encoded: number; remaining: number; skippedNoText: number }> {
  if (running) {
    l.debug("already running, skip");
    return { encoded: 0, remaining: -1, skippedNoText: 0 };
  }
  if (!isClassifyEmbedderAvailable()) {
    l.warn("SetFit classify model not available, skipping backfill");
    return { encoded: 0, remaining: -1, skippedNoText: 0 };
  }
  running = true;
  const batchSize = opts.batchSize ?? 50;
  let encoded = 0;
  let skippedNoText = 0;
  try {
    const orphans = listOrphanedClassifyExamples(batchSize);
    if (orphans.length === 0) {
      l.debug("no orphans");
      return { encoded: 0, remaining: 0, skippedNoText: 0 };
    }
    const t0 = Date.now();
    for (const row of orphans) {
      const text = buildClassifyText(row);
      if (text.trim().length < 5) {
        skippedNoText++;
        continue;
      }
      try {
        const emb = await embedTextForClassify(text);
        updateClassifyEmbedding(row.email_id, classifyEmbeddingToBlob(emb));
        encoded++;
      } catch (e) {
        l.warn("encode failed", { emailId: row.email_id, err: e instanceof Error ? e.message : String(e) });
      }
    }
    // Approximate remaining: count rows still NULL after this batch.
    const remaining = listOrphanedClassifyExamples(1).length > 0
      ? Math.max(0, orphans.length - encoded - skippedNoText)
      : 0;
    l.info("batch done", {
      encoded,
      skippedNoText,
      remainingHint: remaining,
      ms: Date.now() - t0,
    });
    return { encoded, remaining, skippedNoText };
  } finally {
    running = false;
  }
}
