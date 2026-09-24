/**
 * Evaluate job classifier vs gold labels in job_eval_set.
 *
 *   tsx scripts/eval-job-classifier.ts                  → static comparison
 *   tsx scripts/eval-job-classifier.ts --rerun          → re-run LLM on each gold sample
 *   tsx scripts/eval-job-classifier.ts --seed-corrections → bootstrap eval_set from job_corrections
 *
 * Detection accuracy = is_job correct?
 * Stage accuracy     = stage correct given is_job=true?
 */
import db, {
  addJobEvalLabel,
  listJobEvalSet,
  getJobEmail,
  type EmailRow,
} from "../lib/db";
import { llmConfirmBatch } from "../lib/jobs-pipeline";
import fs from "fs";

interface Pair {
  emailId: string;
  goldIsJob: boolean;
  goldStage: string;
  predIsJob: boolean;
  predStage: string;
  fromEmail: string;
  subject: string;
}

function pad(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function seedFromCorrections() {
  const rows = db.prepare(
    "SELECT email_id, correction_kind, user_stage FROM job_corrections"
  ).all() as { email_id: string; correction_kind: string; user_stage: string }[];
  let added = 0;
  for (const r of rows) {
    if (r.correction_kind === "remove") {
      addJobEvalLabel(r.email_id, false, "");
      added++;
    } else if (r.correction_kind === "stage" && r.user_stage) {
      addJobEvalLabel(r.email_id, true, r.user_stage);
      added++;
    }
  }
  console.log(`Seeded ${added} gold labels from job_corrections`);
  console.log(`Total in job_eval_set: ${listJobEvalSet().length}`);
}

async function loadPairs(rerun: boolean): Promise<Pair[]> {
  const gold = listJobEvalSet();
  if (gold.length === 0) {
    console.error("job_eval_set empty. Use --seed-corrections or label via UI.");
    process.exit(1);
  }
  const ids = gold.map((g) => g.email_id);
  const ph = ids.map(() => "?").join(",");
  const emails = db.prepare(
    `SELECT id, from_name, from_email, subject, snippet, body FROM emails WHERE id IN (${ph})`
  ).all(...ids) as Pick<EmailRow, "id" | "from_name" | "from_email" | "subject" | "snippet" | "body">[];
  const eMap = new Map(emails.map((e) => [e.id, e]));
  const goldMap = new Map(gold.map((g) => [g.email_id, g]));

  const pairs: Pair[] = [];

  if (rerun) {
    console.log(`[rerun] calling LLM on ${emails.length} samples...`);
    // llmConfirmBatch expects EmailRow-like objects; we have the minimal fields.
    const triage = await llmConfirmBatch(emails.map((e) => ({
      ...e,
      body: e.body || "",
      thread_id: "",
      from_email: e.from_email,
      from_name: e.from_name,
      date: "",
      received_at: 0,
      is_unread: 0,
      category: "",
      urgency: "",
      confidence: 0,
      classifier: "",
      fetched_at: 0,
      classified_at: null,
      embedding: null,
      category_id: null,
      primary_until: null,
      body_html: "",
      maybe_work: 0,
      snippet: e.snippet || "",
    }) as unknown as EmailRow));
    const tMap = new Map(triage.map((t) => [t.id, t]));
    for (const id of ids) {
      const e = eMap.get(id);
      const g = goldMap.get(id)!;
      const t = tMap.get(id);
      pairs.push({
        emailId: id,
        goldIsJob: g.gold_is_job === 1,
        goldStage: g.gold_stage,
        predIsJob: !!t?.is_job,
        predStage: t?.stage || "",
        fromEmail: e?.from_email || "",
        subject: e?.subject || "",
      });
    }
  } else {
    for (const id of ids) {
      const e = eMap.get(id);
      const g = goldMap.get(id)!;
      const j = getJobEmail(id);
      pairs.push({
        emailId: id,
        goldIsJob: g.gold_is_job === 1,
        goldStage: g.gold_stage,
        predIsJob: !!j,
        predStage: j?.stage || "",
        fromEmail: e?.from_email || "",
        subject: e?.subject || "",
      });
    }
  }
  return pairs;
}

function buildReport(pairs: Pair[]) {
  let detectCorrect = 0;
  let stageCorrect = 0;
  let stageTotal = 0;
  for (const p of pairs) {
    if (p.goldIsJob === p.predIsJob) detectCorrect++;
    if (p.goldIsJob && p.predIsJob) {
      stageTotal++;
      if (p.goldStage === p.predStage) stageCorrect++;
    }
  }
  return {
    samples: pairs.length,
    detectAccuracy: pairs.length === 0 ? 0 : detectCorrect / pairs.length,
    stageAccuracy: stageTotal === 0 ? 0 : stageCorrect / stageTotal,
    detectCorrect,
    stageCorrect,
    stageTotal,
  };
}

function printReport(r: ReturnType<typeof buildReport>, errors: Pair[]) {
  console.log(`\n=== Job classifier eval ===\n`);
  console.log(`Samples: ${r.samples}`);
  console.log(`Detection accuracy (is_job): ${(r.detectAccuracy * 100).toFixed(1)}% (${r.detectCorrect}/${r.samples})`);
  console.log(`Stage accuracy (when is_job): ${(r.stageAccuracy * 100).toFixed(1)}% (${r.stageCorrect}/${r.stageTotal})`);
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      const detect = e.goldIsJob === e.predIsJob ? "ok" : `is_job ${e.goldIsJob}->${e.predIsJob}`;
      const stage = e.goldIsJob && e.predIsJob && e.goldStage !== e.predStage
        ? `stage ${e.goldStage}->${e.predStage}`
        : "";
      console.log(`  ${e.emailId}  ${pad(detect, 18)}  ${pad(stage, 30)}  ${e.fromEmail}  ${e.subject.slice(0, 50)}`);
    }
  } else {
    console.log(`\nNo errors. Predictions match gold.`);
  }
}

(async () => {
  const argv = process.argv.slice(2);

  if (argv.includes("--seed-corrections")) {
    seedFromCorrections();
    return;
  }

  const rerun = argv.includes("--rerun");
  const jsonIdx = argv.indexOf("--json");
  const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;

  const pairs = await loadPairs(rerun);
  const report = buildReport(pairs);
  const errors = pairs.filter((p) => p.goldIsJob !== p.predIsJob || (p.goldIsJob && p.predIsJob && p.goldStage !== p.predStage));
  printReport(report, errors);

  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: rerun ? "rerun" : "static",
      ...report,
      errors,
    }, null, 2));
    console.log(`\nReport written to ${jsonPath}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
