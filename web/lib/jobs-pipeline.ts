/**
 * Jobs Pipeline — the three-step processor for maybe_work-tagged emails.
 *
 * Step 1: LLM confirms whether email is truly a job-related email (is_job bool).
 * Step 2: If yes, resolve WHICH application it belongs to, using:
 *           A. thread_id → existing job_email's application_id
 *           B. sender domain → application_domains mapping (unique hit only)
 *           C. LLM-extracted company+role → normalize → lookup/create
 *           D. Fuzzy merge: same company + role Levenshtein < 3 → same application
 * Step 3: Write job_emails + refresh application snapshot.
 *
 * This replaces the old isJobCandidate regex prefilter + classifyJobEmails
 * monolith. Hard rules are gone — maybe_work tagging (embedding cosine) is
 * the only gate, and Step 1 LLM is the authoritative classifier.
 */
import db, {
  upsertJobEmail,
  markJobSkipped,
  addApplicationDomain,
  findApplicationsByDomain,
  getMaybeWorkEmails,
  setJobEmailApplicationId,
  type EmailRow,
} from "./db";
import {
  findOrCreateApplication,
  normalizeCompany,
  normalizeRole,
  recomputeApplicationFromEmails,
} from "./applications";
import { runClaude } from "./claude-cli";
import { sanitizeForPrompt } from "./sanitize";
import { parseJsonArray, parseJsonObject } from "./parse";

const JOBS_MODEL = process.env.EMAILDIGEST_JOBS_MODEL || "sonnet";

// ------------------------------------------------------------------
// Step 1 prompt — LLM is_job confirmation (batch, minimal output).
// ------------------------------------------------------------------

const CONFIRM_PROMPT_HEADER = `You are a gate classifier for job-search emails. For each email, output strict JSON and decide only whether it is "directly related to the user's personal job-search process".

true when:
- ATS application confirmation / real HR outreach / interview scheduling / calendar invite
- Assessment / take-home / coding challenge instructions
- Offer / rejection / withdrawal notice
- Recruiter reaching out 1:1 (cold outreach counts)

false when:
- Platform digests from LinkedIn / Indeed / Handshake ("5 jobs match your search")
- Campus career-fair broadcasts / job-search course ads / career fair notices
- Company newsletters mentioning hiring but not targeting the user personally
- Job links forwarded by a colleague or friend (not something the user applied to)

When true, extract the additional fields. When false, leave all other fields blank.

Output a strict JSON array, one item per email; id must equal the input id:
[{"id":"...","is_job":true,"stage":"applied|received|interview_scheduled|interviewed|offer|rejected|withdrawn|forwarded|other","needs_action":false,"action_type":"","priority":"medium","deadline":null,"summary":"","company":"","role":"","salary":"","location":"","remote_mode":"","visa_note":"","reason":"one-sentence justification"}]
`;

interface ConfirmResult {
  id: string;
  is_job: boolean;
  stage: string;
  needs_action: boolean;
  action_type: string;
  priority: string;
  deadline: string | null;
  summary: string;
  company: string;
  role: string;
  salary: string;
  location: string;
  remote_mode: string;
  visa_note: string;
  reason: string;
}

export async function llmConfirmBatch(emails: EmailRow[]): Promise<ConfirmResult[]> {
  if (emails.length === 0) return [];
  const desc = emails.map((e) => {
    const bodyPreview = sanitizeForPrompt(((e.body || e.snippet || "") as string).slice(0, 1500));
    return `--- email id=${e.id} ---
From: ${sanitizeForPrompt(e.from_name)} <${sanitizeForPrompt(e.from_email)}>
Subject: ${sanitizeForPrompt(e.subject)}
Body: ${bodyPreview}`;
  }).join("\n\n");

  const prompt = `${CONFIRM_PROMPT_HEADER}\nEmails:\n${desc}`;
  const { text } = await runClaude({ label: "jobs-confirm", prompt, model: JOBS_MODEL, timeoutMs: 150_000 });
  return parseJsonArray<ConfirmResult>(text);
}

