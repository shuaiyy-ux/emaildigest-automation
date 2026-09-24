export type Command = "digest" | "draft" | "classify" | "filter" | "inquiry";

export type JobStatus = "running" | "done" | "error";

export interface Job {
  id: string;
  command: Command;
  status: JobStatus;
  result: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Visitor that started the job (X-Demo-User); status polls are scoped to it. */
  user?: string;
  /** Model usage of the job's CLI run, for the demo gateway's X-Demo-Usage header. */
  usage?: import("./demo-usage").ClaudeUsage;
}

export interface RunRequest {
  command: Command;
  args?: string[];
}

export interface StatusResponse {
  jobId: string;
  status: JobStatus;
  result?: string;
  error?: string;
  elapsed: number;
}

// 4-bucket taxonomy (MECE by user intent) + per-email TTL for temporary Primary elevation.
// Legacy values in old DB rows are handled by category_id references.
export type EmailCategory =
  | "primary" | "track" | "news" | "junk"
  // Legacy (kept for compat; migrations clear these):
  | "log" | "feed" | "followup" | "promotion" | "noise"
  | "academic" | "assignment" | "job" | "admin"
  | "newsletter" | "social" | "notification" | "spam"
  | "";

export const CATEGORIES: { value: EmailCategory; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "track", label: "Track" },
  { value: "news", label: "News" },
  { value: "junk", label: "Junk" },
];

export async function changeCategory(
  emailId: string, newCategory: EmailCategory, oldCategory: string,
  fromEmail?: string, subject?: string,
) {
  await Promise.all([
    fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setCategory", ids: [emailId], category: newCategory }) }),
    fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "recordCorrection", emailId, fromEmail: fromEmail || "", subject: subject || "", oldCategory, newCategory }) }),
  ]);
}

export interface Email {
  id: string;
  from: string;
  fromEmail?: string;
  subject: string;
  snippet: string;
  body?: string;       // plain text body (used for quoting in reply, preview, LLM prompts)
  bodyHtml?: string;   // HTML body (used for rendering); '' when email is text-only
  date: string;
  receivedAt?: number;
  category?: EmailCategory;
  categoryId?: string | null;
  confidence?: number;
  classifier?: string;
  threadId?: string;
  isUnread?: boolean;
  primaryUntil?: number | null;   // epoch sec; when in the future, elevates to Priority view
  ttlHint?: string | null;         // derived human-readable "valid for Nm/Nh/Nd" when primary_until active
  isPriority?: boolean;            // derived: cat_primary OR active primary_until
  isJob?: boolean;                 // detail API only: tracked by the Jobs pipeline
}

export interface DynamicCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  isDefault: boolean;
  sortOrder: number;
  exampleCount: number;
}

export type DraftType = "reply" | "forward" | "new";
export type DraftStatus = "draft" | "pushed" | "sent" | "scheduled" | "discarded";

export interface Draft {
  id: string;
  emailId: string | null;
  threadId: string;
  type: DraftType;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  contentType: string;
  status: DraftStatus;
  gmailDraftId: string | null;
  sentAt: number | null;
  gmailMessageId: string | null;
  // Persisted AI Generate state — non-null while a 120s LLM job is in
  // flight, lets DraftEditor resume polling after a page refresh instead
  // of double-spawning. See docs/design/state-boundary.md.
  ai_generating_started_at?: number | null;
  ai_generating_job_id?: string | null;
  // Same shape for Push to Gmail (60s) — server-side lock + frontend resume.
  push_started_at?: number | null;
  push_job_id?: string | null;
  // SMTP sendNow short lock; checked at /api/drafts action=sendNow entry.
  smtp_send_started_at?: number | null;
  createdAt: number;
  updatedAt: number;
}
