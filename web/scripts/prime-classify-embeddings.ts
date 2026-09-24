/**
 * One-shot: encode classify_embedding for any labeled emails (in
 * category_examples) that don't have one cached yet. Used for testing the
 * warm-start retrain locally before PROD prefetch has populated the column.
 */
import db, { updateClassifyEmbedding } from "../lib/db";
import {
  isClassifyEmbedderAvailable,
  embedTextForClassify,
  classifyEmbeddingToBlob,
} from "../lib/classify-embedder";

if (!isClassifyEmbedderAvailable()) {
  console.error("SetFit classify model not available — check web/models/setfit-classify/");
  process.exit(1);
}

const rows = db.prepare(`
  SELECT DISTINCT e.id, e.subject, e.snippet
  FROM category_examples ce
  JOIN emails e ON e.id = ce.email_id
  WHERE e.classify_embedding IS NULL
    AND ce.category_id IN ('cat_primary','cat_track','cat_news','cat_junk')
  LIMIT 100
`).all() as Array<{ id: string; subject: string; snippet: string }>;

(async () => {
  console.log(`Encoding ${rows.length} emails...`);
  const t0 = Date.now();
  let done = 0;
  for (const r of rows) {
    try {
      const text = (r.subject || "").slice(0, 200) + "\n" + (r.snippet || "").slice(0, 1500);
      const emb = await embedTextForClassify(text);
      updateClassifyEmbedding(r.id, classifyEmbeddingToBlob(emb));
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${rows.length}`);
    } catch (e) {
      console.warn(`  ${r.id} failed:`, e);
    }
  }
  console.log(`Done. Encoded ${done} in ${Date.now() - t0}ms (${Math.round((Date.now() - t0) / Math.max(1, done))}ms/email)`);
})();
