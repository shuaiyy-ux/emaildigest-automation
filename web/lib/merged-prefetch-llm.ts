/**
 * Merged prefetch LLM call — replaces 2 separate spawns (classify Step 2b
 * + jobs llmConfirmBatch) with one Sonnet spawn that returns a JSON object
 * with 2 top-level keys.
 *
 * Why: see docs/design/prefetch-llm-merge.md. (Briefings was the third task
 * but was removed 2026-05-02 — its stale-trigger fired on every new email
 * regardless of MiniLM verdict, dominating spawn count.)
 *
 * Pattern mirrors lib/event-extractor.ts and lib/email-digest.ts:
 *   - hardened runner lib/claude-cli.ts: empty cwd (no CLAUDE.md auto-load,
 *     ~94% cache_create cut), no tools, no MCP, no settings
 *   - --system-prompt (full replacement, NOT --append): the default Claude
 *     Code "coding assistant" system prompt drowns out JSON schema directives
 *   - Circuit breaker integration via lib/circuit-breaker.ts
 *
 * Output is best-effort: if a key is missing or wrong-typed, we return an
 * empty array/object for that key. Callers handle "missing" by leaving the
 * underlying state unchanged — next prefetch will retry because the gating
 * conditions (category_id IS NULL, maybe_work=1) still hold.
 */
import { sanitizeForPrompt } from "./sanitize";
import { parseJsonObject } from "./parse";
import { runClaude } from "./claude-cli";
import { getRecentCorrections, type EmailRow } from "./db";
import type { ClassifyInput, ClassifyResult, ClassifyCategory } from "./llm-classify";
import type { ConfirmResult } from "./jobs-pipeline";

const MODEL = process.env.EMAILDIGEST_MERGED_MODEL || "sonnet";

// Conservative cap — Sonnet handles 200K context, but mega-prompts cost more
// in cache_create churn and slow down latency. Above this we fall back to
// the per-task spawn paths (caller decides).
const MAX_PROMPT_BYTES = 100_000;

const SYSTEM_PROMPT = `You output exactly one JSON object as specified by the user prompt. No prose. No code fences. Begin with { and end with }.`;

export interface MergedInputs {
  classifyEmails: ClassifyInput[];
  classifyCategories: ClassifyCategory[];
  jobsEmails: EmailRow[];
}

export interface MergedResults {
  classifications: ClassifyResult[];
  jobs: ConfirmResult[];
  spawned: boolean;       // false ⇒ all inputs empty, no spawn
  fellBack: boolean;      // true ⇒ prompt > MAX_PROMPT_BYTES, caller should fall back
  rawSize: number;
  promptBytes: number;
  elapsedMs: number;
}

const EMPTY: MergedResults = {
  classifications: [],
  jobs: [],
  spawned: false,
  fellBack: false,
  rawSize: 0,
  promptBytes: 0,
  elapsedMs: 0,
};

function buildClassifySection(emails: ClassifyInput[], categories: ClassifyCategory[]): string {
  const cats = categories.map((c) => `  ${c.name.toLowerCase()}: ${c.description}`).join("\n");
  const corrections = getRecentCorrections(10);
  const correctionContext = corrections.length > 0
    ? `\nRecent user corrections (for reference only, not hard rules):\n${corrections.map(
        (c) => `- "${c.subject}" from ${c.fromEmail} → user re-labeled as: ${c.userCategory}`
      ).join("\n")}\n`
    : "";
  const desc = emails.map((e) =>
    `ID:${e.id} From:${sanitizeForPrompt(e.from_name)} <${sanitizeForPrompt(e.from_email)}> Subject:${sanitizeForPrompt(e.subject)} Snippet:${sanitizeForPrompt(e.snippet)}`
  ).join("\n");

  return `<task1_classify>
For each email below, pick a category (lowercase name from the list).

Categories:
${cats}

Track vs News — broadcast vs personal:
  - News = sender broadcasts to all subscribers (same email goes to many people); passive consumer
  - Track = a record specifically for the user's account or actions (order/grade/verification/bill)

Other rules:
- Sender starting with noreply/mailer/team/notifications/zotmail/alerts/digest → cannot be primary
- A real person 1:1 (personal or company address, not platform noreply) → primary
- Marketing / promotions / spam → junk
- Institutional event promotions ("Register now for X") → news (broadcast) or junk (pure marketing)
${correctionContext}
Output schema (one item per email; id must equal input id):
classifications: [{"id":"...", "category":"primary|track|news|junk", "confidence":"high|medium|low", "primary_until":null_or_ISO8601}]

confidence — self-rate how sure you are about this classification:
  - "high"   = clear textbook example; sender / subject / body all align
  - "medium" = category fits but at least one signal is ambiguous (plausibly a neighbor category)
  - "low"    = closest match but genuinely borderline / unfamiliar
  Use honestly — "low" is preferred over guessing "high". System uses low to skip training samples and medium to ask user confirm.

primary_until guidance:
- Verification code → now + 30 minutes
- Due today / EOD → today 23:59
- Event/deadline tomorrow or this week → event time + 1h
- Non-time-sensitive → null
- category MUST exactly match a lowercase name above; no inventing.

Emails to classify:
${desc}
</task1_classify>`;
}

