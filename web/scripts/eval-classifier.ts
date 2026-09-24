/**
 * Evaluate classifier accuracy against eval_set gold labels.
 *
 *   tsx scripts/eval-classifier.ts
 *     Static mode: compare emails.category_id (current DB state) vs gold.
 *
 *   tsx scripts/eval-classifier.ts --rerun
 *     Re-invoke the LLM classifier (same prompt as prefetch.ts Step 2)
 *     on every gold-labeled email and compare. Costs LLM tokens.
 *
 *   tsx scripts/eval-classifier.ts --json eval-report.json
 *     Also write the report as JSON for trend tracking.
 */
import db, { listCategories, listEvalSet } from "../lib/db";
import { classifyEmailsWithLLM } from "../lib/llm-classify";
import fs from "fs";

type Pair = {
  emailId: string;
  fromEmail: string;
  subject: string;
  gold: string;
  predicted: string | null;
};

function pad(s: string, n: number) {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

async function loadPairs(rerun: boolean): Promise<Pair[]> {
  const goldRows = listEvalSet();
  if (goldRows.length === 0) {
    console.error("eval_set is empty. Run: tsx scripts/seed-eval-set.ts --from-corrections");
    process.exit(1);
  }

  const ids = goldRows.map((r) => r.email_id);
  const placeholders = ids.map(() => "?").join(",");
  const emailRows = db.prepare(
    `SELECT id, from_name, from_email, subject, snippet, category_id
     FROM emails WHERE id IN (${placeholders})`
  ).all(...ids) as {
    id: string; from_name: string; from_email: string;
    subject: string; snippet: string; category_id: string | null;
  }[];

  const goldById = new Map(goldRows.map((r) => [r.email_id, r.gold_category_id]));
  const emailById = new Map(emailRows.map((e) => [e.id, e]));

  if (!rerun) {
    return goldRows.map((r) => {
      const e = emailById.get(r.email_id);
      return {
        emailId: r.email_id,
        fromEmail: e?.from_email ?? "",
        subject: e?.subject ?? "",
        gold: r.gold_category_id,
        predicted: e?.category_id ?? null,
      };
    });
  }

  const cats = listCategories();
  const nameToId: Record<string, string> = {};
  for (const c of cats) nameToId[c.name.toLowerCase()] = c.id;

  const inputs = emailRows.map((e) => ({
    id: e.id,
    from_name: e.from_name,
    from_email: e.from_email,
    subject: e.subject,
    snippet: e.snippet,
  }));
  console.log(`[rerun] calling LLM on ${inputs.length} emails... (this may take a minute)`);
  const llmOut = await classifyEmailsWithLLM(inputs, cats);
  const predById = new Map<string, string | null>();
  for (const r of llmOut) {
    const raw = (r.category || "").toLowerCase();
    predById.set(r.id, nameToId[raw] ?? null);
  }
  return ids.map((id) => {
    const e = emailById.get(id);
    return {
      emailId: id,
      fromEmail: e?.from_email ?? "",
      subject: e?.subject ?? "",
      gold: goldById.get(id)!,
      predicted: predById.get(id) ?? null,
    };
  });
}

function buildReport(pairs: Pair[], cats: { id: string; name: string }[]) {
  const labels = cats.map((c) => c.id);
  const labelSet = new Set(labels);
  const matrix: Record<string, Record<string, number>> = {};
  for (const g of labels) {
    matrix[g] = {};
    for (const p of [...labels, "null"]) matrix[g][p] = 0;
  }

  let correct = 0;
  for (const p of pairs) {
    if (!labelSet.has(p.gold)) continue;
    const predKey = p.predicted && labelSet.has(p.predicted) ? p.predicted : "null";
    matrix[p.gold][predKey]++;
    if (p.predicted === p.gold) correct++;
  }

  const accuracy = pairs.length === 0 ? 0 : correct / pairs.length;

  const perCat: Record<string, { precision: number; recall: number; f1: number; support: number }> = {};
  for (const cat of labels) {
    const tp = matrix[cat][cat] ?? 0;
    const fn = Object.entries(matrix[cat]).reduce((s, [k, v]) => k === cat ? s : s + v, 0);
    const fp = labels.reduce((s, g) => g === cat ? s : s + (matrix[g][cat] ?? 0), 0);
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perCat[cat] = { precision, recall, f1, support: tp + fn };
  }

  return { accuracy, correct, total: pairs.length, matrix, perCat, labels };
}

function printReport(r: ReturnType<typeof buildReport>, errors: Pair[]) {
  console.log(`\n=== Classification eval ===\n`);
  console.log(`Samples: ${r.total}`);
  console.log(`Accuracy: ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})\n`);

  const cols = [...r.labels, "null"];
  console.log(`Confusion matrix (rows=gold, cols=predicted):`);
  console.log(pad("gold \\ pred", 14) + cols.map((c) => pad(c, 12)).join(""));
  for (const g of r.labels) {
    console.log(pad(g, 14) + cols.map((c) => pad(String(r.matrix[g][c] ?? 0), 12)).join(""));
  }

  console.log(`\nPer-category metrics:`);
  console.log(pad("category", 14) + pad("precision", 12) + pad("recall", 12) + pad("f1", 12) + pad("support", 10));
  for (const cat of r.labels) {
    const m = r.perCat[cat];
    console.log(
      pad(cat, 14) +
      pad(m.precision.toFixed(3), 12) +
      pad(m.recall.toFixed(3), 12) +
      pad(m.f1.toFixed(3), 12) +
      pad(String(m.support), 10)
    );
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ${e.emailId}  ${e.gold} → ${e.predicted ?? "null"}  ${e.fromEmail}  ${e.subject.slice(0, 60)}`);
    }
  } else {
    console.log(`\nNo errors. All predictions match gold.`);
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const rerun = argv.includes("--rerun");
  const jsonIdx = argv.indexOf("--json");
  const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;

  const pairs = await loadPairs(rerun);
  const cats = listCategories();
  const report = buildReport(pairs, cats);
  const errors = pairs.filter((p) => p.predicted !== p.gold);
  printReport(report, errors);

  if (jsonPath) {
    const out = {
      generatedAt: new Date().toISOString(),
      mode: rerun ? "rerun" : "static",
      ...report,
      errors,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    console.log(`\nReport written to ${jsonPath}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
