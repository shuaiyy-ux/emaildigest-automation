/**
 * Work-task-specialized embedder + classifier head.
 *
 * Loads a SetFit-fine-tuned MiniLM (trained offline on work_labels) plus its
 * logistic-regression head. Used ONLY by the work-classifier path; primary/track
 * classification continues to use the generic MiniLM in lib/embedder.ts.
 *
 * Two-stage:
 *   1. Encoder (ONNX via @huggingface/transformers) → 384-d task-tuned embedding
 *   2. LR head (head.json: coef + intercept) → P(is_work)
 *
 * The encoder + head must come from the same training run. SetFit fine-tunes
 * the encoder body specifically for the LR head's decision boundary; mixing
 * encoder/head from different runs WILL break inference.
 *
 * Head precedence (most recent first):
 *   1. app_state.setfit_head_runtime  ← runtime warm-start retrains write here
 *   2. web/models/setfit-work/head.json  ← initial head from offline Python training
 *
 * See training/setfit-work/ for the offline training pipeline.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import fs from "fs";
import { getAppState } from "./db";

const MODEL_DIR = path.resolve(
  process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."),
  "web/models/setfit-work",
);
export const WORK_MODEL_ID = "setfit-work-v1";
export const WORK_PREDICT_THRESHOLD = 0.5;
/** Output dimension of the SetFit body. Same 384 as base MiniLM (only weights
 *  are fine-tuned, architecture unchanged). */
export const WORK_EMBED_DIM = 384;

// IMPORTANT: don't touch the global `env` (allowRemoteModels / localModelPath)
// — transformers.js's `env` is process-global, so toggling it here would also
// disable HF Hub fallback for the main MiniLM embedder in lib/embedder.ts and
// break Inbox classification on a fresh deploy. Instead, pass the absolute
// local path + `local_files_only: true` to this pipeline() call only.

export interface HeadParams {
  /** shape: (1, dim) for binary logistic regression */
  coef: number[][];
  /** shape: (1,) */
  intercept: number[];
  /** [0, 1] for binary */
  classes: number[];
}

let encoder: FeatureExtractionPipeline | null = null;
let loading = false;
/** In-memory cache for the loaded head. Invalidated by `invalidateHeadCache()`
 *  whenever a runtime retrain writes to app_state.setfit_head_runtime. */
let headCache: HeadParams | null = null;

async function loadEncoder(): Promise<FeatureExtractionPipeline> {
  if (encoder) return encoder;
  if (loading) {
    while (loading) await new Promise((r) => setTimeout(r, 200));
    return encoder!;
  }
  loading = true;
  try {
    console.log(`[work-embedder] Loading ${WORK_MODEL_ID} from ${MODEL_DIR}...`);
    // Absolute local path + local_files_only ensures we use the bundled
    // ONNX without ever consulting HF Hub (and without polluting global env
    // for the main MiniLM embedder).
    encoder = (await pipeline(
      "feature-extraction",
      MODEL_DIR,
      { local_files_only: true },
    )) as FeatureExtractionPipeline;
    console.log(`[work-embedder] Loaded.`);
    return encoder;
  } finally {
    loading = false;
  }
}

/** Load head: prefers runtime override (app_state.setfit_head_runtime) over
 *  the on-disk head.json. Cached in-process; call invalidateHeadCache() after
 *  a retrain to pick up the new weights. */
export function loadHead(): HeadParams | null {
  if (headCache) return headCache;
  // Runtime override first
  const runtime = getAppState("setfit_head_runtime");
  if (runtime) {
    try {
      headCache = JSON.parse(runtime) as HeadParams;
      return headCache;
    } catch {
      console.warn("[work-embedder] failed to parse setfit_head_runtime, falling back to disk");
    }
  }
  // Disk
  const headPath = path.join(MODEL_DIR, "head.json");
  if (!fs.existsSync(headPath)) return null;
  try {
    headCache = JSON.parse(fs.readFileSync(headPath, "utf8")) as HeadParams;
    return headCache;
  } catch (e) {
    console.warn("[work-embedder] failed to read head.json:", e);
    return null;
  }
}

/** Force re-load of the LR head on next predict call. Call after a retrain. */
export function invalidateHeadCache(): void {
  headCache = null;
}

export function isWorkEmbedderAvailable(): boolean {
  return fs.existsSync(path.join(MODEL_DIR, "onnx", "model.onnx"))
      && (
        fs.existsSync(path.join(MODEL_DIR, "head.json"))
        || getAppState("setfit_head_runtime") !== null
      );
}

/** Compute task-specialized embedding (384-d) for a piece of text.
 *  Mean-pooled + L2-normalized to match SetFit's encode() defaults. */
export async function embedTextForWork(text: string): Promise<Float32Array> {
  const enc = await loadEncoder();
  const out = await enc(text, { pooling: "mean", normalize: true });
  return new Float32Array((out as { data: Float32Array }).data);
}

/** Cheap inference path: given an already-computed embedding, run the LR
 *  head to get P(is_work). Returns null if head is unavailable. Caller should
 *  fall back to legacy work-classifier in that case. */
export function predictIsWorkFromEmbedding(embedding: Float32Array): number | null {
  const h = loadHead();
  if (!h) return null;
  const w = h.coef[0];
  const b = h.intercept[0];
  if (w.length !== embedding.length) {
    throw new Error(`[work-embedder] dim mismatch: emb=${embedding.length} head=${w.length}`);
  }
  let z = b;
  for (let i = 0; i < embedding.length; i++) z += w[i] * embedding[i];
  return 1 / (1 + Math.exp(-z));
}

/** End-to-end convenience: text → P(is_work). Encodes + predicts in one call.
 *  Returns null if model files missing — caller should fall back gracefully.
 *  For prefetch hot path, prefer `embedTextForWork` then
 *  `predictIsWorkFromEmbedding` so the embedding can be cached to DB. */
export async function predictIsWork(text: string): Promise<number | null> {
  if (!isWorkEmbedderAvailable()) return null;
  const emb = await embedTextForWork(text);
  return predictIsWorkFromEmbedding(emb);
}

/** Pack a Float32Array embedding into a SQLite BLOB. Mirrors the helper in
 *  lib/embedder.ts for symmetry. */
export function workEmbeddingToBlob(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

/** Decode a SQLite BLOB back to Float32Array. */
export function blobToWorkEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