// ------------------------------------------------------------------
// Step 2 — four-layer application matching.
// ------------------------------------------------------------------

function domainOf(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).toLowerCase().trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

/** Layer A: thread_id → existing application via past job_emails in same thread. */
function matchByThread(threadId: string): string | null {
  if (!threadId) return null;
  const row = db.prepare(`
    SELECT je.application_id
    FROM emails e
    JOIN job_emails je ON je.email_id = e.id
    WHERE e.thread_id = ? AND je.application_id IS NOT NULL
    ORDER BY e.received_at DESC
    LIMIT 1
  `).get(threadId) as { application_id: string } | undefined;
  return row?.application_id ?? null;
}

/** Layer B: sender domain → unique application hit. Multiple hits → null (need Layer C). */
function matchByDomain(fromEmail: string): string | null {
  const domain = domainOf(fromEmail);
  if (!domain) return null;
  const ids = findApplicationsByDomain(domain);
  if (ids.length === 1) return ids[0];
  return null;
}

/** Layer D: fuzzy merge — within the same company, existing role with Levenshtein < 3. */
function matchByFuzzyRole(company: string, role: string): string | null {
  const normCo = normalizeCompany(company);
  if (!normCo) return null;
  const normRole = normalizeRole(role);
  const rows = db.prepare(
    "SELECT id, role FROM applications WHERE company = ?"
  ).all(normCo) as { id: string; role: string }[];
  for (const r of rows) {
    if (levenshtein(r.role, normRole) < 3) return r.id;
  }
  return null;
}

/**
 * Resolve an email to its application. Tries four layers in order.
 * Returns the application id. Always succeeds (creates if needed).
 */
export function resolveApplication(args: {
  emailId: string;
  threadId: string;
  fromEmail: string;
  company: string;
  role: string;
  receivedAt: number;
}): string {
  // Layer A: thread
  let appId = matchByThread(args.threadId);
  if (appId) return appId;

  // Layer B: domain
  appId = matchByDomain(args.fromEmail);
  if (appId) {
    // Record this domain for future fast-path (already in table but cheap idempotent)
    addApplicationDomain(appId, domainOf(args.fromEmail));
    return appId;
  }

  // Layer D (before C since fuzzy can dedupe before creating)
  if (args.company) {
    appId = matchByFuzzyRole(args.company, args.role);
    if (appId) {
      addApplicationDomain(appId, domainOf(args.fromEmail));
      return appId;
    }
  }

  // Layer C: findOrCreate by normalized (company, role)
  appId = findOrCreateApplication({
    company: args.company,
    role: args.role,
    firstEmailAt: args.receivedAt,
  });
  addApplicationDomain(appId, domainOf(args.fromEmail));
  return appId;
}

// ------------------------------------------------------------------
// Orchestrator — consume maybe_work queue end-to-end.
// ------------------------------------------------------------------

export interface PipelineStats {
  candidates: number;
  isJobTrue: number;
  isJobFalse: number;
  matchedByThread: number;
  matchedByDomain: number;
  matchedByFuzzy: number;
  createdNew: number;
  errors: number;
}

/**
 * Apply pre-parsed LLM jobs-confirm results to DB. Extracted so the merged
 * prefetch path (lib/merged-prefetch-llm.ts) can reuse the same DB write
 * logic without re-spawning Claude.
 */
