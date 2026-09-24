/**
 * One-shot ops tool: backfill emails.classify_embedding for every orphaned
 * category_examples row, then optionally retrain the head from scratch.
 *
 * Run on PROD after first deploy of §24 fix:
 *   ssh prod 'cd ~/emaildigest/web && npx tsx scripts/backfill-classify-embedding.ts --retrain'
 *
 * Flags:
 *   --retrain   After backfill finishes, run trainSetfitClassifyHead({warmStart:false})
 *               and print the new head version + train accuracy.
 *   --max N     Encode at most N orphans (default: no limit).
 */
import { ensureClassifyEmbeddingsBackfilled } from "../lib/embed-backfill";
import { listOrphanedClassifyExamples, countTrainableCategoryExamples, getLabeledClassifySamples } from "../lib/db";

async function main() {
  const args = process.argv.slice(2);
  const retrain = args.includes("--retrain");
  const maxIdx = args.indexOf("--max");
  const max = maxIdx >= 0 ? parseInt(args[maxIdx + 1] ?? "0", 10) : 0;

  const startOrphans = listOrphanedClassifyExamples(10000).length;
  const trainableBefore = getLabeledClassifySamples().length;
  const totalUsable = countTrainableCategoryExamples();
  console.log(`Before: orphans=${startOrphans} trainable=${trainableBefore}/${totalUsable} (${((trainableBefore/totalUsable)*100).toFixed(1)}%)`);

  let totalEncoded = 0;
  let totalSkipped = 0;
  while (true) {
    const batch = max > 0 ? Math.min(50, max - totalEncoded) : 50;
    if (batch <= 0) break;
    const r = await ensureClassifyEmbeddingsBackfilled({ batchSize: batch });
    totalEncoded += r.encoded;
    totalSkipped += r.skippedNoText;
    // Exit if this batch produced no new encodings — `skippedNoText` rows are
    // permanent skips (text too short) and would otherwise cause an infinite
    // loop since the SQL `WHERE classify_embedding IS NULL` keeps returning
    // them. We accept that they remain in the orphan pool indefinitely.
    if (r.encoded === 0) break;
    if (max > 0 && totalEncoded >= max) break;
  }
  const trainableAfter = getLabeledClassifySamples().length;
  console.log(`After: encoded=${totalEncoded} skipped_no_text=${totalSkipped} trainable=${trainableAfter}/${totalUsable} (${((trainableAfter/totalUsable)*100).toFixed(1)}%)`);

  if (retrain) {
    const { trainSetfitClassifyHead } = await import("../lib/setfit-classify-head");
    const t0 = Date.now();
    const stats = trainSetfitClassifyHead({ warmStart: false });
    console.log(`Retrain done in ${Date.now() - t0}ms:`);
    console.log(JSON.stringify(stats, null, 2));
    console.log(`\nT0 (retrain unixepoch) = ${Math.floor(Date.now() / 1000)}`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
