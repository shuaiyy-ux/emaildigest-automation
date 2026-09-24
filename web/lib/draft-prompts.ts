/**
 * Prompt builders for the 3 draft-generation scenarios:
 *   - replyPrompt  : reply to an existing email (with optional user intent)
 *   - forwardPrompt: forward an existing email with a short lead-in
 *   - composePrompt: polish a blank/partial compose draft
 *
 * Design principles (user-approved):
 * - Provide full context; don't prescribe tone/decisions via hardcoded rules
 * - Let Claude infer tone from the original email's language & style
 * - Never use category_id as a tone proxy (it's a classification label, not a style label)
 * - Don't force yes/no responses; user may want to defer or ask for clarification
 * - No [AI草稿] marker
 */
import type { EmailRow } from "./db";

function buildThreadSection(threadEmails: EmailRow[]): string {
  if (threadEmails.length === 0) {
    return "(This is the first or only email in the thread)";
  }
  return threadEmails
    .map((e, i) => {
      const bodyExcerpt = (e.body || "").slice(0, 600);
      return `[${i + 1}] ${e.date} · ${e.from_name}\nSubject: ${e.subject}\n${bodyExcerpt}`;
    })
    .join("\n---\n");
}

/** Reply to an existing email. User intent is optional — if empty, Claude infers from the original. */
export function replyPrompt(args: {
  email: EmailRow;
  threadEmails: EmailRow[];
  intent?: string;
  userName?: string;
}): string {
  const { email, threadEmails, intent, userName } = args;
  return `The user wants to reply to this email. Generate the reply body.

=== Original email ===
From: ${email.from_name} <${email.from_email}>
Subject: ${email.subject}
Date: ${email.date}
Body:
${(email.body || "").slice(0, 2000)}

=== Conversation history (if any, in chronological order; may be a reply chain or simply emails on the same subject — do not over-infer causality) ===
${buildThreadSection(threadEmails)}

=== User's intent (may be empty) ===
${intent?.trim() || "(unspecified)"}

=== User's name ===
${userName?.trim() || "(not set)"}

=== Requirements ===
1. Reply in the same language as the original email (English email → English reply; Chinese email → Chinese reply).
2. Output only the reply body — no Subject line, no quoted block (the frontend appends those).
3. If the user's name is set, use it as the sign-off; do not add "[AI草稿]" or any AI marker.
4. If the user's intent is empty, produce a reasonable reply based on the original email.
   If the user's intent is non-empty, **center the reply on that intent** — wording and tone serve it.
5. Tone, formality, and length should match the original email (do not be gratuitously more formal or more casual than the original).`;
}

/** Forward an existing email to someone else with a short lead-in note. */
export function forwardPrompt(args: {
  email: EmailRow;
  intent?: string;
  recipientContext?: string;
  userName?: string;
}): string {
  const { email, intent, recipientContext, userName } = args;
  return `The user wants to forward this email to someone else. Generate a short lead-in note.

=== Original email (for your understanding only — do not restate its content in the output) ===
From: ${email.from_name} <${email.from_email}>
Subject: ${email.subject}
Date: ${email.date}
Body: ${(email.body || "").slice(0, 800)}

=== Recipient context (may be empty) ===
${recipientContext?.trim() || "(unspecified)"}

=== What the user wants to say (may be empty) ===
${intent?.trim() || "(unspecified — produce a neutral forward note)"}

=== User's name ===
${userName?.trim() || "(not set)"}

=== Requirements ===
1. Output only 1-3 sentences of lead-in (do not restate the original email — the system auto-appends it).
2. Language: if the recipient context clearly indicates a Chinese-speaking audience, use Chinese; otherwise use the same language as the original email.
3. If the user's name is set, sign off at the end.
4. Do not add "[AI草稿]" or any AI marker.
5. If the user's intent is non-empty, center the note on it; if empty, write a neutral note (e.g. "Forwarding this for your awareness").`;
}

/** Polish a blank/partial compose draft. Uses current subject+body as user intent. */
export function composePrompt(args: {
  subject: string;
  body: string;
  userName?: string;
}): string {
  const { subject, body, userName } = args;
  return `The user is drafting a new email. Polish it into a complete, professional email.

=== User's current input ===
Subject: ${subject?.trim() || "(empty)"}
Body: ${body?.trim() || "(empty)"}

=== User's name ===
${userName?.trim() || "(not set)"}

=== Requirements ===
1. Use the same language as the user's draft.
2. Preserve the user's core intent and key facts; do not fabricate facts.
3. Do not fill in a recipient name (unspecified) — open with a generic greeting ("Hi," / "你好，").
4. If the user's name is set, use it as the sign-off; do not add "[AI草稿]" or any AI marker.
5. Subject should be concise and specific; body should be professional and well-written.
6. Return strict JSON only — no code fences, no explanatory prose, just this single JSON object:
{"subject": "<subject>", "body": "<body>"}`;
}
