/**
 * Sanity-check SetFit-classify ONNX inference: pull recent emails from
 * data.db, run the JS pipeline (encode + LR head + softmax), report top1
 * + margin distribution. Confirms parity with Python eval.
 *
 * Usage: cd web && npx tsx scripts/test-setfit-classify.ts
 */
import db from "../lib/db";
import {
  isClassifyEmbedderAvailable,
  embedTextForClassify,
  predictClassifyFromEmbedding,
  CLASSIFY_PREDICT_THRESHOLD,
} from "../lib/classify-embedder";

interface Row { id: string; from_name: string; subject: string; body: string; category_id: string | null; }

async function main() {
  if (!isClassifyEmbedderAvailable()) {
    console.error("SetFit-classify model files missing. Run training/setfit-classify/train.py first.");
    process.exit(1);
  }

  const rows = db.prepare(`
    SELECT id, from_name, COALESCE(body, snippet, '') AS body, subject, category_id
    FROM emails
    WHERE COALESCE(body, snippet, '') != ''
      AND category_id IN ('cat_primary','cat_track','cat_news','cat_junk')
    ORDER BY received_at DESC
    LIMIT 80
  `).all() as Row[];

  console.log(`=== SetFit-classify JS eval on ${rows.length} recent labeled emails ===`);

  let total = 0, agree = 0, confident = 0, confidentAgree = 0;
  const dist: Record<string, number> = {};
  const start = Date.now();
  const margins: number[] = [];
  const top1s: number[] = [];

  for (const r of rows) {
    const text = (r.subject || "").slice(0, 200) + "\n" + (r.body || "").slice(0, 1500);
    const emb = await embedTextForClassify(text);
    const pred = predictClassifyFromEmbedding(emb);
    if (!pred) { console.log("MODEL MISSING"); continue; }
    total++;
    margins.push(pred.margin);
    top1s.push(pred.top1);
    dist[pred.label] = (dist[pred.label] || 0) + 1;
    const ok = pred.label === r.category_id;
    if (ok) agree++;
    if (pred.confident) {
      confident++;
      if (ok) confidentAgree++;
    }
    if (!ok || pred.top1 < 0.95) {
      const tag = ok ? "✓" : "✗";
      console.log(
        `  ${tag} P=${pred.top1.toFixed(2)} m=${pred.margin.toFixed(2)} `
        + `pred=${pred.label.slice(4).padEnd(7)} true=${(r.category_id || "").slice(4).padEnd(7)} `
        + `${r.from_name.slice(0, 28).padEnd(30)} ${(r.subject || "").slice(0, 50)}`,
      );
    }
  }

  const elapsed = (Date.now() - start) / 1000;
  console.log(`\n=== summary ===`);
  console.log(`encoded ${total} emails in ${elapsed.toFixed(1)}s (${(elapsed * 1000 / total).toFixed(0)}ms/email)`);
  console.log(`agreement vs LLM-labeled: ${agree}/${total} = ${(100 * agree / total).toFixed(1)}%`);
  console.log(`confident (top1 ≥ ${CLASSIFY_PREDICT_THRESHOLD}): ${confident}/${total} = ${(100 * confident / total).toFixed(1)}%`);
  console.log(`confident-and-correct: ${confidentAgree}/${confident} = ${confident > 0 ? (100 * confidentAgree / confident).toFixed(1) : 0}%`);
  console.log(`predict distribution:`, dist);

  // percentiles
  margins.sort((a, b) => a - b);
  top1s.sort((a, b) => a - b);
  const p = (arr: number[], q: number) => arr[Math.floor(arr.length * q / 100)];
  console.log(`top1   p10=${p(top1s, 10).toFixed(2)} p50=${p(top1s, 50).toFixed(2)} p90=${p(top1s, 90).toFixed(2)}`);
  console.log(`margin p10=${p(margins, 10).toFixed(2)} p50=${p(margins, 50).toFixed(2)} p90=${p(margins, 90).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
