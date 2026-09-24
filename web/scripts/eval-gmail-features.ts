/**
 * Eval script: compare classifier predictions BEFORE vs AFTER Gmail-style
 * feature integration. Outputs JSON consumed by /tmp/build-eval-html.py to
 * produce the visual report.
 *
 * Steps:
 *   1. Load OLD head from disk (web/models/setfit-classify/head.json — 384-d).
 *   2. Force PROD-snapshot DB.
 *   3. For every email with classify_embedding != NULL, predict with OLD head.
 *   4. Train NEW 394-d head (full retrain) from same training pool but with
 *      sender-features concatenated.
 *   5. For same emails, predict with NEW head + features.
 *   6. Emit a per-email diff: old_label vs new_label, old_conf vs new_conf,
 *      pass_rate before vs after.
 *
 * Usage:
 *   EMAILDIGEST_DIR=/tmp/gmail-features-snapshot \
 *     npx tsx scripts/eval-gmail-features.ts > /tmp/eval-results.json
 */
import { invalidateHeadCache, predictClassifyFromEmbedding, blobToClassifyEmbedding, CLASSIFY_LABELS, CLASSIFY_PREDICT_THRESHOLD } from "../lib/classify-embedder";
import { computeSenderFeatures } from "../lib/sender-features";
import { trainSetfitClassifyHead } from "../lib/setfit-classify-head";
import { setAppState, getAppState } from "../lib/db";
import db from "../lib/db";

interface EmailRow {
  id: string;
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
  classify_embedding: Buffer;
  classifier: string;
  category_id: string | null;
  list_unsubscribe: string;
  list_id: string;
  auto_submitted: string;
  precedence: string;
  classified_at: number | null;
  confidence: number;
}

interface EvalResult {
  id: string;
  from: string;
  from_email: string;
  subject: string;
  prod_classifier: string;
  prod_category: string | null;
  prod_confidence: number;
  old_label: string;
  old_top1: number;
  old_confident: boolean;
  new_label: string;
  new_top1: number;
  new_confident: boolean;
  features: {
    read_rate_30d: number;
    reply_count: number;
    sender_freq_30d: number;
    is_system_sender: number;
    is_first_contact: number;
    has_list_unsubscribe: number;
    has_list_id: number;
    is_auto_submitted: number;
    is_bulk_precedence: number;
  };
}

async function main() {
  // STEP 1: load OLD head from disk (force-bypass any runtime override so we
  // measure baseline behavior, not the chain-of-warm-starts state).
  // We do this by temporarily clearing the runtime app_state key.
  const oldRuntime = getAppState("setfit_classify_head_runtime");
  if (oldRuntime) setAppState("setfit_classify_head_runtime", "");
  invalidateHeadCache();

  const rows = db.prepare(`
    SELECT id, from_name, from_email, subject, snippet, classify_embedding,
           classifier, category_id, list_unsubscribe, list_id, auto_submitted,
           precedence, classified_at, confidence
    FROM emails
    WHERE classify_embedding IS NOT NULL
      AND classifier IN ('setfit', 'llm', 'user')
      AND classified_at IS NOT NULL
    ORDER BY classified_at DESC
    LIMIT 500
  `).all() as EmailRow[];

  console.error(`[eval] OLD head loaded, ${rows.length} emails with classify_embedding to evaluate`);

  // STEP 2: predict with OLD head for every row (no features = legacy 384-d path)
  const oldPredictions = new Map<string, { label: string; top1: number; confident: boolean }>();
  for (const r of rows) {
    const emb = blobToClassifyEmbedding(r.classify_embedding);
    const pred = predictClassifyFromEmbedding(emb);
    if (pred) {
      oldPredictions.set(r.id, { label: pred.label, top1: pred.top1, confident: pred.confident });
    }
  }
  console.error(`[eval] OLD predictions cached: ${oldPredictions.size}`);

  // STEP 3: train NEW 394-d head (full retrain with features).
  // Explicit useFeatures=true required — default is 384-d for production safety.
  console.error(`[eval] Training NEW 394-d head (useFeatures=true)...`);
  const t0 = Date.now();
  const stats = trainSetfitClassifyHead({ warmStart: false, iterations: 4000, useFeatures: true });
  console.error(`[eval] Train done in ${Date.now() - t0}ms`);
  console.error(`[eval] Train stats:`, JSON.stringify(stats));

  // STEP 4: predict with NEW head + features
  invalidateHeadCache();
  const newPredictions: EvalResult[] = [];
  for (const r of rows) {
    const emb = blobToClassifyEmbedding(r.classify_embedding);
    const senderFeats = computeSenderFeatures({
      fromEmail: r.from_email,
      excludeEmailId: r.id,
      listUnsubscribe: r.list_unsubscribe,
      listId: r.list_id,
      autoSubmitted: r.auto_submitted,
      precedence: r.precedence,
    });
    const pred = predictClassifyFromEmbedding(emb, senderFeats);
    const old = oldPredictions.get(r.id);
    if (!pred || !old) continue;

    newPredictions.push({
      id: r.id,
      from: r.from_name,
      from_email: r.from_email,
      subject: r.subject,
      prod_classifier: r.classifier,
      prod_category: r.category_id,
      prod_confidence: r.confidence,
      old_label: old.label,
      old_top1: old.top1,
      old_confident: old.confident,
      new_label: pred.label,
      new_top1: pred.top1,
      new_confident: pred.confident,
      features: {
        read_rate_30d: senderFeats.read_rate_30d,
        reply_count: senderFeats.reply_count,
        sender_freq_30d: senderFeats.sender_freq_30d,
        is_system_sender: senderFeats.is_system_sender,
        is_first_contact: senderFeats.is_first_contact,
        has_list_unsubscribe: senderFeats.has_list_unsubscribe,
        has_list_id: senderFeats.has_list_id,
        is_auto_submitted: senderFeats.is_auto_submitted,
        is_bulk_precedence: senderFeats.is_bulk_precedence,
      },
    });
  }

  // STEP 5: aggregate pass rate stats
  const oldPassRate = newPredictions.filter((p) => p.old_confident).length / newPredictions.length;
  const newPassRate = newPredictions.filter((p) => p.new_confident).length / newPredictions.length;
  const labelChanges = newPredictions.filter((p) => p.old_label !== p.new_label).length;

  // STEP 6: emit JSON
  const summary = {
    threshold: CLASSIFY_PREDICT_THRESHOLD,
    labels: CLASSIFY_LABELS,
    total: newPredictions.length,
    old_pass_rate: oldPassRate,
    new_pass_rate: newPassRate,
    label_changes: labelChanges,
    train_stats: stats,
    feature_coverage: {
      list_unsubscribe: db.prepare("SELECT COUNT(*) AS n FROM emails WHERE list_unsubscribe != ''").get(),
      list_id: db.prepare("SELECT COUNT(*) AS n FROM emails WHERE list_id != ''").get(),
      auto_submitted: db.prepare("SELECT COUNT(*) AS n FROM emails WHERE auto_submitted NOT IN ('', 'no')").get(),
      precedence: db.prepare("SELECT COUNT(*) AS n FROM emails WHERE precedence IN ('bulk','list','junk')").get(),
    },
  };

  // STDOUT: full JSON for HTML builder
  process.stdout.write(JSON.stringify({ summary, predictions: newPredictions }, null, 2));

  // Restore the previous runtime head so we don't leave the snapshot DB in a
  // weird state (it's a snapshot — but be tidy).
  if (oldRuntime) setAppState("setfit_classify_head_runtime", oldRuntime);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
