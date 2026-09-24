/**
 * 4-layer job-gate evaluation. Automatic ground truth + anchor set.
 *
 *   POS:    emails ∈ job_emails ∪ work_labels{label=1}
 *   NEG:    emails ∈ {cat_junk, cat_news}     (auto, noisy)
 *   ANCHOR: per application_id, oldest job_email     (the original confirmation)
 *
 * For each email, compute 4 features:
 *   A. anchor_regex      (subject/body matches application keywords)
 *   B. in_job_domain     (sender_domain ∈ application_domains)
 *   C. max_cos_to_anchor (kNN similarity to ANY anchor's embedding)
 *   D. work_classifier_p (ML logistic regression score)
 *
 * Output:
 *   - TPR/FPR per layer at default threshold
 *   - θ sweep for layer C
 *   - OR combinations table (which gates fire together?)
 *   - 30-day spawn cost projection for each candidate config
 */
import db from "../lib/db";
import { predictWork } from "../lib/work-classifier";
import { blobToEmbedding, cosineSimilarity } from "../lib/embedder";

// ── 1. anchor regex (high-precision, English only — Chinese rare in job email)
const ANCHOR_RE = /\b(thank you for (applying|your application)|we['' ]?ve? received your application|application (received|confirmed|submitted|complete)|you['' ]?ve? (successfully )?applied to|your .{1,40} application|verify your email|application for .{1,80} (at|to|with))\b/i;

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

// ── 2. load corpus
interface EmailRow {
  id: string;
  from_email: string;
  from_name: string;
  subject: string;
  body: string;
  category_id: string | null;
  received_at: number;
  embedding: Buffer | null;
}

const allEmails = db.prepare(`
  SELECT id, from_email, from_name, subject, body, category_id, received_at, embedding
  FROM emails
  WHERE embedding IS NOT NULL
`).all() as EmailRow[];

console.log(`Total embedded emails: ${allEmails.length}`);

// ── 3. ground truth sets
const posIds = new Set<string>();
for (const r of db.prepare("SELECT email_id FROM job_emails").all() as { email_id: string }[]) posIds.add(r.email_id);
for (const r of db.prepare("SELECT email_id FROM work_labels WHERE label=1").all() as { email_id: string }[]) posIds.add(r.email_id);

const negIds = new Set<string>();
for (const r of db.prepare(`SELECT id FROM emails WHERE category_id IN ('cat_junk','cat_news')`).all() as { id: string }[]) {
  if (!posIds.has(r.id)) negIds.add(r.id);
}

console.log(`Positive set: ${posIds.size} (job_emails ∪ work_labels:label=1)`);
console.log(`Negative set: ${negIds.size} (cat_junk ∪ cat_news, minus pos overlap)`);

// ── 4. anchor set: oldest job_email per application_id
interface AnchorRow { email_id: string; from_email: string; subject: string; embedding: Buffer | null; }
const anchorRows = db.prepare(`
  SELECT je.email_id, e.from_email, e.subject, e.embedding
  FROM job_emails je
  JOIN emails e ON e.id = je.email_id
  WHERE (je.application_id, e.received_at) IN (
    SELECT je2.application_id, MIN(e2.received_at)
    FROM job_emails je2 JOIN emails e2 ON e2.id = je2.email_id
    WHERE je2.application_id IS NOT NULL
    GROUP BY je2.application_id
  )
`).all() as AnchorRow[];

const anchors: Float32Array[] = [];
for (const a of anchorRows) {
  if (a.embedding) anchors.push(blobToEmbedding(a.embedding));
}
console.log(`Anchor set: ${anchors.length} (oldest email per application)`);
console.log("Anchor sender/subject preview:");
for (const a of anchorRows.slice(0, 8)) console.log(`  ${a.from_email.slice(0, 40).padEnd(42)} | ${a.subject.slice(0, 60)}`);
console.log("");

// ── 5. job domains
const jobDomainSet = new Set<string>();
for (const r of db.prepare("SELECT DISTINCT domain FROM application_domains").all() as { domain: string }[]) {
  jobDomainSet.add(r.domain.toLowerCase());
}
console.log(`Job domains in DB: ${jobDomainSet.size} → ${[...jobDomainSet].join(", ")}\n`);

// ── 6. compute features per email
interface Features {
  id: string;
  is_pos: boolean;
  is_neg: boolean;
  A_anchor_re: boolean;
  B_in_domain: boolean;
  C_max_cos: number;
  D_ml_p: number;
}

const features: Features[] = [];
for (const r of allEmails) {
  if (!r.embedding) continue;
  if (!posIds.has(r.id) && !negIds.has(r.id)) continue; // not in test set

  const text = (r.subject + " " + (r.body || "").slice(0, 1500));
  const emb = blobToEmbedding(r.embedding);
  const maxCos = anchors.length > 0
    ? Math.max(...anchors.map((a) => cosineSimilarity(emb, a)))
    : 0;
  features.push({
    id: r.id,
    is_pos: posIds.has(r.id),
    is_neg: negIds.has(r.id),
    A_anchor_re: ANCHOR_RE.test(text),
    B_in_domain: jobDomainSet.has(extractDomain(r.from_email)),
    C_max_cos: maxCos,
    D_ml_p: predictWork(emb),
  });
}

const P = features.filter((f) => f.is_pos).length;
const N = features.filter((f) => f.is_neg).length;
console.log(`Test set: ${P} pos / ${N} neg = ${P + N} total\n`);

