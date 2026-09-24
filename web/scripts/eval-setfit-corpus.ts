/**
 * Eval SetFit work-classifier on full local corpus.
 * Mirrors Python eval.py to confirm JS inference parity.
 */
import db from "../lib/db";
import { predictIsWork, isWorkEmbedderAvailable } from "../lib/work-embedder";

interface Row {
  id: string; from_name: string; subject: string; body: string;
  category_id: string | null; in_jobs: number; lbl_pos: number; lbl_neg: number;
}

async function main() {
  if (!isWorkEmbedderAvailable()) { console.error("Model missing"); process.exit(1); }

  const rows = db.prepare(`
    SELECT e.id, e.from_name, e.subject, COALESCE(e.body, e.snippet, '') AS body, e.category_id,
      EXISTS(SELECT 1 FROM job_emails je WHERE je.email_id=e.id) AS in_jobs,
      EXISTS(SELECT 1 FROM work_labels wl WHERE wl.email_id=e.id AND wl.label=1) AS lbl_pos,
      EXISTS(SELECT 1 FROM work_labels wl WHERE wl.email_id=e.id AND wl.label=0) AS lbl_neg
    FROM emails e
    WHERE e.embedding IS NOT NULL AND COALESCE(e.body, e.snippet, '') != ''
  `).all() as Row[];

  console.log(`Total: ${rows.length}`);
  const posIds = new Set(rows.filter((r) => r.in_jobs || r.lbl_pos).map((r) => r.id));
  const negIds = new Set(rows.filter((r) => !posIds.has(r.id) && (r.category_id === "cat_junk" || r.category_id === "cat_news" || r.lbl_neg)).map((r) => r.id));
  console.log(`Pos: ${posIds.size}  Neg: ${negIds.size}\n`);

  const start = Date.now();
  const probs = new Map<string, number>();
  let i = 0;
  for (const r of rows) {
    const text = (r.subject || "").slice(0, 200) + "\n" + (r.body || "").slice(0, 1500);
    const p = await predictIsWork(text);
    probs.set(r.id, p ?? 0);
    if (++i % 50 === 0) console.log(`  encoded ${i}/${rows.length} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
  console.log(`\nTotal encode time: ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  // threshold sweep
  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  console.log("=== Threshold sweep (JS inference) ===");
  for (const th of thresholds) {
    let tp = 0, fp = 0;
    for (const r of rows) {
      const p = probs.get(r.id)!;
      const flag = p >= th;
      if (posIds.has(r.id) && flag) tp++;
      else if (negIds.has(r.id) && flag) fp++;
    }
    console.log(`θ=${th.toFixed(2)}  TP=${tp}/${posIds.size}  FP=${fp}/${negIds.size}`);
  }

  // top FPs
  console.log("\n=== TOP 10 FPs ===");
  const fps = rows.filter((r) => negIds.has(r.id)).map((r) => ({ r, p: probs.get(r.id)! }))
    .sort((a, b) => b.p - a.p).slice(0, 10);
  for (const { r, p } of fps) {
    console.log(`  P=${p.toFixed(3)}  ${r.from_name.slice(0, 30).padEnd(32)} ${(r.subject || "").slice(0, 60)}`);
  }

  // top FNs (positives ranked low)
  console.log("\n=== TOP 5 LOWEST POSITIVES (closest to threshold) ===");
  const tps = rows.filter((r) => posIds.has(r.id)).map((r) => ({ r, p: probs.get(r.id)! }))
    .sort((a, b) => a.p - b.p).slice(0, 5);
  for (const { r, p } of tps) {
    console.log(`  P=${p.toFixed(3)}  ${r.from_name.slice(0, 30).padEnd(32)} ${(r.subject || "").slice(0, 60)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
