/**
 * Smoke test for runtime warm-start retrain of the SetFit classify head.
 *
 * Reads cached classify_embedding rows from the local DB, runs warm-start
 * retrain, prints train accuracy + per-class counts. Confirms:
 *   - getLabeledClassifySamples returns rows
 *   - softmax + multi-class CE converges (loss drops)
 *   - app_state.setfit_classify_head_runtime gets written
 *   - loadHead() reads back and produces same dimensions
 */
import { trainSetfitClassifyHead } from "../lib/setfit-classify-head";
import { loadHead, invalidateHeadCache } from "../lib/classify-embedder";
import { getAppState } from "../lib/db";

const t0 = Date.now();
console.log("=== before retrain ===");
const before = loadHead();
console.log(`  head: ${before ? `coef ${before.coef.length}×${before.coef[0].length}` : "missing"}`);
console.log(`  runtime override exists: ${getAppState("setfit_classify_head_runtime") !== null}`);

console.log("=== retrain (warm-start) ===");
const stats = trainSetfitClassifyHead({ warmStart: true });
console.log(`  samples=${stats.samples}`);
console.log(`  per-class=${JSON.stringify(stats.perClass)}`);
console.log(`  finalLoss=${stats.finalLoss.toFixed(4)}`);
console.log(`  accuracy=${(stats.accuracy * 100).toFixed(1)}%`);
console.log(`  warm-started=${stats.warmStarted}`);
console.log(`  version=${stats.version}`);

console.log("=== after retrain ===");
invalidateHeadCache();
const after = loadHead();
console.log(`  head: ${after ? `coef ${after.coef.length}×${after.coef[0].length}` : "missing"}`);
console.log(`  runtime override now: ${getAppState("setfit_classify_head_runtime") !== null ? "yes" : "no"}`);
console.log(`  total ms: ${Date.now() - t0}`);
