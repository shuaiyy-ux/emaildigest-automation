/**
 * 4-way Inbox classifier — SetFit-fine-tuned MiniLM body + multi-class LR head.
 *
 * Sole non-LLM Inbox classifier since 2026-05-08 (the legacy MiniLM centroid
 * was retired). The body is fine-tuned on category_examples (~412 labeled
 * samples), so classes cluster tightly and a confident top-1 prediction can
 * skip the LLM fallback in 95%+ of arrivals.
 *
 * Two-stage:
 *   1. Encoder (ONNX via @huggingface/transformers) → 384-d task-tuned embedding
 *   2. LR head (head.json: coef + intercept + classes) → softmax over 4 classes
 *
 * Head precedence (most recent first):
 *   1. app_state.setfit_classify_head_runtime  ← runtime warm-start retrains write here
 *   2. web/models/setfit-classify/head.json    ← initial head from offline Python training
 *
 * See training/setfit-classify/ for the offline training pipeline.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import fs from "fs";
import { getAppState } from "./db";
import { FEATURE_DIM, concatEmbeddingWithFeatures, featuresToVector, type SenderFeatures } from "./sender-features";

const MODEL_DIR = path.resolve(
  process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."),
  "web/models/setfit-classify",
);
export const CLASSIFY_MODEL_ID = "setfit-classify-v1";
/** Top-1 probability needed to skip LLM fallback. Held-out eval @ θ=0.80
 *  shows 100% pass rate with 2.9% error — and the one "error" was the model
 *  correcting an LLM mislabel, so true accuracy is higher. */
export const CLASSIFY_PREDICT_THRESHOLD = 0.80;
export const CLASSIFY_EMBED_DIM = 384;
/** SetFit embedding (384) + sender behavioral/header features (10) = 394.
 *  See lib/sender-features.ts. Heads trained pre-feature-integration are
 *  still served at 384-d via the dim-detection branch in predictClassifyFromEmbedding. */
export const CLASSIFY_INPUT_DIM = CLASSIFY_EMBED_DIM + FEATURE_DIM;
export const CLASSIFY_NUM_CLASSES = 4;

/** Maps trained class indices to category_id. Frozen at training time —
 *  must NOT be reordered without retraining the head (LR weights are
 *  per-class-index, swapping indices breaks predictions). */
export const CLASSIFY_LABELS = [
  "cat_primary",
  "cat_track",
  "cat_news",
  "cat_junk",
] as const;
export type ClassifyLabel = typeof CLASSIFY_LABELS[number];

// IMPORTANT: see lib/work-embedder.ts comment — the transformers.js `env` is
// process-global. Don't toggle it here. Pass absolute path + local_files_only
// per pipeline() call instead.

export interface ClassifyHeadParams {
  /** shape: (n_classes=4, dim=384) */
  coef: number[][];
  /** shape: (n_classes,) */
  intercept: number[];
  /** [0, 1, 2, 3] for 4-way */
  classes: number[];
  /** Optional: {"0":"cat_primary",...} written by Python trainer */
  label_map?: Record<string, string>;
}

export interface ClassifyPrediction {
  /** Predicted category_id (one of CLASSIFY_LABELS). */
  label: ClassifyLabel;
  /** Top-1 softmax probability ∈ [0, 1]. */
  top1: number;
  /** Second-best probability ∈ [0, 1]. */
  top2: number;
  /** top1 - top2 (decisiveness). */
  margin: number;
  /** Full softmax distribution, same order as CLASSIFY_LABELS. */
  probs: Float32Array;
  /** True if we should trust this prediction and skip LLM. */
  confident: boolean;
}

let encoder: FeatureExtractionPipeline | null = null;
let loading = false;
let headCache: ClassifyHeadParams | null = null;

async function loadEncoder(): Promise<FeatureExtractionPipeline> {
  if (encoder) return encoder;
  if (loading) {
    while (loading) await new Promise((r) => setTimeout(r, 200));
    return encoder!;
  }
  loading = true;
  try {
    console.log(`[classify-embedder] Loading ${CLASSIFY_MODEL_ID} from ${MODEL_DIR}...`);
    encoder = (await pipeline(
      "feature-extraction",
      MODEL_DIR,
      { local_files_only: true },
    )) as FeatureExtractionPipeline;
    console.log(`[classify-embedder] Loaded.`);
    return encoder;
  } finally {
    loading = false;
  }
}

/** Load head: prefers runtime override (app_state.setfit_classify_head_runtime)
 *  over the on-disk head.json. Cached in-process; call invalidateHeadCache() after
 *  a retrain to pick up the new weights. */
