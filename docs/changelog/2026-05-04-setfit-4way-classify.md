# 2026-05-04 — SetFit 4-way Inbox classifier

> **UPDATE 2026-05-08**: the "MiniLM centroid fallback" described below as a
> safety net was retired in the same week. SetFit ship surfaced an unrelated
> bug — `/api/emails action=reclassifyUnclassified` was bypassing SetFit
> entirely — and the fix consolidated the chain to **SetFit → LLM** (no
> middle layer). See `docs/lessons-learned.md` §23 for the post-mortem.
> References below to `classifyByCentroid` / `lib/minilm-classifier.ts` are
> accurate **at the time of this change** but no longer reflect current code.

> **UPDATE 2026-05-13**: PROD pass rate observed at 40% (vs ship-time 100%
> confident pass + 97.8% train accuracy). Root cause **was not** the
> 2026-05-08 `llm_high_conf` weight bump 10→25 as the 72h-check doc had
> hypothesized — it was a structural gap between Python training and TS
> warm-start retrain. Python training computes embeddings on demand and sees
> all 354 examples; TS warm-start (`getLabeledClassifySamples`) JOINs to
> `emails.classify_embedding` and only sees ~169 of them, because emails
> classified BEFORE SetFit ship (2026-05-07) have NULL in that column. The
> weight-bump retrain silently overwrote the high-quality Python head with a
> subset-trained head (train acc 97.8% → 81.1%) without warning. Fix shipped
> in same week: backfill orphan embeddings on startup, add coverage invariant
> check at retrain entry, full retrain on 504 → 220+orphans samples. See
> `docs/lessons-learned.md` §24 for the post-mortem and
> `docs/observations/setfit-warmstart-coverage-24h-check.md` for the 24h
> verification plan.

**Branch**: `feat/setfit-4way-classify`
**Status**: code committed locally (`c1d1cc8`), NOT pushed, NOT deployed
**Predecessor**: `feat/setfit-work-classifier` (already in master) extended is_work to SetFit; this generalizes the approach to primary/track/news/junk

## Why

`merged-prefetch` was burning 20 spawn/day on PROD. Per-spawn breakdown showed
each spawn classified exactly 1 email — the "merged" name only refers to
combining classify+jobs prompts, not to batching arrivals. Root cause was that
the upstream MiniLM gate (`classifyByCentroid` in `lib/minilm-classifier.ts`)
only let 35% of arrivals through with confidence; remaining 65% all hit the
Sonnet LLM fallback. 35% is not a tuning artefact — it is the upper bound for
a generic 2019 sentence embedder asked to do 4-way classification. cat_track
and cat_news live at cosine ~0.6-0.7 in MiniLM space; centroids smear; cosine
distance has too much variance for reliable margin > 0.05 decisions.

is_work SetFit (already in master) had taken FPR from 71% → 0.4% on the same
corpus by contrastive-fine-tuning the same MiniLM body for the binary task.
This change applies the identical pattern to the 4-class problem.

## What changed

### New files

- `training/setfit-classify/train.py` — Python contrastive fine-tune. Reads
  412 labeled samples from `category_examples` (sources `user_correction` +
  `llm_high_conf`, skipping `spam_corpus` rows that lack bodies). Trains for
  40 iterations of pair sampling on top of `sentence-transformers/all-MiniLM-L6-v2`.
  Output: HF-format encoder + `head.json` (4-class LR coef + intercept).
  Runtime: 27 min on M1 CPU.
- `training/setfit-classify/eval.py` — held-out + training-set eval, with
  per-class confusion, threshold sweep (skip-LLM rate at θ ∈ {0.5...0.95}),
  margin percentiles, and disagreement listing.
- `web/lib/classify-embedder.ts` — JS inference: ONNX encode → 4-class LR →
  numerically-stable softmax → `ClassifyPrediction` with top1, top2, margin,
  full probs, `confident` flag at θ=0.80. Mirrors `work-embedder.ts` shape
  (per-call `local_files_only` to avoid global env pollution).
- `web/scripts/test-setfit-classify.ts` — JS smoke test on recent labeled
  emails; prints disagreements + margin distribution.
- `web/models/setfit-classify/` — config, tokenizer, vocab, head.json
  (committed). `onnx/model.onnx` (86 MB) is gitignored; deploy via scp like
  setfit-work.

### Modified files

- `web/lib/db.ts` — `ALTER TABLE emails ADD COLUMN classify_embedding BLOB`
  (idempotent try/catch). New helpers `updateClassifyEmbedding` and
  `getLabeledClassifySamples`. The `embedding` column (generic MiniLM) stays
  for centroid backward-compat.
- `web/lib/prefetch.ts` — Step 2a now tries SetFit first, centroid as fallback:
  - If `isClassifyEmbedderAvailable()`, encode with SetFit body, write
    `classify_embedding` cache, run LR head. If `top1 ≥ 0.80`, write
    `classifier='setfit'`.
  - Else (or below threshold), call `classifyByCentroid` (the legacy MiniLM
    path) as before. If that's also not confident, queue for LLM.
  - Two new `UPDATE` prepared statements: `setfitStmt` (writes
    `classifier='setfit'`) and the existing `minilmStmt` for fallback.
