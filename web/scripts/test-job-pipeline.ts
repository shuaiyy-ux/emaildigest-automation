/**
 * End-to-end test of Job pipeline. Assumes fixtures already seeded via seed-test-emails.ts.
 *
 *   tsx scripts/test-job-pipeline.ts
 *
 * Reads expectations from app_state.test_email_expectations, then:
 *   1. Verifies detection (is_job true positives + true negatives)
 *   2. Verifies stage accuracy (when is_job=true)
 *   3. Verifies application aggregation (multi-email apps collapse to 1, different role→different app)
 *   4. Verifies metadata extraction (offer email gets salary/location/visa)
 */
import db, { getAppState, getJobEmail, type EmailRow } from "../lib/db";
import { listApplications, listApplicationEmails, normalizeCompany, normalizeRole } from "../lib/applications";

interface Expected {
  id: string;
  isJob: boolean;
  stage?: string;
  needsAction?: boolean;
  company?: string;
  role?: string;
}

function pad(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function loadExpectations(): Expected[] {
  const raw = getAppState("test_email_expectations");
  if (!raw) {
    console.error("No expectations in app_state — run `npm run seed-test-emails` first.");
    process.exit(1);
  }
  return JSON.parse(raw);
}

function reportDetection(expected: Expected[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const errors: { id: string; expected: boolean; actual: boolean }[] = [];
  for (const e of expected) {
    const j = getJobEmail(e.id);
    const actual = !!j;
    if (e.isJob && actual) tp++;
    else if (e.isJob && !actual) { fn++; errors.push({ id: e.id, expected: true, actual }); }
    else if (!e.isJob && actual) { fp++; errors.push({ id: e.id, expected: false, actual }); }
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  console.log("\n=== Detection (is_job) ===");
  console.log(`TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`Precision: ${(precision * 100).toFixed(1)}%   Recall: ${(recall * 100).toFixed(1)}%   F1: ${(f1 * 100).toFixed(1)}%`);
  if (errors.length > 0) {
    console.log("Errors:");
    for (const e of errors) {
      const row = db.prepare("SELECT subject, from_email FROM emails WHERE id = ?").get(e.id) as { subject: string; from_email: string } | undefined;
      console.log(`  ${e.id}  expected_is_job=${e.expected} got=${e.actual}  ${row?.from_email}  ${row?.subject?.slice(0, 60)}`);
    }
  }
  return { precision, recall, f1, errors: errors.length };
}

function reportStage(expected: Expected[]) {
  const positives = expected.filter((e) => e.isJob && e.stage);
  let correct = 0;
  const matrix: Record<string, Record<string, number>> = {};
  const errors: { id: string; expected: string; actual: string }[] = [];
  for (const e of positives) {
    const j = getJobEmail(e.id);
    if (!j) continue; // detection failure already counted
    const actual = j.stage;
    matrix[e.stage!] ||= {};
    matrix[e.stage!][actual] = (matrix[e.stage!][actual] || 0) + 1;
    if (actual === e.stage) correct++;
    else errors.push({ id: e.id, expected: e.stage!, actual });
  }
  const accuracy = positives.length === 0 ? 0 : correct / positives.length;
  console.log("\n=== Stage accuracy ===");
  console.log(`Accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${positives.length})`);
  if (errors.length > 0) {
    console.log("Mismatches:");
    for (const e of errors) {
      const row = db.prepare("SELECT subject FROM emails WHERE id = ?").get(e.id) as { subject: string } | undefined;
      console.log(`  ${e.id}  ${pad(e.expected, 22)}→${pad(e.actual, 22)}  ${row?.subject?.slice(0, 50)}`);
    }
  }
  return { accuracy, correct, total: positives.length };
}

function reportAggregation(expected: Expected[]) {
  // Group expected positives by (normalized company, normalized role) — those should collapse to 1 app each.
  const expectedKeyByEmailId = new Map<string, string>();
  for (const e of expected) {
    if (!e.isJob) continue;
    const key = `${normalizeCompany(e.company || "")}::${normalizeRole(e.role || "")}`;
    expectedKeyByEmailId.set(e.id, key);
  }
  const expectedAppCount = new Set(expectedKeyByEmailId.values()).size;

  // Look at actual applications — each app's emails should all have the SAME expected key.
  const apps = listApplications();
  const actualAppCount = apps.length;

  let consistent = 0;
  const inconsistent: { appId: string; keys: string[]; emails: string[] }[] = [];
  for (const a of apps) {
    const emails = listApplicationEmails(a.id);
    const keys = new Set<string>();
    const ids: string[] = [];
    for (const e of emails) {
      const k = expectedKeyByEmailId.get(e.email_id);
      if (!k) continue;
      keys.add(k);
      ids.push(e.email_id);
    }
    if (keys.size <= 1) consistent++;
    else inconsistent.push({ appId: a.id, keys: [...keys], emails: ids });
  }

  console.log("\n=== Application aggregation ===");
  console.log(`Expected applications (by normalized company+role): ${expectedAppCount}`);
  console.log(`Actual applications:                                  ${actualAppCount}`);
  console.log(`Internally-consistent applications:                   ${consistent}/${actualAppCount}`);
  if (inconsistent.length > 0) {
    console.log("Inconsistent applications (mixing different expected keys):");
    for (const x of inconsistent) {
      console.log(`  ${x.appId}  emails=${x.emails.length}  keys=${x.keys.join(" | ")}`);
    }
  }

  // Check specific multi-email apps — Northwind DA should be 1 application
  const northwindDaIds = ["test_p_01", "test_p_03", "test_p_07", "test_p_10", "test_p_12", "test_p_13", "test_p_18", "test_p_23"];
  const northwindDaAppIds = new Set<string>();
  for (const id of northwindDaIds) {
    const j = getJobEmail(id);
    if (j?.application_id) northwindDaAppIds.add(j.application_id);
  }
  console.log(`Northwind Data Analyst (expected 1 app): got ${northwindDaAppIds.size} app(s)`);

  // Check Northwind DA vs Northwind ML are different
  const northwindMlJ = getJobEmail("test_p_21");
  const northwindDaJ = getJobEmail("test_p_01");
  if (northwindMlJ && northwindDaJ) {
    const same = northwindMlJ.application_id === northwindDaJ.application_id;
    console.log(`Northwind DA vs Northwind ML (expected different apps): ${same ? "❌ SAME" : "✓ different"}`);
  }
}

function reportMetadata() {
  const j = getJobEmail("test_p_14"); // Initech offer email
  if (!j) {
    console.log("\n=== Metadata extraction ===");
    console.log("test_p_14 (Initech offer) not in job_emails — can't check metadata");
    return;
  }
  console.log("\n=== Metadata extraction (Initech offer test_p_14) ===");
  console.log(`  salary:      ${j.salary || "(empty)"}`);
  console.log(`  location:    ${j.location || "(empty)"}`);
  console.log(`  remote_mode: ${j.remote_mode || "(empty)"}`);
  console.log(`  visa_note:   ${j.visa_note || "(empty)"}`);
}

(async () => {
  const expected = loadExpectations();
  console.log(`Loaded ${expected.length} expectations.\n`);

  reportDetection(expected);
  reportStage(expected);
  reportAggregation(expected);
  reportMetadata();
  console.log("");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
