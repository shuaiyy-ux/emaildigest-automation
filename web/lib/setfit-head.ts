/**
 * SetFit head — runtime warm-start retrain.
 *
 * The SetFit body (encoder) is fine-tuned offline in Python; we ship the ONNX
 * file. The classification HEAD on top is a logistic regression — same math
 * as lib/work-classifier.ts, but trained on the SetFit-tuned `work_embedding`
 * column rather than the generic MiniLM `embedding` column.
 *
 * Retrain triggers:
 *   - User right-clicks "Classify as Job related" in /api/jobs
 *     → upsertWorkLabel + trainSetfitHead({ warmStart: true })
 *
 * Warm-start (default for runtime calls): start from current head weights,
 * run 50 iters of gradient descent. ~100ms on 50 samples.
 *
 * Storage: `app_state.setfit_head_runtime` (JSON), preferred over
 * `web/models/setfit-work/head.json` by the loader in work-embedder.ts.
 *
 * For full retrain (from scratch with new SetFit body), re-run
 * `training/setfit-work/train.py` in Python — that updates head.json on disk.
 */
import { getAppState, setAppState, getLabeledWorkSamples } from "./db";
import {
  WORK_EMBED_DIM,
  WORK_PREDICT_THRESHOLD,
  blobToWorkEmbedding,
  loadHead,
  invalidateHeadCache,
  type HeadParams,
} from "./work-embedder";

const RUNTIME_KEY = "setfit_head_runtime";
const VERSION_KEY = "setfit_head_version";

/** Per-source weight multipliers — user corrections dominate LLM bootstrap.
 *  Same constants as work-classifier.ts SOURCE_WEIGHTS for consistency. */
const SOURCE_WEIGHTS: Record<string, number> = {
  user_correction: 50,
  llm_bootstrap: 1,
};
function sourceWeight(source: string): number {
  return SOURCE_WEIGHTS[source] ?? 1;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  } else {
    const ez = Math.exp(z);
    return ez / (1 + ez);
  }
}

export interface TrainStats {
  samples: number;
  positive: number;
  negative: number;
  finalLoss: number;
  accuracy: number;
  warmStarted: boolean;
  version: string;
}

/**
 * Train (or warm-start retrain) the SetFit LR head from work_labels +
 * cached SetFit embeddings (emails.work_embedding).
 *
 * Throws if no labeled samples have work_embedding cached — caller should
 * ensure prefetch has run since SetFit was enabled. Otherwise the safe fallback
 * is for caller to swallow the error and proceed (warm-start retrain failure
 * shouldn't block forceClassifyAsJob).
 */
export function trainSetfitHead(opts: {
  iterations?: number;
  learningRate?: number;
  l2Lambda?: number;
  warmStart?: boolean;
} = {}): TrainStats {
  const warmStart = opts.warmStart ?? false;
  const iters = opts.iterations ?? (warmStart ? 50 : 500);
  const lr = opts.learningRate ?? 0.1;
  const lambda = opts.l2Lambda ?? 0.01;

  const rows = getLabeledWorkSamples();
  if (rows.length === 0) {
    throw new Error("[setfit-head] no labeled samples with work_embedding — wait for prefetch to populate, then retry");
  }

  const X: Float32Array[] = rows.map((r) => blobToWorkEmbedding(r.work_embedding));
  const y: number[] = rows.map((r) => r.label);
  const sources: string[] = rows.map((r) => r.source);
  const N = X.length;
  const positive = y.reduce((a, v) => a + v, 0);
  const negative = N - positive;

  // Sample weight = class-balance × source-priority. Same formula as
  // lib/work-classifier.ts to keep the user-correction-dominates contract
  // consistent across both heads.
  const wPos = N / (2 * Math.max(1, positive));
  const wNeg = N / (2 * Math.max(1, negative));
  const sampleWeights = y.map((v, i) => (v === 1 ? wPos : wNeg) * sourceWeight(sources[i]));

  // Initialize: warm-start from current head, or from zero
  let w: Float32Array;
  let b: number;
  let warmStarted = false;
  if (warmStart) {
    const existing = loadHead();
    if (existing && existing.coef[0]?.length === WORK_EMBED_DIM) {
      w = new Float32Array(existing.coef[0]);
      b = existing.intercept[0];
      warmStarted = true;
    } else {
      w = new Float32Array(WORK_EMBED_DIM);
      b = 0;
    }
  } else {
    w = new Float32Array(WORK_EMBED_DIM);
    b = 0;
  }

  let finalLoss = 0;
  for (let iter = 0; iter < iters; iter++) {
    let gradB = 0;
    const gradW = new Float32Array(WORK_EMBED_DIM);
    let loss = 0;

    for (let i = 0; i < N; i++) {
      let z = b;
      const x = X[i];
      for (let d = 0; d < WORK_EMBED_DIM; d++) z += w[d] * x[d];
      const p = sigmoid(z);
      const err = (p - y[i]) * sampleWeights[i];
      gradB += err;
      for (let d = 0; d < WORK_EMBED_DIM; d++) gradW[d] += err * x[d];

      const eps = 1e-12;
      loss -= sampleWeights[i] * (y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
    }

    gradB /= N;
    for (let d = 0; d < WORK_EMBED_DIM; d++) {
      gradW[d] = gradW[d] / N + lambda * w[d];
    }
    let wNorm = 0;
    for (let d = 0; d < WORK_EMBED_DIM; d++) wNorm += w[d] * w[d];
    loss = loss / N + (lambda / 2) * wNorm;
    finalLoss = loss;

    b -= lr * gradB;
    for (let d = 0; d < WORK_EMBED_DIM; d++) w[d] -= lr * gradW[d];
  }

  // Train accuracy
  let correct = 0;
  for (let i = 0; i < N; i++) {
    let z = b;
    const x = X[i];
    for (let d = 0; d < WORK_EMBED_DIM; d++) z += w[d] * x[d];
    const pred = sigmoid(z) >= WORK_PREDICT_THRESHOLD ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  const accuracy = correct / N;

  // Persist as JSON in app_state. Loader (work-embedder.loadHead) prefers
  // this over the disk head.json.
  const head: HeadParams = {
    coef: [Array.from(w)],
    intercept: [b],
    classes: [0, 1],
  };
  setAppState(RUNTIME_KEY, JSON.stringify(head));
  const version = `v${Date.now()}`;
  setAppState(VERSION_KEY, version);
  invalidateHeadCache();

  const ws = warmStarted ? "warm-start " : "full ";
  console.log(
    `[setfit-head] ${ws}trained on ${N} samples (${positive} pos / ${negative} neg), ` +
    `iters=${iters}, final loss=${finalLoss.toFixed(4)}, acc=${(accuracy * 100).toFixed(1)}%, version=${version}`,
  );

  return { samples: N, positive, negative, finalLoss, accuracy, warmStarted, version };
}

/** Get the current runtime head version (for telemetry / staleness check). */
export function getSetfitHeadVersion(): string | null {
  return getAppState(VERSION_KEY);
}