- `web/instrumentation.ts` — startup warm-up for the classify encoder. Same
  fire-and-forget shape as work-encoder warmup; logs `SetFit
  classify-encoder warm` once loaded.
- `.gitignore` — adds `training/setfit-classify/{out,checkpoints,__pycache__}/`
  and `web/models/setfit-classify/onnx/model.onnx`.

## Eval results

**Train accuracy** (354 in-training samples, 27-min training): 97.8%

**Held-out** (35 emails not in `category_examples`): 34/35 = 97.1%. The one
"miss" was a Company A application receipt: SetFit said `track` (correct —
transactional confirmation), the LLM had labeled it `primary` (wrong). True
accuracy is therefore ≥97%.

**JS smoke test** (80 most-recent labeled emails on local DB):
- 80/80 cross θ=0.80 confident gate (100% confident pass rate)
- 78/80 = 97.5% match LLM label
- 2 disagreements both look like LLM mislabels, not model errors
- 21ms/email encode time (M1 CPU, comparable on PROD t2.medium)
- top1 percentiles: p10=0.93, p50=0.97, p90=0.97
- margin percentiles: p10=0.91, p50=0.95, p90=0.96 — model is extremely decisive

**Spawn projection**:
- Current MiniLM 35% pass → 65% LLM = ~20 spawn/day
- SetFit 97-100% pass → ~0-3% LLM = ~0-1 spawn/day
- ~95% reduction on the merged-prefetch line

## Audit (system-seam check)

| Concern | Status |
|---|---|
| Schema migration | ✓ idempotent ALTER TABLE in try/catch (db.ts:48); existing rows get NULL by default |
| `classifier='setfit'` value compat | ✓ all overwrite checks use `classifier NOT IN ('user','llm')` — 'setfit' is treated identically to 'minilm', i.e. overwritable by future LLM/user verdicts |
| Memory budget on PROD | ✓ ~262MB total for 3 encoders (90 + 86 + 86) on a 3.8GB instance with ~700MB Next.js baseline |
| Fallback path when ONNX missing | ✓ `isClassifyEmbedderAvailable()` returns false → `confidentCategoryId` stays null after SetFit branch → falls through to `classifyByCentroid` (legacy path), identical pre-branch behavior |
| Existing emails not affected | ✓ Step 2a SQL filter `WHERE category_id IS NULL` only touches new arrivals; PROD's 400 existing classifications stay |
| `needsUserConfirm` UX | ✓ N/A — no active code reads it; only design-doc reference |
| **User-correction warm-start retrain** | ⚠️ **GAP — see follow-up below** |

### v1.1 follow-up (logged, not blocking ship)

When user changes category via right-click or active-learning Confirm,
`/api/emails action=setCategory` calls `addExampleAndRecompute` which writes
to `category_examples` and recomputes the centroid. The centroid is now the
fallback path — SetFit head doesn't see this update.

is_work has the parallel mechanism in `web/lib/setfit-head.ts` (warm-start
retrain). The classify side needs the same: a `web/lib/setfit-classify-head.ts`
that retrains the multi-class LR head from labeled samples + cached
classify_embedding, plus a hook in `/api/emails action=setCategory` to
ensure the embedding is cached and call the warm-start.

Practical impact today: PROD has 3 user_correction samples ever. Effect of
NOT having warm-start: near zero in the immediate term; the row is still
protected from re-classification by `classifier='user'`. Long-term: SetFit
won't learn from user nudges going forward, regression vs. centroid path.

## Deployment plan (NOT executed)

1. **scp ONNX to PROD**: `scp web/models/setfit-classify/onnx/model.onnx prod:~/emaildigest/web/models/setfit-classify/onnx/`
2. **push branch**: `git push origin feat/setfit-4way-classify`
3. **merge to master**: `git checkout master && git merge --no-ff feat/setfit-4way-classify` then `git push origin master`
4. CI auto-deploys; PROD restart loads SetFit and starts populating
   `classify_embedding` cache as new emails arrive.
5. Watch for `SetFit classify-encoder warm` line in startup logs.
6. After 24h of activity, re-run token-check; merged-prefetch line should
   drop from ~20/day to ~0-3/day.

If ONNX scp is forgotten, the system falls back to centroid silently — fail-safe
matches the is_work deployment pattern.

## Spawn-budget projection update

Pre-branch (verified 2026-05-04 on PROD):
```
merged-prefetch  20/day  (Sonnet, 1 email per spawn)
email-digest      6/day  (Sonnet, 2h stale-check)
ask-ai            3/day  (Sonnet, user-driven)
event-extract     0-1/day (Haiku, button-triggered)
                 ────
total           ~30/day
```

Post-branch (projected):
```
merged-prefetch    1/day
email-digest       6/day
ask-ai             3/day
event-extract      1/day
                 ────
total            ~11/day  (~63% reduction vs pre-branch)
```

This stacks with the 2026-05-04 junk-arrival filter on email-digest
(commit 5efa6e9). Together they push from ~30/day → ~11/day, well within
the 25-30 budget bracket and far below the 300 ban-trigger.
