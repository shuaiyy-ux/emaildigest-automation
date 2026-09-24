/**
 * SetFit 4-way classify head — runtime warm-start retrain.
 *
 * Multi-class analog of lib/setfit-head.ts. The body (encoder) is fine-tuned
 * offline in Python; we ship the ONNX. The HEAD on top is multinomial logistic
 * regression — trained on the SetFit-tuned `classify_embedding` column +
 * `category_examples` labels.
 *
 * Retrain triggers:
 *   - User changes category in CategoryPicker → /api/emails action=setCategory
 *     → addCategoryExample (insert) + queueMicrotask
 *       trainSetfitClassifyHead({ warmStart: true }) (this file)
 *
 * Warm-start: start from current head weights, run 50 iters. ~150ms on ~400 samples.
 *
 * Storage: `app_state.setfit_classify_head_runtime` (JSON), preferred over
 * `web/models/setfit-classify/head.json` by classify-embedder.loadHead().
 *
 * Class index order MUST match CLASSIFY_LABELS at all times — LR weights are
 * per-class-index. Loading a head trained with a different label order silently
 * scrambles predictions.
 */
import { getAppState, setAppState, getLabeledClassifySamples, countTrainableCategoryExamples } from "./db";
import {
  CLASSIFY_EMBED_DIM,
  CLASSIFY_INPUT_DIM,
  CLASSIFY_NUM_CLASSES,
  CLASSIFY_LABELS,
  blobToClassifyEmbedding,
  loadHead,
  invalidateHeadCache,
  type ClassifyHeadParams,
} from "./classify-embedder";
import { computeSenderFeatures, featuresToVector, concatEmbeddingWithFeatures } from "./sender-features";

const RUNTIME_KEY = "setfit_classify_head_runtime";
const VERSION_KEY = "setfit_classify_head_version";

/** Per-source weight multipliers — sole source of truth for Inbox classifier
 *  weighting since the legacy MiniLM centroid was retired (2026-05-08).
 *
 *  llm_high_conf bumped 10→25 (2026-05-08): with user_correction supply
 *  trickling in (2 rows on PROD vs 167 llm_high_conf), the prior 10:50 ratio
 *  starved the head of fresh signal between user nudges. 25:50 keeps user
 *  authoritative (2× still) while letting accumulated LLM verdicts actually
 *  shift weights at retrain.
 *
 *  llm_med_conf added (2026-05-14): LLM now self-rates high/medium/low; the
 *  medium tier carries weaker signal than high, so it earns a lower weight
 *  (5, matching bootstrap). Low-tier LLM verdicts are NOT回灌 at all —
 *  they're guesses, valuable for routing but not as training labels.
 *  See web/lib/llm-classify.ts mapLLMConfidence + lessons-learned §25. */
const SOURCE_WEIGHTS: Record<string, number> = {
  user_correction: 50,
  llm_high_conf: 25,
  llm_med_conf: 5,
  bootstrap: 5,
  spam_corpus: 3,
  bulk_import: 1,
};
function sourceWeight(source: string): number {
  return SOURCE_WEIGHTS[source] ?? 1;
}

/** Map category_id → class index. Frozen from CLASSIFY_LABELS order. */
const LABEL_TO_INDEX = new Map<string, number>(
  CLASSIFY_LABELS.map((id, i) => [id, i]),
);

export interface ClassifyTrainStats {
  samples: number;
  perClass: Record<string, number>;
  finalLoss: number;
  accuracy: number;
  warmStarted: boolean;
  version: string;
}

/** Numerically-stable softmax over logits (in-place safe since we copy). */
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

/**
 * Train (or warm-start retrain) the multi-class LR head from
 * category_examples + cached SetFit embeddings (emails.classify_embedding).
 *
 * Throws if no labeled samples have classify_embedding cached — caller should
 * either ensure prefetch / setCategory has primed the cache, or swallow the
 * error (warm-start failure shouldn't block the user-correction flow; the
 * disk head.json keeps serving until the next successful retrain).
 */
