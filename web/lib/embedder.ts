import path from "path";
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { isDemoMode } from "./demo";

// English sentence embedder. 99% of the user's inbox is English; a dedicated
// English model outperforms the multilingual variant on in-domain retrieval.
// Cross-lingual queries (zh → en inbox) are handled at query time by Claude
// translating before calling the search_emails tool — NOT by the embedder.
const MODEL_ID = process.env.EMAILDIGEST_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;

/**
 * Where the model files come from.
 *
 * EMAILDIGEST_MODEL_CACHE: a directory holding `<model id>/…` (config,
 * tokenizer, onnx/). It is used both as transformers.js' local model path and
 * as its download cache. Pre-populate it with
 * `EMAILDIGEST_MODEL_CACHE=<dir> npx tsx scripts/fetch-embedder-model.ts`.
 *
 * DEMO_MODE: remote downloads are disabled (process-wide), so a missing
 * cache fails closed instead of calling huggingface.co. The SetFit encoders
 * (lib/work-embedder.ts, lib/classify-embedder.ts) load from absolute local
 * paths and are unaffected.
 */
export function configureModelSource(): void {
  const cache = process.env.EMAILDIGEST_MODEL_CACHE;
  if (cache) {
    env.localModelPath = path.resolve(cache);
    env.cacheDir = path.resolve(cache);
  }
  if (isDemoMode()) env.allowRemoteModels = false;
}
configureModelSource();

let instance: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (instance) return instance;
  if (!loadingPromise) {
    console.log(`[embedder] Loading ${MODEL_ID}...`);
    loadingPromise = (pipeline("feature-extraction", MODEL_ID) as Promise<FeatureExtractionPipeline>)
      .then((p) => {
        instance = p;
        console.log(`[embedder] Model loaded`);
        return p;
      })
      .finally(() => { loadingPromise = null; });
  }
  return loadingPromise;
}

/** Embed a text string into a 384-dim L2-normalized vector. */
export async function embedText(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  // output is a Tensor: { data: Float32Array(384), dims: [1, 384] }
  const data = output.data as Float32Array;
  if (data.length !== EMBED_DIM) {
    throw new Error(`[embedder] Expected ${EMBED_DIM} dims, got ${data.length}`);
  }
  // Copy to a fresh Float32Array to detach from the underlying pipeline buffer
  return new Float32Array(data);
}

/** Build the canonical text representation of an email for embedding. */
export function buildEmbedText(args: {
  fromEmail: string;
  fromName?: string;
  subject: string;
  body?: string;
  snippet?: string;
}): string {
  const content = (args.body?.trim() || args.snippet?.trim() || "").slice(0, 500);
  const sender = args.fromEmail || args.fromName || "";
  return `Sender: ${sender}\nSubject: ${args.subject}\n${content}`;
}

/** Pack a Float32Array into a binary Buffer for SQLite BLOB storage (1536 bytes for 384 floats). */
export function embeddingToBlob(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

/** Unpack a SQLite BLOB back into a Float32Array. */
export function blobToEmbedding(buf: Buffer): Float32Array {
  // Copy the bytes to ensure proper alignment and ownership
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** Cosine similarity between two L2-normalized vectors = dot product. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`[embedder] dim mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Weighted centroid — each input contributes proportionally to its weight.
 * Used by the two-tier classifier to let user-picked examples dominate over
 * rule-labeled background data.
 *
 *   centroid = Σ(wᵢ · vᵢ) / Σ(wᵢ)   (then L2-normalized)
 */
export function computeWeightedCentroid(items: Array<{ vector: Float32Array; weight: number }>): Float32Array {
  if (items.length === 0) {
    throw new Error("[embedder] computeWeightedCentroid: empty input");
  }
  const dim = items[0].vector.length;
  const sum = new Float32Array(dim);
  let totalWeight = 0;
  for (const { vector, weight } of items) {
    if (weight <= 0) continue;
    for (let i = 0; i < dim; i++) sum[i] += vector[i] * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) throw new Error("[embedder] computeWeightedCentroid: all weights zero");
  for (let i = 0; i < dim; i++) sum[i] /= totalWeight;
  // L2 normalize so cosine similarity stays in [-1, 1]
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) sum[i] /= norm;
  }
  return sum;
}

export { EMBED_DIM, MODEL_ID };
