/**
 * Sanity-check SetFit ONNX inference matches Python eval results.
 * Usage: cd web && npx tsx scripts/test-setfit-inference.ts
 */
import db from "../lib/db";
import { predictIsWork, isWorkEmbedderAvailable } from "../lib/work-embedder";

interface Row { id: string; from_name: string; subject: string; body: string; }

const tests: Array<{ id: string; expected_label: 0 | 1; note: string }> = [
  // Today's job emails (ground truth = 1)
  { id: "19df1a29d3ea285b", expected_label: 1, note: "Company A application next steps" },
  { id: "19df19deba0598a3", expected_label: 1, note: "Company A application submitted" },
  { id: "19df1e42cbcf8113", expected_label: 1, note: "Company B thank you for applying" },
  { id: "19df1daf2c881cae", expected_label: 1, note: "Company C thank you for applying" },
  // Negatives
  { id: "19dd0605265f93dc", expected_label: 0, note: "Teacher absence notice" },
];

async function main() {
  if (!isWorkEmbedderAvailable()) {
    console.error("Model files missing. Run training/setfit-work/train.py first.");
    process.exit(1);
  }

  console.log("=== SetFit JS inference test ===\n");
  let correct = 0;
  for (const t of tests) {
    const r = db.prepare("SELECT id, from_name, subject, body FROM emails WHERE id = ?").get(t.id) as Row | undefined;
    if (!r) {
      console.log(`SKIP  ${t.id}  (not in local DB)`);
      continue;
    }
    const text = (r.subject || "").slice(0, 200) + "\n" + (r.body || "").slice(0, 1500);
    const p = await predictIsWork(text);
    if (p === null) { console.log("MODEL MISSING"); continue; }
    const pred = p >= 0.5 ? 1 : 0;
    const ok = pred === t.expected_label;
    if (ok) correct++;
    console.log(`${ok ? "✓" : "✗"}  P=${p.toFixed(3)}  expect=${t.expected_label}  ${t.note}`);
  }
  console.log(`\n${correct}/${tests.length} correct`);
}

main().catch((e) => { console.error(e); process.exit(1); });