function buildJobsSection(emails: EmailRow[]): string {
  const desc = emails.map((e) => {
    const bodyPreview = sanitizeForPrompt(((e.body || e.snippet || "") as string).slice(0, 1500));
    return `--- email id=${e.id} ---
From: ${sanitizeForPrompt(e.from_name)} <${sanitizeForPrompt(e.from_email)}>
Subject: ${sanitizeForPrompt(e.subject)}
Body: ${bodyPreview}`;
  }).join("\n\n");

  return `<task2_jobs>
For each email below, decide whether it is "directly related to the user's personal job-search process".

true when:
- ATS application confirmation / real HR outreach / interview scheduling / calendar invite
- Assessment / take-home / coding challenge instructions
- Offer / rejection / withdrawal notice
- Recruiter reaching out 1:1 (cold outreach counts)

false when:
- Platform digests from LinkedIn / Indeed / Handshake ("5 jobs match your search")
- Campus career-fair broadcasts / job-search course ads / career fair notices
- Company newsletters mentioning hiring but not targeting the user personally
- Job links forwarded by a colleague or friend (not user's own application)

When true, extract: stage, company, role, deadline, summary, salary, location, etc.
When false, leave all other fields blank but include the row.

Output schema (one item per email; id must equal input id):
jobs: [{"id":"...","is_job":true,"stage":"applied|received|interview_scheduled|interviewed|offer|rejected|withdrawn|forwarded|other","needs_action":false,"action_type":"","priority":"low|medium|high","deadline":null_or_ISO_date,"summary":"","company":"","role":"","salary":"","location":"","remote_mode":"","visa_note":"","reason":"one-sentence justification"}]

Emails to confirm:
${desc}
</task2_jobs>`;
}

function buildMergedPrompt(inputs: MergedInputs): string {
  const sections: string[] = [];
  sections.push(`<task>
You will perform 1-2 INDEPENDENT analytical tasks on the inputs below.
Output ONE JSON object. Include only the top-level keys for tasks present in this prompt.
Possible keys: "classifications", "jobs".
Each task is independent; do not let content from one task influence another.
</task>`);

  if (inputs.classifyEmails.length > 0) {
    sections.push(buildClassifySection(inputs.classifyEmails, inputs.classifyCategories));
  }
  if (inputs.jobsEmails.length > 0) {
    sections.push(buildJobsSection(inputs.jobsEmails));
  }

  sections.push(`<output>
Output exactly one JSON object. Keys: only those listed in the tasks above. No prose, no fences. Begin with { end with }.
</output>`);

  return sections.join("\n\n");
}

async function spawnMerged(prompt: string, timeoutMs: number): Promise<string> {
  const { text } = await runClaude({
    label: "merged-llm",
    prompt,
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    timeoutMs,
  });
  return text;
}

/**
 * Run the merged LLM call. Returns parsed results (best-effort per-key).
 * Never throws — failure modes return EMPTY-ish struct with flags.
 */
export async function runMergedPrefetchLLM(
  inputs: MergedInputs,
  timeoutMs = 90_000,
): Promise<MergedResults> {
  if (
    inputs.classifyEmails.length === 0 &&
    inputs.jobsEmails.length === 0
  ) {
    return EMPTY;
  }

  const prompt = buildMergedPrompt(inputs);
  if (prompt.length > MAX_PROMPT_BYTES) {
    return { ...EMPTY, promptBytes: prompt.length, fellBack: true };
  }

  const t0 = Date.now();
  let raw: string;
  try {
    raw = await spawnMerged(prompt, timeoutMs);
  } catch (e) {
    console.warn("[merged-llm] spawn failed:", e);
    return { ...EMPTY, promptBytes: prompt.length, elapsedMs: Date.now() - t0 };
  }

  const parsed = parseJsonObject<{
    classifications?: unknown;
    jobs?: unknown;
  }>(raw);

  if (!parsed) {
    console.warn("[merged-llm] root JSON parse failed; raw head:", raw.slice(0, 300));
    return { ...EMPTY, promptBytes: prompt.length, rawSize: raw.length, spawned: true, elapsedMs: Date.now() - t0 };
  }

  return {
    classifications: Array.isArray(parsed.classifications) ? parsed.classifications as ClassifyResult[] : [],
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs as ConfirmResult[] : [],
    spawned: true,
    fellBack: false,
    rawSize: raw.length,
    promptBytes: prompt.length,
    elapsedMs: Date.now() - t0,
  };
}
