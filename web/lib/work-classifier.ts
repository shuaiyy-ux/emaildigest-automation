/**
 * Work-classifier — logistic regression on MiniLM embeddings.
 *
 * Business: replaces the cosine-to-seed heuristic with a proper binary
 * classifier trained on LLM-bootstrapped labels + user corrections.
 *
 * Architecture:
 *   input  ∈ R^384   (MiniLM embedding)
 *   w      ∈ R^384   (weights)
 *   b      ∈ R       (bias)
 *   P(work) = sigmoid(w·x + b)
 *
 * Training: batch gradient descent with L2 regularization, ~500 iters.
 *   loss = -Σ [y log p + (1-y) log(1-p)] + λ/2 ||w||²
 * Converges in seconds on CPU for up to ~5000 samples.
 *
 * Weights are persisted in app_state as base64-encoded Float32Array
 * (384 weights + 1 bias = 385 floats = 1540 bytes).
 */
import { getAppState, setAppState, getLabeledEmailsWithEmbeddings } from "./db";
import { blobToEmbedding } from "./embedder";

const WEIGHTS_KEY = "work_classifier_weights";
const VERSION_KEY = "work_classifier_version";
const DIM = 384;

/** Predict threshold. 0.5 is default; tune if precision/recall needs shift. */
export const WORK_CLASSIFIER_THRESHOLD = 0.5;

/** Per-source weight multipliers — user corrections dominate LLM bootstrap. */
export const SOURCE_WEIGHTS: Record<string, number> = {
  user_correction: 50,
  llm_bootstrap: 1,
};
function sourceWeight(source: string): number {
  return SOURCE_WEIGHTS[source] ?? 1;
}

interface Weights {
  w: Float32Array;
  b: number;
  version: string;
  trainedAt: number;
  samples: number;
  posRate: number;
}

let cache: Weights | null = null;

function serialize(w: Float32Array, b: number): string {
  const buf = new Float32Array(DIM + 1);
  buf.set(w);
  buf[DIM] = b;
  return Buffer.from(buf.buffer).toString("base64");
}