export function applyJobsLLMResults(
  results: ConfirmResult[],
  batch: EmailRow[],
  stats: PipelineStats,
): void {
  const byId = new Map(batch.map((e) => [e.id, e]));
  for (const r of results) {
    const email = byId.get(r.id);
    if (!email) continue;
    if (!r.is_job) {
      markJobSkipped(email.id, r.reason || "llm:not_job");
      stats.isJobFalse++;
      continue;
    }
    stats.isJobTrue++;

    const preThread = matchByThread(email.thread_id);
    const preDomain = preThread ? null : matchByDomain(email.from_email);
    const appId = resolveApplication({
      emailId: email.id,
      threadId: email.thread_id,
      fromEmail: email.from_email,
      company: r.company,
      role: r.role,
      receivedAt: email.received_at,
    });
    if (preThread) stats.matchedByThread++;
    else if (preDomain) stats.matchedByDomain++;
    else if (normalizeCompany(r.company) && matchByFuzzyRole(r.company, r.role) === appId) stats.matchedByFuzzy++;
    else stats.createdNew++;

    const deadlineSec = r.deadline
      ? (() => {
          const ts = Math.floor(new Date(r.deadline!).getTime() / 1000);
          return Number.isFinite(ts) ? ts : null;
        })()
      : null;
    upsertJobEmail({
      emailId: email.id,
      stage: r.stage || "other",
      needsAction: !!r.needs_action,
      actionType: r.action_type || "",
      priority: r.priority || "medium",
      deadline: deadlineSec,
      summary: r.summary || "",
      company: r.company || "",
      role: r.role || "",
      salary: r.salary || "",
      location: r.location || "",
      remoteMode: r.remote_mode || "",
      visaNote: r.visa_note || "",
    });
    setJobEmailApplicationId(email.id, appId);
    recomputeApplicationFromEmails(appId);
  }
}

/**
 * Process a batch of maybe_work=1 emails through Steps 1-3.
 * Caller provides the batch (e.g. prefetch passes current-batch emails;
 * reset-and-replay iterates full history).
 */
export async function runJobsPipeline(batch: EmailRow[]): Promise<PipelineStats> {
  const stats: PipelineStats = {
    candidates: batch.length,
    isJobTrue: 0,
    isJobFalse: 0,
    matchedByThread: 0,
    matchedByDomain: 0,
    matchedByFuzzy: 0,
    createdNew: 0,
    errors: 0,
  };
  if (batch.length === 0) return stats;

  // Step 1: LLM confirm (chunk by 20 to keep prompts focused)
  const chunks: EmailRow[][] = [];
  for (let i = 0; i < batch.length; i += 20) chunks.push(batch.slice(i, i + 20));

  for (const chunk of chunks) {
    try {
      const results = await llmConfirmBatch(chunk);
      applyJobsLLMResults(results, chunk, stats);
    } catch (e) {
      console.error("[jobs-pipeline] chunk error:", e);
      stats.errors++;
    }
  }

  return stats;
}

/** ConfirmResult exported for the merged-prefetch path. */
export type { ConfirmResult };

/** Build the empty stats struct — used by merged path to track its own counters. */
export function newPipelineStats(candidates: number): PipelineStats {
  return {
    candidates,
    isJobTrue: 0,
    isJobFalse: 0,
    matchedByThread: 0,
    matchedByDomain: 0,
    matchedByFuzzy: 0,
    createdNew: 0,
    errors: 0,
  };
}

/** Convenience: pull from DB and process. Used by prefetch Step 3 + reset-and-replay. */
export async function drainMaybeWorkQueue(opts: { max?: number } = {}): Promise<PipelineStats> {
  const all = getMaybeWorkEmails();
  const batch = opts.max ? all.slice(0, opts.max) : all;
  return runJobsPipeline(batch);
}

// ------------------------------------------------------------------
// Force path — user has explicitly said "this IS a job", skip is_job gate.
// Only extract fields, then resolve application + write job_emails.
// ------------------------------------------------------------------

const EXTRACT_PROMPT_HEADER = `You are extracting structured fields from a job-search email that the user has EXPLICITLY confirmed is job-related. Do not question that classification; just extract fields.

Output strict JSON (single object, no array, no commentary):
{"stage":"applied|received|interview_scheduled|interviewed|offer|rejected|withdrawn|forwarded|other","needs_action":false,"action_type":"","priority":"low|medium|high","deadline":null,"summary":"","company":"","role":"","salary":"","location":"","remote_mode":"","visa_note":""}

Guidance:
- If the email signals a rejection (regret/unfortunately/move forward with other candidates/not selected/declined), set stage="rejected".
- If the email schedules / proposes / confirms an interview, stage="interview_scheduled".
- If role/company are not present in this email, leave them blank — downstream linking by thread/domain will still work.
- summary: one concise sentence in the email's language.
- deadline: ISO date if present, otherwise null.
`;

