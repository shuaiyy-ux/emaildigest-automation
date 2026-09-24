/**
 * Work-seed centroid — the ingress tag ("maybe_work") for the Jobs pipeline.
 *
 * Business logic: every email that lands in Inbox is compared (via MiniLM
 * embedding cosine) against a "work-related" seed centroid. If cosine >
 * threshold, the email is tagged maybe_work=1 and handed off to the Jobs
 * pipeline. Inbox never looks at this flag — it's a one-way tap.
 *
 * The seed is bootstrapped from ~10 canonical work-email description texts,
 * averaged. Once user feedback arrives (via Jobs "not a job email" / "send
 * to Jobs"), the seed drifts toward the user's real distribution.
 */
import { embedText, embeddingToBlob, blobToEmbedding, computeWeightedCentroid, cosineSimilarity } from "./embedder";
import { getAppState, setAppState } from "./db";

const SEED_KEY = "work_seed_centroid";
const DRIFT_WEIGHT_POSITIVE = 5;   // "send to Jobs" (user says we missed)
const DRIFT_WEIGHT_NEGATIVE = 5;   // "not a job email" (user says we over-tagged)

/** Cosine threshold for maybe_work. Wide net — false positives get gated by Jobs Step 1 LLM. */
export const MAYBE_WORK_THRESHOLD = 0.25;

/** 10 canonical work-email descriptions — the bootstrap distribution. */
const SEED_TEXTS: string[] = [
  "Thank you for applying to the Software Engineer position at our company",
  "Your application has been received by our hiring team — next steps will follow",
  "Interview invitation for the Data Scientist role — please pick a time slot",
  "Online assessment link, please complete the coding challenge by Friday",
  "We would like to schedule a call to discuss your candidacy and the opportunity",
  "Offer letter attached — please review the compensation details and sign to accept",
  "Unfortunately we have decided not to move forward with your application at this time",
  "Recruiter from Meta reaching out about a senior engineering opportunity",
  "Coding challenge instructions for the next interview round, take-home project",
  "HR follow-up regarding your interview last week, checking in on next steps",
];

function serializeCentroid(vec: Float32Array): string {
  return embeddingToBlob(vec).toString("base64");
}

function deserializeCentroid(s: string): Float32Array {
  return blobToEmbedding(Buffer.from(s, "base64"));
}

let cache: Float32Array | null = null;

/** Ensure the work-seed centroid exists; compute from bootstrap texts if missing. Called on startup. */
export async function ensureWorkSeed(): Promise<void> {
  const existing = getAppState(SEED_KEY);
  if (existing) {
    cache = deserializeCentroid(existing);
    return;
  }
  console.log("[work-seed] Bootstrapping from 10 canonical texts...");
  const vecs: Float32Array[] = [];
  for (const text of SEED_TEXTS) {
    vecs.push(await embedText(text));
  }
  const centroid = computeWeightedCentroid(vecs.map((v) => ({ vector: v, weight: 1 })));
  setAppState(SEED_KEY, serializeCentroid(centroid));
  cache = centroid;
  console.log("[work-seed] Seed centroid stored.");
}

function getSeed(): Float32Array | null {
  if (cache) return cache;
  const stored = getAppState(SEED_KEY);
  if (!stored) return null;
  cache = deserializeCentroid(stored);
  return cache;
}

/**
 * True if this email should enter the Jobs pipeline.
 *
 * Preferred path: the trained logistic-regression classifier (work-classifier.ts).
 * Fallback (when classifier has no weights yet, i.e. before first training run):
 *   cosine to the seed centroid > MAYBE_WORK_THRESHOLD. Wider net, LLM gates.
 *
 * This lets fresh installs still feed Jobs while the model is bootstrapped;
 * once trained, the classifier takes over and is strictly authoritative.
 */
export function isMaybeWork(embedding: Float32Array): boolean {
  // Lazy import avoids circular dep at module load
  const wc = require("./work-classifier") as typeof import("./work-classifier");
  if (wc.loadWeights()) {
    return wc.isWorkEmail(embedding);
  }
  const seed = getSeed();
  if (!seed) return false;
  return cosineSimilarity(embedding, seed) > MAYBE_WORK_THRESHOLD;
}

/**
 * Drift the seed centroid toward (positive) or away from (negative) a user-
 * corrected email's embedding. Weighted average:
 *   new_seed = (1 · old_seed + w · signal) / (1 + w)    for positive
 *   new_seed = (1 · old_seed - w · signal) / max(ε, 1 - w)   for negative — push away
 *
 * Implementation: treat as a single weighted-centroid recompute using two items.
 */
export function driftWorkSeed(sample: Float32Array, polarity: "positive" | "negative") {
  const seed = getSeed();
  if (!seed) return;
  const w = polarity === "positive" ? DRIFT_WEIGHT_POSITIVE : -DRIFT_WEIGHT_NEGATIVE;
  // Negative weights supported by computeWeightedCentroid? Check: weights <= 0 skipped.
  // So we can't just use negative weight. Do it manually.
  const dim = seed.length;
  const out = new Float32Array(dim);
  if (polarity === "positive") {
    const total = 1 + DRIFT_WEIGHT_POSITIVE;
    for (let i = 0; i < dim; i++) out[i] = (seed[i] + DRIFT_WEIGHT_POSITIVE * sample[i]) / total;
  } else {
    // Repel: move seed away from sample direction. Subtract sample*w, then renormalize.
    for (let i = 0; i < dim; i++) out[i] = seed[i] - (DRIFT_WEIGHT_NEGATIVE / 100) * sample[i];
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) out[i] /= norm;
  setAppState(SEED_KEY, serializeCentroid(out));
  cache = out;
  console.log(`[work-seed] Drift ${polarity} applied; w=${w}`);
}

/** Force re-bootstrap from canonical texts. Used by reset-and-replay. */
export async function resetWorkSeed(): Promise<void> {
  cache = null;
  setAppState(SEED_KEY, ""); // mark empty
  // Then recompute
  const vecs: Float32Array[] = [];
  for (const text of SEED_TEXTS) vecs.push(await embedText(text));
  const centroid = computeWeightedCentroid(vecs.map((v) => ({ vector: v, weight: 1 })));
  setAppState(SEED_KEY, serializeCentroid(centroid));
  cache = centroid;
  console.log("[work-seed] Reset from 10 canonical texts.");
}