function deserialize(s: string): { w: Float32Array; b: number } {
  const buf = Buffer.from(s, "base64");
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { w: all.slice(0, DIM), b: all[DIM] };
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

/** Load weights into memory (lazy). Returns null if not yet trained. */
export function loadWeights(): Weights | null {
  if (cache) return cache;
  const s = getAppState(WEIGHTS_KEY);
  if (!s) return null;
  const meta = getAppState(VERSION_KEY);
  const { w, b } = deserialize(s);
  cache = {
    w, b,
    version: meta || "v0",
    trainedAt: 0,
    samples: 0,
    posRate: 0,
  };
  return cache;
}

/** Drop in-memory cache — call after training to force reload. */
export function invalidateCache() { cache = null; }

/** P(is_work) ∈ [0, 1]. Returns 0 if no model trained yet (fail-closed). */
export function predictWork(embedding: Float32Array): number {
  const wts = loadWeights();
  if (!wts) return 0;
  let z = wts.b;
  for (let i = 0; i < DIM; i++) z += wts.w[i] * embedding[i];
  return sigmoid(z);
}

/** Convenience: boolean gate at WORK_CLASSIFIER_THRESHOLD. */
export function isWorkEmail(embedding: Float32Array): boolean {
  return predictWork(embedding) >= WORK_CLASSIFIER_THRESHOLD;
}

/**
 * Train logistic regression on all rows in work_labels + their cached embeddings.
 * Returns stats so callers can report.
 */
export function trainWorkClassifier(opts: {
  iterations?: number;
  learningRate?: number;
  l2Lambda?: number;
  warmStart?: boolean;
} = {}): { samples: number; positive: number; negative: number; finalLoss: number; accuracy: number; warmStarted: boolean } {
  // warm-start defaults: fewer iters since we start from current optimum
  const warmStart = opts.warmStart ?? false;
  const iters = opts.iterations ?? (warmStart ? 50 : 500);
  const lr = opts.learningRate ?? 0.1;
  const lambda = opts.l2Lambda ?? 0.01;

  const rows = getLabeledEmailsWithEmbeddings();
  if (rows.length === 0) {
    throw new Error("[work-classifier] no labeled samples with embeddings — label corpus first");
  }

  // Decode embeddings once
  const X: Float32Array[] = rows.map((r) => blobToEmbedding(r.embedding));
  const y: number[] = rows.map((r) => r.label);
  const sources: string[] = rows.map((r) => r.source);
  const N = X.length;
  const positive = y.reduce((a, v) => a + v, 0);
  const negative = N - positive;

  // Sample weight = class-balance × source-priority. user_correction dominates
  // at 50× vs llm_bootstrap — so a single corrected example has the pull of
  // ~50 LLM-labeled ones, matching the SOURCE_WEIGHTS pattern used elsewhere.
  const wPos = N / (2 * Math.max(1, positive));
  const wNeg = N / (2 * Math.max(1, negative));
  const sampleWeights = y.map((v, i) => (v === 1 ? wPos : wNeg) * sourceWeight(sources[i]));

  // Initialize: warm-start from existing weights, or from zero
  let w: Float32Array;
  let b: number;
  if (warmStart) {
    const existing = loadWeights();
    if (existing) {
      w = new Float32Array(existing.w);
      b = existing.b;
    } else {
      w = new Float32Array(DIM);
      b = 0;
    }
  } else {
    w = new Float32Array(DIM);
    b = 0;
  }

  let finalLoss = 0;

  for (let iter = 0; iter < iters; iter++) {
    let gradB = 0;
    const gradW = new Float32Array(DIM);
    let loss = 0;

    for (let i = 0; i < N; i++) {
      let z = b;
      const x = X[i];
      for (let d = 0; d < DIM; d++) z += w[d] * x[d];
      const p = sigmoid(z);
      const err = (p - y[i]) * sampleWeights[i];
      gradB += err;
      for (let d = 0; d < DIM; d++) gradW[d] += err * x[d];

      // Weighted BCE loss
      const eps = 1e-12;
      loss -= sampleWeights[i] * (y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
    }

    // Average + L2 regularization gradient
    gradB /= N;
    for (let d = 0; d < DIM; d++) {
      gradW[d] = gradW[d] / N + lambda * w[d];
    }
    // L2 term in loss
    let wNorm = 0;
    for (let d = 0; d < DIM; d++) wNorm += w[d] * w[d];
    loss = loss / N + (lambda / 2) * wNorm;
    finalLoss = loss;

    // Update
    b -= lr * gradB;
    for (let d = 0; d < DIM; d++) w[d] -= lr * gradW[d];

    if ((iter + 1) % 100 === 0) {
      console.log(`[work-classifier] iter ${iter + 1}/${iters} loss=${loss.toFixed(4)}`);
    }
  }

  // Accuracy on training set
  let correct = 0;
  for (let i = 0; i < N; i++) {
    let z = b;
    const x = X[i];
    for (let d = 0; d < DIM; d++) z += w[d] * x[d];
    const pred = sigmoid(z) >= WORK_CLASSIFIER_THRESHOLD ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  const accuracy = correct / N;

  // Persist
  setAppState(WEIGHTS_KEY, serialize(w, b));
  const version = `v${Date.now()}`;
  setAppState(VERSION_KEY, version);
  invalidateCache();

  console.log(
    `[work-classifier] ${warmStart ? "warm-start " : "full "}trained on ${N} samples (${positive} pos / ${negative} neg), ` +
    `iters=${iters}, final loss=${finalLoss.toFixed(4)}, acc=${(accuracy * 100).toFixed(1)}%, version=${version}`
  );

  return { samples: N, positive, negative, finalLoss, accuracy, warmStarted: warmStart };
}
