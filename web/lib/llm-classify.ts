import { runClaude } from "./claude-cli";
import { sanitizeForPrompt } from "./sanitize";
import { getRecentCorrections } from "./db";
import { parseJsonArray } from "./parse";
const CLASSIFY_MODEL = process.env.EMAILDIGEST_CLASSIFY_MODEL || "sonnet";

export interface ClassifyCategory {
  id: string;
  name: string;
  description: string;
}

export interface ClassifyInput {
  id: string;
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
}

export interface ClassifyResult {
  id: string;
  category: string;       // raw lowercase name returned by LLM
  confidence?: string;    // "high" | "medium" | "low" — LLM self-rating (see mapLLMConfidence)
  primary_until?: string | null;
}

/**
 * LLM-reported confidence tiers. Single source of truth for translating the
 * self-rating into (a) the numeric value stored on emails.confidence and
 * (b) the category_examples source slug used by SOURCE_WEIGHTS in
 * setfit-classify-head.ts.
 *
 * Why tiers instead of a hardcoded 0.9:
 *  - 0.9 across all LLM rows hid the active-learning banner (gated on
 *    0.4 ≤ conf ≤ 0.7) from exactly the emails most likely to be wrong.
 *  - Treating every LLM verdict as `llm_high_conf` weighted retrain samples
 *    uniformly, amplifying LLM error rate (see lessons-learned §25 + the
 *    2026-05-08 weight-bump fallout in 2026-05-10 lessons §1).
 *
 * Tier semantics:
 *  - high   → numeric 0.9, source `llm_high_conf` (weight 25)
 *  - medium → numeric 0.55, source `llm_med_conf`  (weight 5; falls inside
 *             needsUserConfirm 0.4-0.7 so the user sees "AI 信心不足")
 *  - low    → numeric 0.3, NOT回灌 (trainable=false) — we treat low-conf
 *             LLM verdicts as guesses, valuable for routing but not as
 *             training labels.
 *
 * Default when LLM omits / mangles the field: medium (safer than high —
 * surfaces user audit instead of laundering uncertainty as confidence).
 */
export type LLMConfidenceTier = "high" | "medium" | "low";

export interface LLMConfidenceMapping {
  tier: LLMConfidenceTier;
  numeric: number;
  source: string;
  trainable: boolean;
}

export function mapLLMConfidence(raw: string | undefined | null): LLMConfidenceMapping {
  const t = (raw ?? "").toString().trim().toLowerCase();
  if (t === "high") return { tier: "high", numeric: 0.9, source: "llm_high_conf", trainable: true };
  if (t === "low") return { tier: "low", numeric: 0.3, source: "llm_low_conf", trainable: false };
  // "medium" or anything else (missing, typo, unexpected value) → medium default.
  return { tier: "medium", numeric: 0.55, source: "llm_med_conf", trainable: true };
}

export function buildClassifyPrompt(
  emails: ClassifyInput[],
  categories: ClassifyCategory[],
  recentCorrections: ReturnType<typeof getRecentCorrections>,
): string {
  const categoryList = categories
    .map((c) => `${c.name.toLowerCase()}: ${c.description}`)
    .join("\n");

  const desc = emails.map((e) =>
    `ID:${e.id} From:${sanitizeForPrompt(e.from_name)} <${sanitizeForPrompt(e.from_email)}> Subject:${sanitizeForPrompt(e.subject)} Snippet:${sanitizeForPrompt(e.snippet)}`
  ).join("\n");

  const correctionContext = recentCorrections.length > 0
    ? `\nRecent user corrections (for reference only, not hard rules):\n${recentCorrections.map(
        (c) => `- "${c.subject}" from ${c.fromEmail} → user re-labeled as: ${c.userCategory}`
      ).join("\n")}\n`
    : "";

  return `Classify the following emails precisely.

Categories (pick one, return its lowercase name):
${categoryList}

Track vs News — the key distinction is "broadcast vs personal":
  - News = sender broadcasts to all subscribers (the same email goes to many people); you are a passive consumer
    e.g. newsletter, digest, news push, Canvas class-wide announcement, zotmail campus broadcast
  - Track = a record generated specifically for your account or actions
    e.g. order confirmation, receipt, shipping, grades, application receipt, bill, personal verification code

Other rules:
- Sender starting with noreply/mailer/team/notifications/zotmail/alerts/digest → cannot be primary
- A real person writing 1:1 directly to you (personal or company address, not a platform address) → primary
  Counter-example: digest emails from platforms like LinkedIn/Slack/Discord/Canvas may show a person's name in from_name,
  but from_email is messaging-digest-noreply@... / notifications@... — these are still track.
  This holds even when the subject says "Action needed" / "X messaged you" / "X mentioned you".
- Interview invitations and recruiter DMs (real HR/recruiter address, not -noreply) → primary
- Marketing / promotions / spam → junk
- Institutional event promotions ("Register now for X event") → news (campus broadcast) or junk (pure marketing)
${correctionContext}
${desc}

Return strictly a JSON array: [{id, category, confidence, primary_until}]
confidence: your self-rating of how sure you are about this classification — one of:
  - "high"   = clear textbook example of the chosen category; sender / subject / body all align
  - "medium" = the category fits but at least one signal is ambiguous (e.g. could plausibly be a neighbor category)
  - "low"    = you picked the closest match but the email is genuinely borderline or unfamiliar
  Use the tiers honestly — "low" is preferred over guessing "high" on a hard call. The system uses low to skip
  this row from training samples and medium to ask the user to confirm.
primary_until: null or ISO 8601 (the email should be temporarily surfaced in Primary until this time)
  - Verification code → now + 30 minutes
  - Due today → today 23:59
  - Event/deadline tomorrow or this week → event time + 1h
  - Non-time-sensitive → null
category must exactly match one of the lowercase names in the list above. Do not invent new names.`;
}

/**
 * Run LLM classification over a batch of emails. Returns parsed results.
 * Does not write to DB — callers decide how to apply.
 *
 * `signal`: optional AbortSignal — when the API request connection drops
 * (user F5'd or closed the tab during reclassify), we kill the spawn so
 * we don't keep burning Claude tokens for a client that's gone.
 *
 * Throws on subprocess failure; returns [] if LLM output cannot be parsed.
 */
export async function classifyEmailsWithLLM(
  emails: ClassifyInput[],
  categories: ClassifyCategory[],
  opts?: { signal?: AbortSignal },
): Promise<ClassifyResult[]> {
  if (emails.length === 0) return [];
  const corrections = getRecentCorrections(10);
  const prompt = buildClassifyPrompt(emails, categories, corrections);
  const { text } = await runClaude({
    label: "llm-classify",
    prompt,
    model: CLASSIFY_MODEL,
    timeoutMs: 150_000,
    signal: opts?.signal,
  });
  return parseJsonArray<ClassifyResult>(text);
}