export function loadHead(): ClassifyHeadParams | null {
  if (headCache) return headCache;
  const runtime = getAppState("setfit_classify_head_runtime");
  if (runtime) {
    try {
      headCache = JSON.parse(runtime) as ClassifyHeadParams;
      return headCache;
    } catch {
      console.warn("[classify-embedder] failed to parse setfit_classify_head_runtime, falling back to disk");
    }
  }
  const headPath = path.join(MODEL_DIR, "head.json");
  if (!fs.existsSync(headPath)) return null;
  try {
    headCache = JSON.parse(fs.readFileSync(headPath, "utf8")) as ClassifyHeadParams;
    return headCache;
  } catch (e) {
    console.warn("[classify-embedder] failed to read head.json:", e);
    return null;
  }
}

export function invalidateHeadCache(): void {
  headCache = null;
}

export function isClassifyEmbedderAvailable(): boolean {
  return fs.existsSync(path.join(MODEL_DIR, "onnx", "model.onnx"))
      && (
        fs.existsSync(path.join(MODEL_DIR, "head.json"))
        || getAppState("setfit_classify_head_runtime") !== null
      );
}

/** Compute task-specialized embedding (384-d) for a piece of text.
 *  Mean-pooled + L2-normalized to match SetFit's encode() defaults. */
export async function embedTextForClassify(text: string): Promise<Float32Array> {
  const enc = await loadEncoder();
  const out = await enc(text, { pooling: "mean", normalize: true });
  return new Float32Array((out as { data: Float32Array }).data);
}

/** Numerically-stable softmax over a length-K logit vector. */
function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  const out = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < logits.length; i++) out[i] /= sum;
  return out;
}

/** Cheap inference: given an already-computed embedding, run the LR head
 *  to get class probabilities. Returns null if head unavailable.
 *
 *  Backward compatible with two head shapes:
 *    - 384-d head (pre-2026-05-14): runs on raw SetFit embedding only
 *    - 394-d head (post-2026-05-14): concatenates the 10-dim sender feature
 *      vector. Caller MUST pass `features` when the head is 394-d, or we
 *      fall back to zero-features (degrades gracefully but loses signal).
 */
export function predictClassifyFromEmbedding(
  embedding: Float32Array,
  features?: SenderFeatures,
): ClassifyPrediction | null {
  const h = loadHead();
  if (!h) return null;
  if (h.coef.length !== CLASSIFY_NUM_CLASSES) {
    throw new Error(`[classify-embedder] head class count mismatch: expected ${CLASSIFY_NUM_CLASSES}, got ${h.coef.length}`);
  }
  const headDim = h.coef[0].length;

  // Build input vector matching head's expected dim. Two supported shapes:
  let input: Float32Array;
  if (headDim === CLASSIFY_INPUT_DIM) {
    // 394-d head: concat content embedding + sender features (zero-fill if absent).
    const fv = features ? featuresToVector(features) : new Float32Array(FEATURE_DIM);
    input = concatEmbeddingWithFeatures(embedding, fv);
  } else if (headDim === CLASSIFY_EMBED_DIM) {
    // Legacy 384-d head — features ignored. Logged at WARN once per process
    // would be ideal, but predict is hot path; keep silent and rely on a
    // startup probe (see warmupClassifyEncoder) to surface the dim mismatch.
    input = embedding;
  } else {
    throw new Error(`[classify-embedder] dim mismatch: head=${headDim} expected ${CLASSIFY_EMBED_DIM} or ${CLASSIFY_INPUT_DIM}`);
  }

  const logits = new Float32Array(CLASSIFY_NUM_CLASSES);
  for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
    let z = h.intercept[c];
    const w = h.coef[c];
    for (let i = 0; i < input.length; i++) z += w[i] * input[i];
    logits[c] = z;
  }
  const probs = softmax(logits);
  // Find top1 + top2 (single pass)
  let top1Idx = 0;
  let top1 = probs[0];
  for (let c = 1; c < CLASSIFY_NUM_CLASSES; c++) {
    if (probs[c] > top1) { top1 = probs[c]; top1Idx = c; }
  }
  let top2 = -1;
  for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
    if (c === top1Idx) continue;
    if (probs[c] > top2) top2 = probs[c];
  }
  return {
    label: CLASSIFY_LABELS[top1Idx],
    top1,
    top2,
    margin: top1 - top2,
    probs,
    confident: top1 >= CLASSIFY_PREDICT_THRESHOLD,
  };
}

/** End-to-end convenience: text → prediction. Returns null if model files
 *  missing — caller should fall back gracefully (e.g. to centroid classifier). */
export async function predictClassify(text: string): Promise<ClassifyPrediction | null> {
  if (!isClassifyEmbedderAvailable()) return null;
  const emb = await embedTextForClassify(text);
  return predictClassifyFromEmbedding(emb);
}

/** Pack a Float32Array embedding into a SQLite BLOB. */
export function classifyEmbeddingToBlob(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

/** Decode a SQLite BLOB back to Float32Array. */
export function blobToClassifyEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