export function trainSetfitClassifyHead(opts: {
  iterations?: number;
  learningRate?: number;
  l2Lambda?: number;
  warmStart?: boolean;
  /** Opt-in to the 394-d Gmail-style feature path. Default `false` means we
   *  train the historical 384-d head shape using only the SetFit embedding —
   *  matching production behavior. Set to `true` (typically only by a
   *  one-shot upgrade script) to concatenate the 10-dim sender-features
   *  vector and train a 394-d head.
   *
   *  This gate exists because the local eval (see /tmp/gmail-features-report.html)
   *  showed cat_primary +23 pp but cat_news -18 pp on a fresh 394-d retrain,
   *  net -5 pp overall. The 394-d code path is fully implemented, but
   *  activation is deferred until the cat_news regression is investigated.
   *  See branch `feat/gmail-style-features` merge commit + docs for context. */
  useFeatures?: boolean;
} = {}): ClassifyTrainStats {
  const warmStart = opts.warmStart ?? false;
  const useFeatures = opts.useFeatures ?? false;
  const iters = opts.iterations ?? (warmStart ? 50 : 500);
  const lr = opts.learningRate ?? 0.1;
  const lambda = opts.l2Lambda ?? 0.01;

  const rows = getLabeledClassifySamples();
  if (rows.length === 0) {
    throw new Error("[setfit-classify-head] no labeled samples with classify_embedding — wait for prefetch / setCategory to populate, then retry");
  }

  // §24 invariant: retrain on a subset is silent quality drop. Held-out eval
  // at ship was 97.8% on 354 samples; warm-start on 169 samples post-bump
  // crashed to 81.1%. Anything below 70% coverage means embed-backfill hasn't
  // caught up — log loudly so it surfaces in tail-of-logs review.
  const totalUsable = countTrainableCategoryExamples();
  if (totalUsable > 0) {
    const coverage = rows.length / totalUsable;
    if (coverage < 0.7) {
      console.warn(
        `[setfit-classify-head] WARNING: training subset coverage ${(coverage * 100).toFixed(1)}% ` +
        `(${rows.length}/${totalUsable}). Run scripts/backfill-classify-embedding.ts to encode orphans, ` +
        `or wait for instrumentation startup backfill batches to catch up. See lessons-learned §24.`,
      );
    }
  }

  // Filter rows to ones whose category_id is in CLASSIFY_LABELS (defensive —
  // category_examples schema only allows these 4 by current SQL, but a
  // future schema change shouldn't silently corrupt training).
  const usable = rows.filter((r) => LABEL_TO_INDEX.has(r.category_id));
  if (usable.length === 0) {
    throw new Error("[setfit-classify-head] no samples match CLASSIFY_LABELS");
  }

  // Two training shapes (gated by `useFeatures` — see opts comment):
  //   - useFeatures=false (default): 384-d input = SetFit embedding only.
  //     Matches production head dim, no behavioral feature signal injected.
  //   - useFeatures=true: 394-d input = concat(embedding, sender features).
  //     Activates Gmail-style behavioral signals; only used by explicit
  //     upgrade scripts after cat_news regression resolved.
  // computeSenderFeatures reads from emails + drafts so the row's `from_email`
  // and headers must already be persisted (they are, by definition — these
  // are existing training samples).
  const X: Float32Array[] = usable.map((r) => {
    const emb = blobToClassifyEmbedding(r.classify_embedding);
    if (!useFeatures) return emb;
    const feats = computeSenderFeatures({
      fromEmail: r.from_email,
      excludeEmailId: r.email_id,
      listUnsubscribe: r.list_unsubscribe,
      listId: r.list_id,
      autoSubmitted: r.auto_submitted,
      precedence: r.precedence,
    });
    return concatEmbeddingWithFeatures(emb, featuresToVector(feats));
  });
  const y: number[] = usable.map((r) => LABEL_TO_INDEX.get(r.category_id)!);
  const sources: string[] = usable.map((r) => r.source);
  const N = X.length;
  const DIM = useFeatures ? CLASSIFY_INPUT_DIM : CLASSIFY_EMBED_DIM;

  // Per-class counts for class-balance weighting
  const classCount = new Array(CLASSIFY_NUM_CLASSES).fill(0);
  for (const c of y) classCount[c]++;
  const perClass: Record<string, number> = {};
  for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) perClass[CLASSIFY_LABELS[c]] = classCount[c];

  // Sample weight = class-balance × source-priority
  // class weight: N / (K * count_c) — sklearn "balanced" formula
  const classWeight = classCount.map((cnt) => (cnt > 0 ? N / (CLASSIFY_NUM_CLASSES * cnt) : 0));
  const sampleWeights = y.map((c, i) => classWeight[c] * sourceWeight(sources[i]));

  // Initialize: warm-start from current head, or zero.
  //
  // Warm-start dim compatibility depends on useFeatures:
  //   useFeatures=false (DIM=384):
  //     - existing 384-d head → direct reuse
  //     - existing 394-d head → REFUSED (would corrupt; user must explicit
  //       opt back into 394-d to consume that head). Fall back to zero init.
  //   useFeatures=true (DIM=394):
  //     - existing 394-d head → direct reuse
  //     - existing 384-d head → zero-pad to 394-d (feature cols start at 0)
  let W: Float32Array[] = [];
  let B: Float32Array;
  let warmStarted = false;
  if (warmStart) {
    const existing = loadHead();
    const okClasses = existing?.coef.length === CLASSIFY_NUM_CLASSES;
    const okIntercept = existing?.intercept.length === CLASSIFY_NUM_CLASSES;
    const headDim = existing?.coef[0]?.length ?? 0;
    if (existing && okClasses && okIntercept && headDim === DIM) {
      // Exact dim match — direct reuse.
      W = existing.coef.map((row) => new Float32Array(row));
      B = new Float32Array(existing.intercept);
      warmStarted = true;
    } else if (existing && okClasses && okIntercept && useFeatures && headDim === CLASSIFY_EMBED_DIM) {
      // Upgrade path: 384-d → 394-d zero-pad. Only when explicitly opted in.
      W = existing.coef.map((row) => {
        const padded = new Float32Array(DIM);
        padded.set(row, 0);
        return padded;
      });
      B = new Float32Array(existing.intercept);
      warmStarted = true;
      console.log("[setfit-classify-head] warm-start from legacy 384-d head, zero-padded to 394-d");
    } else {
      for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) W.push(new Float32Array(DIM));
      B = new Float32Array(CLASSIFY_NUM_CLASSES);
    }
  } else {
    for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) W.push(new Float32Array(DIM));
    B = new Float32Array(CLASSIFY_NUM_CLASSES);
  }

  let finalLoss = 0;
  const logits = new Float32Array(CLASSIFY_NUM_CLASSES);

  for (let iter = 0; iter < iters; iter++) {
    const gradW: Float32Array[] = [];
    for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) gradW.push(new Float32Array(DIM));
    const gradB = new Float32Array(CLASSIFY_NUM_CLASSES);
    let loss = 0;

    for (let i = 0; i < N; i++) {
      const x = X[i];
      // Compute logits per class
      for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
        let z = B[c];
        const w = W[c];
        for (let d = 0; d < DIM; d++) z += w[d] * x[d];
        logits[c] = z;
      }
      const p = softmax(logits);
      const yi = y[i];
      const wi = sampleWeights[i];

      const eps = 1e-12;
      loss -= wi * Math.log(p[yi] + eps);

      // dL/dz_c = w_i * (p_c - I(c == yi))
      for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
        const indicator = c === yi ? 1 : 0;
        const grad = wi * (p[c] - indicator);
        gradB[c] += grad;
        const gWc = gradW[c];
        for (let d = 0; d < DIM; d++) gWc[d] += grad * x[d];
      }
    }

    // L2 regularization + average
    let wNorm = 0;
    for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
      gradB[c] /= N;
      const gWc = gradW[c];
      const Wc = W[c];
      for (let d = 0; d < DIM; d++) {
        gWc[d] = gWc[d] / N + lambda * Wc[d];
        wNorm += Wc[d] * Wc[d];
      }
    }
    loss = loss / N + (lambda / 2) * wNorm;
    finalLoss = loss;

    // Update
    for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
      B[c] -= lr * gradB[c];
      const gWc = gradW[c];
      const Wc = W[c];
      for (let d = 0; d < DIM; d++) Wc[d] -= lr * gWc[d];
    }
  }

  // Train accuracy
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const x = X[i];
    for (let c = 0; c < CLASSIFY_NUM_CLASSES; c++) {
      let z = B[c];
      const w = W[c];
      for (let d = 0; d < DIM; d++) z += w[d] * x[d];
      logits[c] = z;
    }
    const p = softmax(logits);
    let topIdx = 0, topVal = p[0];
    for (let c = 1; c < CLASSIFY_NUM_CLASSES; c++) if (p[c] > topVal) { topVal = p[c]; topIdx = c; }
    if (topIdx === y[i]) correct++;
  }
  const accuracy = correct / N;

  // Persist as JSON in app_state. Loader (classify-embedder.loadHead) prefers
  // this over the disk head.json.
  const head: ClassifyHeadParams = {
    coef: W.map((row) => Array.from(row)),
    intercept: Array.from(B),
    classes: Array.from({ length: CLASSIFY_NUM_CLASSES }, (_, i) => i),
    label_map: Object.fromEntries(CLASSIFY_LABELS.map((id, i) => [String(i), id])),
  };
  setAppState(RUNTIME_KEY, JSON.stringify(head));
  const version = `v${Date.now()}`;
  setAppState(VERSION_KEY, version);
  invalidateHeadCache();

  const ws = warmStarted ? "warm-start " : "full ";
  console.log(
    `[setfit-classify-head] ${ws}trained on ${N} samples (${JSON.stringify(perClass)}), ` +
    `iters=${iters}, final loss=${finalLoss.toFixed(4)}, acc=${(accuracy * 100).toFixed(1)}%, version=${version}`,
  );

  return { samples: N, perClass, finalLoss, accuracy, warmStarted, version };
}

/** Get the current runtime head version (for telemetry / staleness check). */
export function getSetfitClassifyHeadVersion(): string | null {
  return getAppState(VERSION_KEY);
}