interface ExtractResult {
  stage: string;
  needs_action: boolean;
  action_type: string;
  priority: string;
  deadline: string | null;
  summary: string;
  company: string;
  role: string;
  salary: string;
  location: string;
  remote_mode: string;
  visa_note: string;
}

export interface ForceClassifyResult {
  emailId: string;
  applicationId: string;
  stage: string;
  company: string;
  role: string;
  matchedBy: "thread" | "domain" | "fuzzy" | "new";
}

/**
 * Force-classify a single email as job-related (user-driven). Bypasses the
 * is_job LLM gate; runs only field extraction → resolveApplication → upsert.
 * Caller is responsible for setMaybeWork / clearJobSkipped / upsertWorkLabel.
 */
export async function forceClassifySingleEmail(emailId: string): Promise<ForceClassifyResult | null> {
  const email = db.prepare(
    "SELECT id, from_name, from_email, subject, snippet, body, thread_id, received_at FROM emails WHERE id = ?"
  ).get(emailId) as EmailRow | undefined;
  if (!email) return null;

  const bodyPreview = sanitizeForPrompt(((email.body || email.snippet || "") as string).slice(0, 1500));
  const prompt = `${EXTRACT_PROMPT_HEADER}
Email:
From: ${sanitizeForPrompt(email.from_name)} <${sanitizeForPrompt(email.from_email)}>
Subject: ${sanitizeForPrompt(email.subject)}
Body: ${bodyPreview}`;

  // breaker "record": user explicit right-click "Classify as Job related" —
  // an artificial breaker-open block here would silently reject user intent.
  const { text } = await runClaude({ label: "jobs-force", prompt, model: JOBS_MODEL, timeoutMs: 120_000, breaker: "record" });
  const parsed = parseJsonObject<ExtractResult>(text) || ({} as ExtractResult);

  // Track which layer matched (parallels runJobsPipeline's stats logic)
  const preThread = matchByThread(email.thread_id);
  const preDomain = preThread ? null : matchByDomain(email.from_email);
  const appId = resolveApplication({
    emailId: email.id,
    threadId: email.thread_id,
    fromEmail: email.from_email,
    company: parsed.company || "",
    role: parsed.role || "",
    receivedAt: email.received_at,
  });
  let matchedBy: ForceClassifyResult["matchedBy"];
  if (preThread) matchedBy = "thread";
  else if (preDomain) matchedBy = "domain";
  else if (normalizeCompany(parsed.company || "") && matchByFuzzyRole(parsed.company || "", parsed.role || "") === appId) matchedBy = "fuzzy";
  else matchedBy = "new";

  const deadlineSec = parsed.deadline
    ? (() => {
        const ts = Math.floor(new Date(parsed.deadline!).getTime() / 1000);
        return Number.isFinite(ts) ? ts : null;
      })()
    : null;

  upsertJobEmail({
    emailId: email.id,
    stage: parsed.stage || "other",
    needsAction: !!parsed.needs_action,
    actionType: parsed.action_type || "",
    priority: parsed.priority || "medium",
    deadline: deadlineSec,
    summary: parsed.summary || "",
    company: parsed.company || "",
    role: parsed.role || "",
    salary: parsed.salary || "",
    location: parsed.location || "",
    remoteMode: parsed.remote_mode || "",
    visaNote: parsed.visa_note || "",
  });
  setJobEmailApplicationId(email.id, appId);
  recomputeApplicationFromEmails(appId);

  return {
    emailId: email.id,
    applicationId: appId,
    stage: parsed.stage || "other",
    company: parsed.company || "",
    role: parsed.role || "",
    matchedBy,
  };
}
