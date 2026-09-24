/**
 * LLM bootstrap: label every email in the DB as is_work=1 or 0, insert into
 * work_labels with source='llm_bootstrap'. Does not overwrite rows where
 * source='user_correction' (those are higher-trust signals).
 *
 *   tsx scripts/label-work-corpus.ts            → label all unlabeled
 *   tsx scripts/label-work-corpus.ts --relabel  → force re-label non-user rows
 *   tsx scripts/label-work-corpus.ts --limit 50 → cap for quick runs
 */
import db, { upsertWorkLabel, countWorkLabels, type EmailRow } from "../lib/db";
import { runClaude } from "../lib/claude-cli";
import { parseJsonArray } from "../lib/parse";
import { sanitizeForPrompt } from "../lib/sanitize";

const BATCH_SIZE = 40;

const PROMPT = `You are an email labeler. For each email, decide whether it is "directly related to the user's personal job-search process".

label=1 when:
- ATS application confirmation / real HR outreach / interview scheduling / calendar invite
- Assessment / take-home / coding challenge instructions
- Offer / rejection / withdrawal notice
- Recruiter reaching out 1:1 (cold outreach counts)

label=0 when:
- Platform digests from LinkedIn / Indeed / Handshake ("5 jobs match your search")  ← note: specific job pushes forwarded by Handshake also count as 0, unless sent by a real HR person
- Campus career-fair broadcasts / job-search course ads / career fair notices
- Company newsletters mentioning hiring but not targeting the user personally
- Job links forwarded by a colleague or friend (not something the user applied to)
- Completely unrelated emails (coursework, marketing, notifications)

Output a strict JSON array; id must equal the input id:
[{"id":"...","label":1,"reason":"one sentence"},{"id":"...","label":0,"reason":"..."}]
`;

interface LabelResult { id: string; label: number; reason: string }

async function labelBatch(rows: Pick<EmailRow, "id" | "from_name" | "from_email" | "subject" | "snippet" | "body">[]): Promise<LabelResult[]> {
  const desc = rows.map((e) => {
    const body = sanitizeForPrompt(((e.body || e.snippet || "") as string).slice(0, 1500));
    return `--- email id=${e.id} ---
From: ${sanitizeForPrompt(e.from_name)} <${sanitizeForPrompt(e.from_email)}>
Subject: ${sanitizeForPrompt(e.subject)}
Body: ${body}`;
  }).join("\n\n");
  const prompt = `${PROMPT}\nEmails:\n${desc}`;
  const { text } = await runClaude({ label: "label-work-corpus", prompt, model: "sonnet", timeoutMs: 180_000 });
  return parseJsonArray<LabelResult>(text);
}

(async () => {
  const argv = process.argv.slice(2);
  const relabel = argv.includes("--relabel");
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]) : 10000;

  const pre = countWorkLabels();
  console.log(`[label] before: ${pre.total} labels (${pre.positive} pos / ${pre.negative} neg)`);

  // Choose targets: all emails with embeddings, minus those already labeled by user
  const sql = relabel
    ? `SELECT e.id, e.from_name, e.from_email, e.subject, e.snippet, e.body
       FROM emails e
       LEFT JOIN work_labels wl ON wl.email_id = e.id AND wl.source = 'user_correction'
       WHERE wl.email_id IS NULL
       ORDER BY e.received_at DESC
       LIMIT ?`
    : `SELECT e.id, e.from_name, e.from_email, e.subject, e.snippet, e.body
       FROM emails e
       LEFT JOIN work_labels wl ON wl.email_id = e.id
       WHERE wl.email_id IS NULL
       ORDER BY e.received_at DESC
       LIMIT ?`;
  const targets = db.prepare(sql).all(limit) as Pick<EmailRow, "id" | "from_name" | "from_email" | "subject" | "snippet" | "body">[];
  console.log(`[label] target: ${targets.length} emails`);

  let labeled = 0, errors = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    console.log(`[label] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)} (${chunk.length} emails)...`);
    try {
      const results = await labelBatch(chunk);
      for (const r of results) {
        const lab = r.label === 1 ? 1 : 0;
        upsertWorkLabel(r.id, lab, "llm_bootstrap");
        labeled++;
      }
    } catch (e) {
      console.error(`[label] batch error:`, e);
      errors++;
    }
  }

  const post = countWorkLabels();
  console.log(`\n[label] done: labeled ${labeled}, errors ${errors}`);
  console.log(`[label] after: ${post.total} labels (${post.positive} pos / ${post.negative} neg)`);
})().catch((e) => { console.error(e); process.exit(1); });