// ── 7. metric helpers
function evalGate(label: string, predicate: (f: Features) => boolean) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const f of features) {
    const flag = predicate(f);
    if (f.is_pos && flag) tp++;
    else if (f.is_pos && !flag) fn++;
    else if (f.is_neg && flag) fp++;
    else tn++;
  }
  const tpr = P > 0 ? tp / P : 0;
  const fpr = N > 0 ? fp / N : 0;
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  console.log(`${label.padEnd(36)} TPR=${(tpr*100).toFixed(1)}% (${tp}/${P})  FPR=${(fpr*100).toFixed(1)}% (${fp}/${N})  prec=${(precision*100).toFixed(1)}%`);
  return { tp, fp, fn, tn, tpr, fpr, precision };
}

console.log("=== SINGLE-LAYER PERFORMANCE ===");
const eA  = evalGate("A. anchor regex",         (f) => f.A_anchor_re);
const eB  = evalGate("B. domain match",         (f) => f.B_in_domain);
const eD  = evalGate("D. work-classifier (P≥0.5)", (f) => f.D_ml_p >= 0.5);

console.log("");
console.log("=== C. kNN to anchors — θ sweep ===");
for (const theta of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85]) {
  evalGate(`C@θ=${theta.toFixed(2)}`, (f) => f.C_max_cos >= theta);
}

console.log("\n=== OR COMBINATIONS (target TPR ≥ 95%, low FPR) ===");
const C_TH = 0.65; // tentative best from sweep — adjust based on output
evalGate("A | B",                        (f) => f.A_anchor_re || f.B_in_domain);
evalGate(`A | B | C@${C_TH}`,            (f) => f.A_anchor_re || f.B_in_domain || f.C_max_cos >= C_TH);
evalGate(`A | C@${C_TH}`,                (f) => f.A_anchor_re || f.C_max_cos >= C_TH);
evalGate(`A | B | C@${C_TH} | D`,        (f) => f.A_anchor_re || f.B_in_domain || f.C_max_cos >= C_TH || f.D_ml_p >= 0.5);
evalGate("A | D",                        (f) => f.A_anchor_re || f.D_ml_p >= 0.5);

console.log("\n=== MARGINAL VALUE: which positives caught by ONLY this layer? ===");
function uniqueCatch(label: string, by: (f: Features) => boolean, others: ((f: Features) => boolean)[]) {
  const onlyMe = features.filter((f) => f.is_pos && by(f) && !others.some((o) => o(f)));
  console.log(`Only by ${label}: ${onlyMe.length} positives`);
  for (const f of onlyMe.slice(0, 5)) {
    const e = allEmails.find((r) => r.id === f.id)!;
    console.log(`  ${e.from_name.slice(0,28).padEnd(30)} | ${e.subject.slice(0, 60)}`);
  }
}

const pA = (f: Features) => f.A_anchor_re;
const pB = (f: Features) => f.B_in_domain;
const pC = (f: Features) => f.C_max_cos >= C_TH;
const pD = (f: Features) => f.D_ml_p >= 0.5;
uniqueCatch("A only",        pA, [pB, pC, pD]);
uniqueCatch("B only",        pB, [pA, pC, pD]);
uniqueCatch("C only",        pC, [pA, pB, pD]);
uniqueCatch("D only",        pD, [pA, pB, pC]);

console.log("\n=== POSITIVES MISSED BY ALL 4 LAYERS ===");
const missed = features.filter((f) => f.is_pos && !pA(f) && !pB(f) && !pC(f) && !pD(f));
console.log(`${missed.length} positives caught by NO layer (this is the floor of recall):`);
for (const f of missed.slice(0, 8)) {
  const e = allEmails.find((r) => r.id === f.id)!;
  console.log(`  cos=${f.C_max_cos.toFixed(2)} P_ml=${f.D_ml_p.toFixed(2)}  ${e.from_name.slice(0,25).padEnd(27)} | ${e.subject.slice(0, 55)}`);
}

console.log("\n=== TOP FALSE POSITIVES of each gate (sample) ===");
function topFP(label: string, by: (f: Features) => boolean) {
  const fps = features.filter((f) => f.is_neg && by(f)).slice(0, 5);
  console.log(`${label}: ${features.filter((f) => f.is_neg && by(f)).length} FPs total`);
  for (const f of fps) {
    const e = allEmails.find((r) => r.id === f.id)!;
    console.log(`  cos=${f.C_max_cos.toFixed(2)} P_ml=${f.D_ml_p.toFixed(2)}  ${e.from_name.slice(0,25).padEnd(27)} | ${e.subject.slice(0, 55)}`);
  }
}
topFP("A regex", pA);
topFP("B domain", pB);
topFP(`C@${C_TH}`, pC);

console.log("\n=== 30-DAY SPAWN COST PROJECTION (best combo) ===");
const recent = features.filter((f) => {
  const r = allEmails.find((e) => e.id === f.id)!;
  return r.received_at > Math.floor(Date.now()/1000) - 30*86400;
});
const days = 30;
const dailyArrival = recent.length / days;
const dailyFlag_ABC = recent.filter((f) => f.A_anchor_re || f.B_in_domain || f.C_max_cos >= C_TH).length / days;
const dailyTP_ABC   = recent.filter((f) => f.is_pos && (f.A_anchor_re || f.B_in_domain || f.C_max_cos >= C_TH)).length / days;
const dailyFP_ABC   = dailyFlag_ABC - dailyTP_ABC;
console.log(`Daily arrival rate (last 30d sampled subset): ${dailyArrival.toFixed(1)} emails/day`);
console.log(`Best combo flags ${dailyFlag_ABC.toFixed(1)}/day  (TP ${dailyTP_ABC.toFixed(1)} + FP ${dailyFP_ABC.toFixed(1)})`);
console.log(`FP cost: each enters Step 3 LLM batch (cap 30 per merged-prefetch). Effective extra spawn ≈ ${(dailyFP_ABC / 30).toFixed(2)}/day if batched optimally.`);
