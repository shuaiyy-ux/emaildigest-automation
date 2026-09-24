/**
 * Train the work-classifier logistic regression from work_labels.
 *
 *   tsx scripts/train-work-classifier.ts
 *
 * Run after label-work-corpus.ts, or whenever user corrections accumulate.
 */
import { trainWorkClassifier } from "../lib/work-classifier";

(async () => {
  const stats = trainWorkClassifier({ iterations: 500, learningRate: 0.1, l2Lambda: 0.01 });
  console.log(`\n=== Training summary ===`);
  console.log(`Samples:    ${stats.samples} (${stats.positive} pos / ${stats.negative} neg)`);
  console.log(`Final loss: ${stats.finalLoss.toFixed(4)}`);
  console.log(`Train acc:  ${(stats.accuracy * 100).toFixed(1)}%`);
})().catch((e) => { console.error(e); process.exit(1); });
