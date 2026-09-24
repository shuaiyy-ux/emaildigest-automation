import Database from "better-sqlite3";
import path from "path";
import { hasTimeSignal } from "./time-signal";

const DB_PATH = path.resolve(
  process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."),
  "data.db"
);

// `next build` evaluates route modules in parallel workers to collect page
// data. Give them a throwaway in-memory DB: the build must not create or
// migrate the real data.db (parallel first-time schema creation raced into
// SQLITE_BUSY).
const IN_BUILD = process.env.NEXT_PHASE === "phase-production-build";
const db = new Database(IN_BUILD ? ":memory:" : DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'notification',
    urgency TEXT NOT NULL DEFAULT 'fyi',
    confidence REAL NOT NULL DEFAULT 0,
    classifier TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    is_unread INTEGER NOT NULL DEFAULT 1,
    received_at INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
    classified_at INTEGER
  )
`);

// Migrate: add embedding, category_id, primary_until, body_html columns to existing emails table
try { db.exec("ALTER TABLE emails ADD COLUMN embedding BLOB"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN category_id TEXT"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN primary_until INTEGER"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN body_html TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN maybe_work INTEGER NOT NULL DEFAULT 0"); } catch {}
// SetFit task-tuned embedding cache (separate from emails.embedding which is
// generic MiniLM for primary/track centroids). Populated by prefetch Step 2a
// when SetFit model files are present; null if SetFit unavailable. Used by
// work-classifier retrain (lib/setfit-head.ts) so we don't re-encode each
// labeled email on every warm-start retrain.
try { db.exec("ALTER TABLE emails ADD COLUMN work_embedding BLOB"); } catch {}
// SetFit 4-way Inbox classifier embedding cache. Same scheme as
// work_embedding but for the primary/track/news/junk decision.
try { db.exec("ALTER TABLE emails ADD COLUMN classify_embedding BLOB"); } catch {}
// Gmail-style structural headers extracted by lib/imap.ts.
// Used by lib/sender-features.ts (Layer 2 of the 394-d feature vector).
// Empty string = header absent or "no"; any non-empty value = header present.
// We store the value not just a flag because future logic may parse list-id
// for sender ledger (e.g., announcements@listserv.example.edu).
try { db.exec("ALTER TABLE emails ADD COLUMN list_unsubscribe TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN list_id TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN auto_submitted TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE emails ADD COLUMN precedence TEXT NOT NULL DEFAULT ''"); } catch {}

// Migrate: undo the historical bad default. Rows where category_id never got
// written but classifier defaulted to 'llm' looked "decided" but were never
// actually classified — flip them back to '' so prefetch picks them up.
try {
  const r = db.prepare(
    "UPDATE emails SET classifier = '' WHERE category_id IS NULL AND classifier = 'llm'"
  ).run();
  if (r.changes > 0) console.log(`[db] Migration: reset classifier on ${r.changes} fake-classified rows`);
} catch {}


export interface EmailRow {
  id: string;
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
  body: string;
  body_html: string;
  date: string;
  category: string;
  urgency: string;
  confidence: number;
  classifier: string;
  thread_id: string;
  is_unread: number;
  received_at: number;
  fetched_at: number;
  classified_at: number | null;
  embedding: Buffer | null;
  category_id: string | null;
  primary_until: number | null;
  /** Gmail-style headers extracted at IMAP fetch time. Empty string when
   *  header absent. See lib/sender-features.ts for how these feed the 394-d
   *  classifier input. */
  list_unsubscribe?: string;
  list_id?: string;
  auto_submitted?: string;
  precedence?: string;
  /** Only populated by queries that explicitly compute it (e.g. daily-digest
   *  thread-dedup window). Counts emails in the same thread within the query
   *  result set. Undefined means the query didn't ask — not that size is 1. */
  thread_size?: number;
}

export function upsertEmails(
  emails: {
    id: string;
    from: string;
    fromEmail?: string;
    subject: string;
    snippet: string;
    body?: string;
    bodyHtml?: string;
    date: string;
    category: string;
    isUnread: boolean;
    receivedAt?: number;
    listUnsubscribe?: string;
    listId?: string;
    autoSubmitted?: string;
    precedence?: string;
  }[]
) {
  const stmt = db.prepare(`
    INSERT INTO emails (id, from_name, from_email, subject, snippet, body, body_html, date, category, classifier, is_unread, received_at, fetched_at, classified_at, list_unsubscribe, list_id, auto_submitted, precedence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, unixepoch(), unixepoch(), ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      from_name = excluded.from_name,
      from_email = CASE WHEN excluded.from_email = '' THEN emails.from_email ELSE excluded.from_email END,
      subject = excluded.subject,
      snippet = excluded.snippet,
      body = CASE WHEN excluded.body = '' THEN emails.body ELSE excluded.body END,
      body_html = CASE WHEN excluded.body_html = '' THEN emails.body_html ELSE excluded.body_html END,
      date = excluded.date,
      -- Keep existing category if a classifier (any) has touched the row.
      -- Pre-2026-05-07 only protected 'user'/'llm' so setfit/minilm verdicts
      -- got stomped back to 'notification' on every IMAP re-fetch — legacy
      -- column then lied about which bucket the email was in. The category_id
      -- column (FK to categories.id) was unaffected, so user-visible behavior
      -- was OK, but counts/audits/legacy-fallback paths drifted.
      category = CASE WHEN emails.classifier = '' OR emails.classifier IS NULL THEN excluded.category ELSE emails.category END,
      -- Local "mark as read" is a one-way transition: once the user marks
      -- it read, we never let IMAP flip it back to unread. But if IMAP
      -- later reports the message as read (user read it on phone), we do
      -- sync that in. Gmail folder is opened read-only so our local reads
      -- can't propagate upstream, which is why this asymmetry is needed.
      is_unread = CASE WHEN excluded.is_unread = 0 THEN 0 ELSE emails.is_unread END,
      received_at = CASE WHEN excluded.received_at = 0 THEN emails.received_at ELSE excluded.received_at END,
      fetched_at = unixepoch(),
      -- Headers: keep existing non-empty value if IMAP re-fetch returns empty.
      -- This protects backfill-extracted values from being overwritten by a
      -- re-fetch path that doesn't (yet) extract headers.
      list_unsubscribe = CASE WHEN excluded.list_unsubscribe = '' THEN emails.list_unsubscribe ELSE excluded.list_unsubscribe END,
      list_id = CASE WHEN excluded.list_id = '' THEN emails.list_id ELSE excluded.list_id END,
      auto_submitted = CASE WHEN excluded.auto_submitted = '' THEN emails.auto_submitted ELSE excluded.auto_submitted END,
      precedence = CASE WHEN excluded.precedence = '' THEN emails.precedence ELSE excluded.precedence END
      -- Do NOT bump classified_at on re-fetch. classified_at means "when did
      -- a classifier last touch this row" and should only move forward when
      -- updateCategories / setEmailCategoryId / minilmStmt / setfitStmt / llmStmt
      -- writes a new verdict. Bumping it on every IMAP re-fetch (every 60s
      -- refresh + every IDLE event) makes monitoring queries useless and was
      -- the source of the "200 emails classified at the same second" anomaly.
  `);

  const tx = db.transaction(() => {
    for (const e of emails) {
      stmt.run(
        e.id, e.from, e.fromEmail || "", e.subject, e.snippet,
        e.body || "", e.bodyHtml || "", e.date, e.category,
        e.isUnread ? 1 : 0, e.receivedAt ?? 0,
        e.listUnsubscribe || "", e.listId || "",
        e.autoSubmitted || "", e.precedence || "",
      );
    }
  });
  tx();
}

export function getAllEmails(): EmailRow[] {
  return db.prepare("SELECT * FROM emails ORDER BY received_at DESC, fetched_at DESC").all() as EmailRow[];
}

export function getEmailById(id: string): EmailRow | undefined {
  return db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as EmailRow | undefined;
}

/**
 * Fetch other emails in the same Gmail thread, oldest → newest.
 * Used by draft-gen to give Claude conversation history when writing a reply.
 * Excludes the email being replied to (already in the main prompt).
 * Returns [] if threadId is empty or no siblings exist.
 */
export function getThreadEmails(threadId: string, excludeEmailId: string, limit = 3): EmailRow[] {
  if (!threadId) return [];
  return db.prepare(
    `SELECT * FROM emails
     WHERE thread_id = ? AND id != ? AND body != ''
     ORDER BY received_at ASC
     LIMIT ?`
  ).all(threadId, excludeEmailId, limit) as EmailRow[];
}

export function getEmailCount(): number {
  return (db.prepare("SELECT COUNT(*) as c FROM emails").get() as { c: number }).c;
}

export function updateCategories(ids: string[], category: string, classifier?: string) {
  const placeholders = ids.map(() => "?").join(",");
  if (classifier) {
    db.prepare(
      `UPDATE emails SET category = ?, classifier = ?, classified_at = unixepoch() WHERE id IN (${placeholders})`
    ).run(category, classifier, ...ids);
  } else {
    db.prepare(
      `UPDATE emails SET category = ?, classified_at = unixepoch() WHERE id IN (${placeholders})`
    ).run(category, ...ids);
  }
}

export function markCategoriesAsRead(categories: string[]): number {
  const placeholders = categories.map(() => "?").join(",");
  const result = db.prepare(
    `UPDATE emails SET is_unread = 0 WHERE is_unread = 1 AND category IN (${placeholders})`
  ).run(...categories);
  return result.changes;
}

/**
 * Like markCategoriesAsRead but keyed by `category_id` (the new authoritative
 * column) instead of the legacy `category` short-name. Fixes the case where
 * an email has `category='notification'` (legacy) + `category_id='cat_track'`
 * and would otherwise be missed by a `category IN (...)` filter.
 */
export function markCategoryIdsAsRead(categoryIds: string[]): number {
  if (categoryIds.length === 0) return 0;
  const placeholders = categoryIds.map(() => "?").join(",");
  const result = db.prepare(
    `UPDATE emails SET is_unread = 0 WHERE is_unread = 1 AND category_id IN (${placeholders})`
  ).run(...categoryIds);
  return result.changes;
}

export function setEmailRead(id: string, isUnread: boolean) {
  db.prepare("UPDATE emails SET is_unread = ? WHERE id = ?").run(isUnread ? 1 : 0, id);
}

export function updateEmailBodies(id: string, bodies: { body?: string; bodyHtml?: string }) {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (bodies.body !== undefined) { fields.push("body = ?"); values.push(bodies.body); }
  if (bodies.bodyHtml !== undefined) { fields.push("body_html = ?"); values.push(bodies.bodyHtml); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE emails SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// --- Briefings cache (REMOVED 2026-05-02) ---
// Per-category dashboard summaries were retired. Briefings stale-trigger was
// the dominant merged-prefetch spawn driver (every new email → briefing
// stale → spawn fired). UX consolidated into a single email-digest at
// dashboard top, refreshed every 2h with stale-check.
try { db.exec("DROP TABLE IF EXISTS briefings"); } catch {}
try { db.prepare("DELETE FROM app_state WHERE key = 'daily_digest'").run(); } catch {}

// --- Structured logs (debug-friendly, queryable) ---
// See lib/logger.ts for the API. SQLite-backed so logs survive restart and
// can be filtered by component / level / time / trace_id with plain SQL.
// Retention: 7 days, cleaned at startup. Indexes on (ts) and
// (component, ts) cover the typical "recent activity by subsystem" query;
// partial index on warn/error speeds incident triage.
db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL DEFAULT (unixepoch()),
    level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
    component TEXT NOT NULL,
    message TEXT NOT NULL,
    ctx TEXT,
    trace_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_component_ts ON logs(component, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs(level, ts DESC) WHERE level IN ('warn','error');
`);
try {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const r = db.prepare("DELETE FROM logs WHERE ts < ?").run(cutoff);
  if (r.changes > 0) console.log(`[db] log retention: deleted ${r.changes} rows older than 7 days`);
} catch {}

// --- Corrections (user feedback) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL,
    from_email TEXT NOT NULL,
    from_domain TEXT NOT NULL,
    subject TEXT NOT NULL,
    ml_category TEXT NOT NULL,
    user_category TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

export function insertCorrection(
  emailId: string, fromEmail: string, subject: string,
  mlCategory: string, userCategory: string
) {
  const domain = fromEmail.includes("@") ? fromEmail.split("@")[1] : fromEmail;
  db.prepare(`
    INSERT INTO corrections (email_id, from_email, from_domain, subject, ml_category, user_category)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(emailId, fromEmail, domain, subject, mlCategory, userCategory);
}

/** Returns recent corrections for LLM few-shot context */
export function getRecentCorrections(limit = 10): { fromEmail: string; subject: string; mlCategory: string; userCategory: string }[] {
  return db.prepare(
    "SELECT from_email AS fromEmail, subject, ml_category AS mlCategory, user_category AS userCategory FROM corrections ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as { fromEmail: string; subject: string; mlCategory: string; userCategory: string }[];
}

// --- Drafts (local-first) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    email_id TEXT,
    thread_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'reply',
    to_address TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '',
    bcc TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    status TEXT NOT NULL DEFAULT 'draft',
    gmail_draft_id TEXT,
    sent_at INTEGER,
    gmail_message_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Migrate: add new columns if they don't exist (for pre-existing DBs)
try { db.exec("ALTER TABLE drafts ADD COLUMN sent_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE drafts ADD COLUMN gmail_message_id TEXT"); } catch {}
try { db.exec("ALTER TABLE drafts ADD COLUMN scheduled_at INTEGER"); } catch {}
// Circuit-breaker tracking for the scheduled-drafts cron: if SMTP keeps
// rejecting, stop retrying after MAX_SEND_ATTEMPTS and surface to the UI.
try { db.exec("ALTER TABLE drafts ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE drafts ADD COLUMN last_send_error TEXT"); } catch {}
try { db.exec("ALTER TABLE drafts ADD COLUMN last_send_attempt_at INTEGER"); } catch {}
// State-boundary persistence: AI Generate is a 120s LLM job. Anchor the
// in-flight state to the draft so F5 mid-generation can resume the same
// jobId instead of double-spawning. See docs/design/state-boundary.md.
try { db.exec("ALTER TABLE drafts ADD COLUMN ai_generating_started_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE drafts ADD COLUMN ai_generating_job_id TEXT"); } catch {}
// Same shape for Push to Gmail (60s subprocess that creates a Gmail draft).
// F5 / multi-tab without this anchor → second click double-spawns gmail_create_draft.
try { db.exec("ALTER TABLE drafts ADD COLUMN push_started_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE drafts ADD COLUMN push_job_id TEXT"); } catch {}
// Short server-side lock for the SMTP sendNow path. The 10s undo window lives
// in the client, but once the request is in flight we still need a marker so
// network retry / double-click in another tab can't fire sendEmail twice.
try { db.exec("ALTER TABLE drafts ADD COLUMN smtp_send_started_at INTEGER"); } catch {}
// Per-visitor scoping for the public demo (X-Demo-User). Always 'owner'
// outside DEMO_MODE, so single-user behavior is unchanged.
try { db.exec("ALTER TABLE drafts ADD COLUMN demo_user TEXT NOT NULL DEFAULT 'owner'"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
  )
`);

// Email attachments (parsed from inbound .eml files).
db.exec(`
  CREATE TABLE IF NOT EXISTS email_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    content_id TEXT,                     -- for inline images (cid:…)
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

export interface DraftRow {
  id: string;
  email_id: string | null;
  thread_id: string;
  type: string;
  to_address: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  content_type: string;
  status: string;
  gmail_draft_id: string | null;
  sent_at: number | null;
  gmail_message_id: string | null;
  scheduled_at?: number | null;
  send_attempts?: number;
  last_send_error?: string | null;
  last_send_attempt_at?: number | null;
  ai_generating_started_at?: number | null;
  ai_generating_job_id?: string | null;
  push_started_at?: number | null;
  push_job_id?: string | null;
  smtp_send_started_at?: number | null;
  demo_user?: string;
  created_at: number;
  updated_at: number;
}

export function markDraftSent(id: string, gmailMessageId: string) {
  db.prepare(
    "UPDATE drafts SET status = 'sent', sent_at = unixepoch(), gmail_message_id = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(gmailMessageId, id);
}

export function scheduleDraft(id: string, sendAt: number) {
  db.prepare(
    "UPDATE drafts SET status = 'scheduled', scheduled_at = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(sendAt, id);
}

export function getScheduledDraftsDue(now: number): DraftRow[] {
  return db.prepare("SELECT * FROM drafts WHERE status = 'scheduled' AND scheduled_at <= ?").all(now) as DraftRow[];
}

/** Mark a scheduled-send attempt as failed; increments counter, records error. */
export function recordDraftSendFailure(id: string, error: string) {
  db.prepare(
    `UPDATE drafts
     SET send_attempts = COALESCE(send_attempts, 0) + 1,
         last_send_error = ?,
         last_send_attempt_at = unixepoch(),
         updated_at = unixepoch()
     WHERE id = ?`
  ).run(error.slice(0, 500), id);
}

/** Trip the circuit: move draft from 'scheduled' → 'send_failed'. Cron stops retrying. */
export function markDraftSendFailed(id: string) {
  db.prepare(
    `UPDATE drafts SET status = 'send_failed', updated_at = unixepoch() WHERE id = ?`
  ).run(id);
}

/** Mark a draft's AI generation as in-flight. Anchors the running job_id to
 *  the draft so a page refresh during the 120s LLM call can resume polling
 *  without spawning a duplicate. */
export function markDraftAiGenerating(id: string, jobId: string) {
  db.prepare(
    `UPDATE drafts SET ai_generating_started_at = unixepoch(), ai_generating_job_id = ? WHERE id = ?`
  ).run(jobId, id);
}

/** Clear AI generation markers. Called by frontend (`action=ackAi`) once it
 *  observes a terminal job status, and by aiGenerate itself before starting
 *  a fresh run (defense-in-depth against stale markers). */
export function clearDraftAiGenerating(id: string) {
  db.prepare(
    `UPDATE drafts SET ai_generating_started_at = NULL, ai_generating_job_id = NULL WHERE id = ?`
  ).run(id);
}

/** Mark a draft as currently being pushed to Gmail. Same shape as the AI
 *  Generate marker; see the column comment in the schema migration block. */
export function markDraftPushing(id: string, jobId: string) {
  db.prepare(
    `UPDATE drafts SET push_started_at = unixepoch(), push_job_id = ? WHERE id = ?`
  ).run(jobId, id);
}

export function clearDraftPushing(id: string) {
  db.prepare(
    `UPDATE drafts SET push_started_at = NULL, push_job_id = NULL WHERE id = ?`
  ).run(id);
}

/** Short lock around the SMTP sendNow path. Cleared after sendEmail returns
 *  (success → markDraftSent overwrites; failure → explicit clear). */
export function markDraftSmtpSending(id: string) {
  db.prepare(
    `UPDATE drafts SET smtp_send_started_at = unixepoch() WHERE id = ?`
  ).run(id);
}

export function clearDraftSmtpSending(id: string) {
  db.prepare(
    `UPDATE drafts SET smtp_send_started_at = NULL WHERE id = ?`
  ).run(id);
}

/** Reset circuit + move back to scheduled (user clicks Retry). */
export function retryFailedDraft(id: string, sendAt: number) {
  db.prepare(
    `UPDATE drafts
     SET status = 'scheduled',
         scheduled_at = ?,
         send_attempts = 0,
         last_send_error = NULL,
         updated_at = unixepoch()
     WHERE id = ?`
  ).run(sendAt, id);
}

/** All of `user`'s drafts in 'send_failed' state for surfacing in the UI. */
export function getFailedScheduledDrafts(user: string): DraftRow[] {
  return db.prepare("SELECT * FROM drafts WHERE status = 'send_failed' AND demo_user = ? ORDER BY last_send_attempt_at DESC").all(user) as DraftRow[];
}

export interface AttachmentRow {
  id: number;
  draft_id: string;
  filename: string;
  path: string;
  size: number;
  mime_type: string;
  created_at: number;
}

export function addAttachment(draftId: string, filename: string, path: string, size: number, mimeType: string): AttachmentRow {
  const stmt = db.prepare("INSERT INTO attachments (draft_id, filename, path, size, mime_type) VALUES (?, ?, ?, ?, ?)");
  const result = stmt.run(draftId, filename, path, size, mimeType);
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(result.lastInsertRowid) as AttachmentRow;
}

export function getAttachments(draftId: string): AttachmentRow[] {
  return db.prepare("SELECT * FROM attachments WHERE draft_id = ? ORDER BY id").all(draftId) as AttachmentRow[];
}

export function getAttachmentById(id: number): AttachmentRow | undefined {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
}

export function deleteAttachmentByDraft(draftId: string, id: number): AttachmentRow | undefined {
  const row = db.prepare("SELECT * FROM attachments WHERE id = ? AND draft_id = ?").get(id, draftId) as AttachmentRow | undefined;
  if (!row) return undefined;
  db.prepare("DELETE FROM attachments WHERE id = ? AND draft_id = ?").run(id, draftId);
  return row;
}

export function deleteAttachment(id: number): AttachmentRow | undefined {
  const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
  if (row) db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  return row;
}

export interface EmailAttachmentRow {
  id: number;
  email_id: string;
  filename: string;
  path: string;
  size: number;
  mime_type: string;
  content_id: string | null;
  created_at: number;
}

export function getEmailAttachments(emailId: string): EmailAttachmentRow[] {
  return db.prepare(
    "SELECT * FROM email_attachments WHERE email_id = ? ORDER BY id"
  ).all(emailId) as EmailAttachmentRow[];
}

export function getEmailAttachment(id: number): EmailAttachmentRow | undefined {
  return db.prepare("SELECT * FROM email_attachments WHERE id = ?").get(id) as EmailAttachmentRow | undefined;
}

/** Returns distinct email addresses from received emails and previously sent drafts */
export function getContacts(): { email: string; name: string; count: number }[] {
  const rows = db.prepare(`
    SELECT from_email AS email, from_name AS name, COUNT(*) AS count FROM emails
    WHERE from_email != '' GROUP BY from_email
    ORDER BY count DESC, name ASC
  `).all() as { email: string; name: string; count: number }[];
  return rows;
}

export function createDraft(draft: {
  id: string;
  emailId?: string;
  threadId?: string;
  type: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  user: string;
}): DraftRow {
  db.prepare(`
    INSERT INTO drafts (id, email_id, thread_id, type, to_address, cc, subject, body, demo_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(draft.id, draft.emailId || null, draft.threadId || "", draft.type, draft.to, draft.cc || "", draft.subject, draft.body, draft.user);
  return getDraftById(draft.id)!;
}

export function getDraftById(id: string): DraftRow | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
}

/** A draft only when it belongs to `user` (per-visitor scoping). */
export function getOwnDraft(id: string, user: string): DraftRow | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id = ? AND demo_user = ?").get(id, user) as DraftRow | undefined;
}

export function getAllDrafts(user: string): DraftRow[] {
  return db.prepare("SELECT * FROM drafts WHERE status = 'draft' AND demo_user = ? ORDER BY updated_at DESC").all(user) as DraftRow[];
}

export function getSentDrafts(user: string): DraftRow[] {
  return db.prepare(
    `SELECT * FROM drafts WHERE status IN ('sent', 'pushed', 'scheduled') AND demo_user = ?
     ORDER BY COALESCE(sent_at, scheduled_at, updated_at) DESC`
  ).all(user) as DraftRow[];
}

export function updateDraft(id: string, patch: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string }): DraftRow | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.to !== undefined) { fields.push("to_address = ?"); values.push(patch.to); }
  if (patch.cc !== undefined) { fields.push("cc = ?"); values.push(patch.cc); }
  if (patch.bcc !== undefined) { fields.push("bcc = ?"); values.push(patch.bcc); }
  if (patch.subject !== undefined) { fields.push("subject = ?"); values.push(patch.subject); }
  if (patch.body !== undefined) { fields.push("body = ?"); values.push(patch.body); }
  if (fields.length === 0) return getDraftById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE drafts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getDraftById(id);
}

export function updateDraftStatus(id: string, status: string, gmailDraftId?: string) {
  if (gmailDraftId) {
    db.prepare("UPDATE drafts SET status = ?, gmail_draft_id = ?, updated_at = unixepoch() WHERE id = ?").run(status, gmailDraftId, id);
  } else {
    db.prepare("UPDATE drafts SET status = ?, updated_at = unixepoch() WHERE id = ?").run(status, id);
  }
}

export function deleteDraft(id: string) {
  db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
}

export function updateEmailThreadId(id: string, threadId: string) {
  db.prepare("UPDATE emails SET thread_id = ? WHERE id = ?").run(threadId, id);
}

/**
 * Re-sanitize all existing email plain-text bodies through the provided function.
 * Only touches `body`; `body_html` is rendered via react-letter, which runs its
 * own permissive sanitizer at display time.
 */
export function cleanExistingBodies(sanitizer: (raw: string) => string): number {
  // Fetch all rows first — better-sqlite3 can't UPDATE while iterating on same connection
  const rows = db.prepare("SELECT id, body FROM emails WHERE body != ''").all() as { id: string; body: string }[];
  const update = db.prepare("UPDATE emails SET body = ? WHERE id = ?");
  let cleaned = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      const result = sanitizer(row.body);
      if (result !== row.body) {
        update.run(result, row.id);
        cleaned++;
      }
    }
  });
  run();
  return cleaned;
}

// --- Email embedding + category_id ---

export function updateEmailEmbedding(id: string, embedding: Buffer) {
  db.prepare("UPDATE emails SET embedding = ? WHERE id = ?").run(embedding, id);
}

/** Cache the SetFit (task-tuned) embedding for an email. Used by Step 2a;
 *  separate from emails.embedding which is the generic MiniLM vector. */
export function updateWorkEmbedding(id: string, embedding: Buffer) {
  db.prepare("UPDATE emails SET work_embedding = ? WHERE id = ?").run(embedding, id);
}

/** Cache the SetFit 4-way classify embedding for an email. */
export function updateClassifyEmbedding(id: string, embedding: Buffer) {
  db.prepare("UPDATE emails SET classify_embedding = ? WHERE id = ?").run(embedding, id);
}

/** Pull labeled samples + cached SetFit-classify embedding for runtime
 *  warm-start retrain of the multi-class LR head. Same shape as
 *  getLabeledWorkSamples but multi-class. */
export function getLabeledClassifySamples(): Array<{
  email_id: string; category_id: string; source: string; classify_embedding: Buffer;
  from_email: string; list_unsubscribe: string; list_id: string; auto_submitted: string; precedence: string;
}> {
  return db.prepare(`
    SELECT ce.email_id, ce.category_id, ce.source, e.classify_embedding,
           e.from_email, e.list_unsubscribe, e.list_id, e.auto_submitted, e.precedence
    FROM category_examples ce JOIN emails e ON e.id = ce.email_id
    WHERE e.classify_embedding IS NOT NULL
      AND ce.category_id IN ('cat_primary','cat_track','cat_news','cat_junk')
  `).all() as Array<{
    email_id: string; category_id: string; source: string; classify_embedding: Buffer;
    from_email: string; list_unsubscribe: string; list_id: string; auto_submitted: string; precedence: string;
  }>;
}

/** Pull labeled samples + their cached SetFit embedding for retrain.
 *  Excludes rows where work_embedding is NULL (not yet encoded — the
 *  retrain caller should ensure prefetch has run since SetFit was
 *  enabled before invoking this). */
export function getLabeledWorkSamples(): Array<{
  email_id: string; label: number; source: string; work_embedding: Buffer;
}> {
  return db.prepare(`
    SELECT wl.email_id, wl.label, wl.source, e.work_embedding
    FROM work_labels wl JOIN emails e ON e.id = wl.email_id
    WHERE e.work_embedding IS NOT NULL
  `).all() as Array<{ email_id: string; label: number; source: string; work_embedding: Buffer }>;
}

export function setEmailCategoryId(id: string, categoryId: string | null) {
  db.prepare("UPDATE emails SET category_id = ?, classified_at = unixepoch() WHERE id = ?").run(categoryId, id);
}

export function setEmailPrimaryUntil(id: string, primaryUntil: number | null) {
  db.prepare("UPDATE emails SET primary_until = ? WHERE id = ?").run(primaryUntil, id);
}

// --- Categories (user-defined classification taxonomy) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Migrate: drop legacy is_focused column from existing installations.
try { db.exec("ALTER TABLE categories DROP COLUMN is_focused"); } catch {}

// Migrate: drop legacy vip_senders table.
try { db.exec("DROP TABLE IF EXISTS vip_senders"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS category_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    email_id TEXT,
    source TEXT NOT NULL,
    embedding BLOB NOT NULL,
    subject_preview TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(category_id, email_id)
  )
`);

// DEPRECATED 2026-05-08: legacy MiniLM centroid classifier was retired in favor
// of the SetFit 4-way head. Schema preserved (no SQLite drop) so historical
// data isn't lost; no code reads or writes this table anymore.
db.exec(`
  CREATE TABLE IF NOT EXISTS category_centroids (
    category_id TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
    centroid BLOB NOT NULL,
    example_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS eval_set (
    email_id TEXT PRIMARY KEY,
    gold_category_id TEXT NOT NULL REFERENCES categories(id),
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// DEPRECATED (also): frozen base-model centroids from the legacy MiniLM era.
// Schema preserved alongside category_centroids; no code reads it.
db.exec(`
  CREATE TABLE IF NOT EXISTS base_model_centroids (
    category_name TEXT NOT NULL,
    version TEXT NOT NULL,
    centroid BLOB NOT NULL,
    example_count INTEGER NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (category_name, version)
  )
`);

// Job-search triage (orthogonal to category_id — same email can be cat_primary AND a job thread).
// Only populated for emails that pass the heuristic + LLM detection in prefetch Step 3.
db.exec(`
  CREATE TABLE IF NOT EXISTS job_emails (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    needs_action INTEGER NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    deadline INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    is_user_corrected INTEGER NOT NULL DEFAULT 0,
    classified_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_job_emails_stage ON job_emails(stage)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_job_emails_company ON job_emails(company)"); } catch {}

// Migrate: optional metadata extracted from offer / interview emails.
try { db.exec("ALTER TABLE job_emails ADD COLUMN salary TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_emails ADD COLUMN location TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_emails ADD COLUMN remote_mode TEXT NOT NULL DEFAULT ''"); } catch {} // remote/hybrid/onsite/''
try { db.exec("ALTER TABLE job_emails ADD COLUMN visa_note TEXT NOT NULL DEFAULT ''"); } catch {}

// Migrate: link each job email to an application (aggregation across emails).
try { db.exec("ALTER TABLE job_emails ADD COLUMN application_id TEXT REFERENCES applications(id) ON DELETE SET NULL"); } catch {}

// Applications — the unit of "one job-search effort": same company + role aggregated
// across multiple emails / threads. Created lazily during job triage.
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,             -- normalized for matching
    role TEXT NOT NULL DEFAULT '',     -- normalized
    company_display TEXT NOT NULL,
    role_display TEXT NOT NULL DEFAULT '',
    current_stage TEXT NOT NULL DEFAULT 'applied',
    current_priority TEXT NOT NULL DEFAULT 'medium',
    current_summary TEXT NOT NULL DEFAULT '',
    current_deadline INTEGER,
    needs_action INTEGER NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL DEFAULT '',
    salary TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    remote_mode TEXT NOT NULL DEFAULT '',
    visa_note TEXT NOT NULL DEFAULT '',
    is_user_corrected INTEGER NOT NULL DEFAULT 0,
    first_email_at INTEGER NOT NULL DEFAULT 0,
    latest_email_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_norm ON applications(company, role)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_applications_stage ON applications(current_stage)"); } catch {}

// Job-search gold labels for offline regression eval.
db.exec(`
  CREATE TABLE IF NOT EXISTS job_eval_set (
    email_id TEXT PRIMARY KEY,
    gold_is_job INTEGER NOT NULL,
    gold_stage TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Track user corrections to feed back as LLM few-shot examples.
db.exec(`
  CREATE TABLE IF NOT EXISTS job_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL,
    from_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    ml_stage TEXT NOT NULL DEFAULT '',
    user_stage TEXT NOT NULL DEFAULT '',
    ml_company TEXT NOT NULL DEFAULT '',
    user_company TEXT NOT NULL DEFAULT '',
    correction_kind TEXT NOT NULL DEFAULT 'stage', -- 'stage' | 'remove' | 'company'
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Generic key/value state (base_model_version, onboarding_completed, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Migrate: link categories to their base-model fallback (nullable).
try { db.exec("ALTER TABLE categories ADD COLUMN base_fallback_name TEXT"); } catch {}

// Jobs pipeline: sender-domain fast-path for application matching.
// Many-to-many: one application may bind multiple domains (acquired company,
// recruiter forwarding), one domain may appear across multiple applications
// (big employers post many roles) — Step 2B only fast-paths on unique hits.
db.exec(`
  CREATE TABLE IF NOT EXISTS application_domains (
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (application_id, domain)
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_application_domains_domain ON application_domains(domain)"); } catch {}

// Jobs pipeline: remember which maybe_work emails were already LLM-judged
// is_job=false, so we don't re-pay the token cost on every prefetch.
db.exec(`
  CREATE TABLE IF NOT EXISTS job_skipped (
    email_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    skipped_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Binary labels for the work-classifier (logistic regression on MiniLM embeddings).
// source = 'llm_bootstrap' (initial Sonnet batch) | 'user_correction' (Inbox right-click "Classify as Job related" / jobs board remove)
// label = 1 (work-related) | 0 (not)
db.exec(`
  CREATE TABLE IF NOT EXISTS work_labels (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    label INTEGER NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

export interface CategoryRow {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  is_default: number;
  sort_order: number;
  base_fallback_name: string | null;
  created_at: number;
}

export interface CategoryExampleRow {
  id: number;
  category_id: string;
  email_id: string | null;
  source: string;
  embedding: Buffer;
  subject_preview: string;
  created_at: number;
}

export function upsertCategory(cat: {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  is_default?: boolean;
  sort_order?: number;
  base_fallback_name?: string | null;
}): CategoryRow {
  db.prepare(`
    INSERT INTO categories (id, name, description, color, icon, is_default, sort_order, base_fallback_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      color = excluded.color,
      icon = excluded.icon,
      sort_order = excluded.sort_order,
      base_fallback_name = excluded.base_fallback_name
  `).run(
    cat.id,
    cat.name,
    cat.description || "",
    cat.color || "",
    cat.icon || "",
    cat.is_default ? 1 : 0,
    cat.sort_order ?? 100,
    cat.base_fallback_name ?? null
  );
  return getCategoryById(cat.id)!;
}

export function listCategories(): CategoryRow[] {
  return db.prepare("SELECT * FROM categories ORDER BY sort_order ASC, name ASC").all() as CategoryRow[];
}

export function getCategoryById(id: string): CategoryRow | undefined {
  return db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
}

export function getCategoryByName(name: string): CategoryRow | undefined {
  return db.prepare("SELECT * FROM categories WHERE name = ?").get(name) as CategoryRow | undefined;
}

export function deleteCategory(id: string) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE emails SET category_id = NULL WHERE category_id = ?").run(id);
    db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    // category_examples and category_centroids cascade on delete
  });
  tx();
}

export function addCategoryExample(args: {
  categoryId: string;
  emailId: string | null;
  source: string;
  embedding: Buffer;
  subjectPreview?: string;
}): CategoryExampleRow {
  db.prepare(`
    INSERT INTO category_examples (category_id, email_id, source, embedding, subject_preview)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(category_id, email_id) DO UPDATE SET
      embedding = excluded.embedding,
      source = excluded.source,
      subject_preview = excluded.subject_preview
  `).run(args.categoryId, args.emailId, args.source, args.embedding, args.subjectPreview || "");
  return db.prepare(
    "SELECT * FROM category_examples WHERE category_id = ? AND (email_id = ? OR (email_id IS NULL AND ? IS NULL)) ORDER BY id DESC LIMIT 1"
  ).get(args.categoryId, args.emailId, args.emailId) as CategoryExampleRow;
}

export function addCategoryExamplesBulk(rows: {
  categoryId: string;
  emailId: string | null;
  source: string;
  embedding: Buffer;
  subjectPreview: string;
}[]): number {
  const stmt = db.prepare(`
    INSERT INTO category_examples (category_id, email_id, source, embedding, subject_preview)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(category_id, email_id) DO NOTHING
  `);
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const result = stmt.run(r.categoryId, r.emailId, r.source, r.embedding, r.subjectPreview);
      if (result.changes > 0) inserted++;
    }
  });
  tx();
  return inserted;
}

export function listExamplesByCategory(categoryId: string): CategoryExampleRow[] {
  return db.prepare("SELECT * FROM category_examples WHERE category_id = ? ORDER BY id DESC").all(categoryId) as CategoryExampleRow[];
}

export function countExamplesByCategory(categoryId: string): number {
  return (db.prepare("SELECT COUNT(*) as c FROM category_examples WHERE category_id = ?").get(categoryId) as { c: number }).c;
}

/** Count category_examples whose email row exists. Excludes synthetic rows
 *  like spam_corpus (no real email_id). Used by warm-start invariant check —
 *  if `getLabeledClassifySamples().length` falls far below this, the head is
 *  training on a subset due to missing classify_embedding cache. See §24. */
export function countTrainableCategoryExamples(): number {
  return (db.prepare(`
    SELECT COUNT(*) AS c
    FROM category_examples ce JOIN emails e ON e.id = ce.email_id
    WHERE ce.category_id IN ('cat_primary','cat_track','cat_news','cat_junk')
  `).get() as { c: number }).c;
}

/** List category_example rows whose email row exists but classify_embedding
 *  is NULL — orphans from pre-SetFit-ship arrivals (before 2026-05-07).
 *  Returned rows are ready to feed back through embedTextForClassify +
 *  updateClassifyEmbedding to expand the warm-start trainable set. */
export function listOrphanedClassifyExamples(limit: number = 1000): Array<{
  email_id: string; from_name: string; from_email: string; subject: string; snippet: string;
}> {
  return db.prepare(`
    SELECT e.id AS email_id, e.from_name, e.from_email, e.subject, e.snippet
    FROM category_examples ce JOIN emails e ON e.id = ce.email_id
    WHERE e.classify_embedding IS NULL
      AND ce.category_id IN ('cat_primary','cat_track','cat_news','cat_junk')
    ORDER BY e.received_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    email_id: string; from_name: string; from_email: string; subject: string; snippet: string;
  }>;
}

export function deleteCategoryExample(id: number) {
  db.prepare("DELETE FROM category_examples WHERE id = ?").run(id);
}

/** Remove a specific (category_id, email_id) pair from category_examples.
 * Used by user-correction feedback to wipe the email's influence on the
 * OLD category's centroid. Returns rows deleted. Skip if user_correction-
 * pinned there (shouldn't happen since user is now moving it elsewhere,
 * but guard against overzealous cleanup). */
export function removeEmailExampleFromCategory(categoryId: string, emailId: string): number {
  const res = db.prepare(
    "DELETE FROM category_examples WHERE category_id = ? AND email_id = ?"
  ).run(categoryId, emailId);
  return res.changes;
}

// --- Eval set (gold-labeled test emails) ---

export function addEvalLabel(emailId: string, goldCategoryId: string) {
  db.prepare(`
    INSERT INTO eval_set (email_id, gold_category_id, added_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(email_id) DO UPDATE SET gold_category_id = excluded.gold_category_id, added_at = unixepoch()
  `).run(emailId, goldCategoryId);
}

export function listEvalSet(): { email_id: string; gold_category_id: string }[] {
  return db.prepare("SELECT email_id, gold_category_id FROM eval_set").all() as { email_id: string; gold_category_id: string }[];
}

export function removeEvalLabel(emailId: string) {
  db.prepare("DELETE FROM eval_set WHERE email_id = ?").run(emailId);
}

// --- App state (key/value) ---

export function getAppState(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppState(key: string, value: string) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(key, value);
}

// --- Default category seeds ---
// 4 buckets with active-level implied by name (Primary > Track > News > Junk):
//   Primary — real human, or time-sensitive action-required email
//   Track   — events generated FOR YOU: receipts, shipping, grades, confirmations,
//             verification codes, appointments. Things worth keeping an eye on.
//   News    — subscribed / broadcast content streams you consume passively:
//             newsletters, digests, platform announcements, news feeds.
//   Junk    — marketing + spam merged. Auto-prunes after 30 days.
const DEFAULT_CATEGORIES: Array<Parameters<typeof upsertCategory>[0]> = [
  { id: "cat_primary", name: "Primary", description: "Needs your attention: direct human communication, things you must do, time-sensitive items",                                       icon: "Mail",      is_default: true, sort_order: 10, base_fallback_name: null },
  { id: "cat_track",   name: "Track",   description: "Personal events worth tracking: order and shipping updates, application receipts, grades, appointment confirmations, receipts",     icon: "ListChecks", is_default: true, sort_order: 20, base_fallback_name: "track" },
  { id: "cat_news",    name: "News",    description: "Subscribed streams and broadcast content: newsletters, digests, news feeds, platform-wide announcements",                            icon: "Newspaper", is_default: true, sort_order: 30, base_fallback_name: "news" },
  { id: "cat_junk",    name: "Junk",    description: "Marketing, promotions, and spam. Auto-prunes after 30 days.",                                                                        icon: "Trash2",    is_default: true, sort_order: 40, base_fallback_name: "junk" },
];

// Seed default categories on startup if table is empty
const existingCount = (db.prepare("SELECT COUNT(*) as c FROM categories").get() as { c: number }).c;
if (existingCount === 0) {
  const tx = db.transaction(() => {
    for (const c of DEFAULT_CATEGORIES) upsertCategory(c);
  });
  tx();
  console.log(`[db] Seeded ${DEFAULT_CATEGORIES.length} default categories`);
} else {
  // Backfill base_fallback_name for existing default categories that are missing it
  const backfill = db.prepare(
    "UPDATE categories SET base_fallback_name = ? WHERE id = ? AND base_fallback_name IS NULL"
  );
  const tx = db.transaction(() => {
    for (const c of DEFAULT_CATEGORIES) {
      if (c.base_fallback_name) backfill.run(c.base_fallback_name, c.id);
    }
  });
  tx();
}

export { DEFAULT_CATEGORIES };

// --- Job emails (job-search triage) ---

export interface JobEmailRow {
  email_id: string;
  stage: string;
  needs_action: number;
  action_type: string;
  priority: string;
  deadline: number | null;
  summary: string;
  company: string;
  role: string;
  is_user_corrected: number;
  classified_at: number;
  salary: string;
  location: string;
  remote_mode: string;
  visa_note: string;
  application_id: string | null;
}

export interface ApplicationRow {
  id: string;
  company: string;
  role: string;
  company_display: string;
  role_display: string;
  current_stage: string;
  current_priority: string;
  current_summary: string;
  current_deadline: number | null;
  needs_action: number;
  action_type: string;
  salary: string;
  location: string;
  remote_mode: string;
  visa_note: string;
  is_user_corrected: number;
  first_email_at: number;
  latest_email_at: number;
  created_at: number;
  updated_at: number;
}

export function upsertJobEmail(row: {
  emailId: string;
  stage: string;
  needsAction: boolean;
  actionType?: string;
  priority?: string;
  deadline?: number | null;
  summary?: string;
  company?: string;
  role?: string;
  salary?: string;
  location?: string;
  remoteMode?: string;
  visaNote?: string;
}) {
  // Skip if user already corrected — never overwrite manual edits.
  const cur = db.prepare("SELECT is_user_corrected FROM job_emails WHERE email_id = ?").get(row.emailId) as { is_user_corrected: number } | undefined;
  if (cur && cur.is_user_corrected === 1) return;
  db.prepare(`
    INSERT INTO job_emails (email_id, stage, needs_action, action_type, priority, deadline, summary, company, role, salary, location, remote_mode, visa_note, classified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(email_id) DO UPDATE SET
      stage = excluded.stage,
      needs_action = excluded.needs_action,
      action_type = excluded.action_type,
      priority = excluded.priority,
      deadline = excluded.deadline,
      summary = excluded.summary,
      company = excluded.company,
      role = excluded.role,
      salary = CASE WHEN excluded.salary = '' THEN job_emails.salary ELSE excluded.salary END,
      location = CASE WHEN excluded.location = '' THEN job_emails.location ELSE excluded.location END,
      remote_mode = CASE WHEN excluded.remote_mode = '' THEN job_emails.remote_mode ELSE excluded.remote_mode END,
      visa_note = CASE WHEN excluded.visa_note = '' THEN job_emails.visa_note ELSE excluded.visa_note END,
      classified_at = unixepoch()
  `).run(
    row.emailId,
    row.stage,
    row.needsAction ? 1 : 0,
    row.actionType || "",
    row.priority || "medium",
    row.deadline ?? null,
    row.summary || "",
    row.company || "",
    row.role || "",
    row.salary || "",
    row.location || "",
    row.remoteMode || "",
    row.visaNote || "",
  );
}

export function getJobEmail(emailId: string): JobEmailRow | undefined {
  return db.prepare("SELECT * FROM job_emails WHERE email_id = ?").get(emailId) as JobEmailRow | undefined;
}

export function setJobEmailApplicationId(emailId: string, applicationId: string | null) {
  db.prepare("UPDATE job_emails SET application_id = ? WHERE email_id = ?").run(applicationId, emailId);
}

export function listJobEmails(): JobEmailRow[] {
  return db.prepare("SELECT * FROM job_emails ORDER BY classified_at DESC").all() as JobEmailRow[];
}

export function removeJobEmail(emailId: string) {
  db.prepare("DELETE FROM job_emails WHERE email_id = ?").run(emailId);
}

export function updateJobEmailStage(emailId: string, patch: {
  stage?: string;
  needsAction?: boolean;
  actionType?: string;
  priority?: string;
  company?: string;
  role?: string;
}) {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.stage !== undefined) { fields.push("stage = ?"); values.push(patch.stage); }
  if (patch.needsAction !== undefined) { fields.push("needs_action = ?"); values.push(patch.needsAction ? 1 : 0); }
  if (patch.actionType !== undefined) { fields.push("action_type = ?"); values.push(patch.actionType); }
  if (patch.priority !== undefined) { fields.push("priority = ?"); values.push(patch.priority); }
  if (patch.company !== undefined) { fields.push("company = ?"); values.push(patch.company); }
  if (patch.role !== undefined) { fields.push("role = ?"); values.push(patch.role); }
  if (fields.length === 0) return;
  fields.push("is_user_corrected = 1");
  values.push(emailId);
  db.prepare(`UPDATE job_emails SET ${fields.join(", ")} WHERE email_id = ?`).run(...values);
}

export interface JobCorrectionRow {
  id: number;
  email_id: string;
  from_email: string;
  subject: string;
  ml_stage: string;
  user_stage: string;
  ml_company: string;
  user_company: string;
  correction_kind: string;
  created_at: number;
}

export function insertJobCorrection(row: {
  emailId: string;
  fromEmail?: string;
  subject?: string;
  mlStage?: string;
  userStage?: string;
  mlCompany?: string;
  userCompany?: string;
  kind: "stage" | "remove" | "company";
}) {
  db.prepare(`
    INSERT INTO job_corrections (email_id, from_email, subject, ml_stage, user_stage, ml_company, user_company, correction_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.emailId,
    row.fromEmail || "",
    row.subject || "",
    row.mlStage || "",
    row.userStage || "",
    row.mlCompany || "",
    row.userCompany || "",
    row.kind,
  );
}

export function getRecentJobCorrections(limit = 8): JobCorrectionRow[] {
  return db.prepare(
    "SELECT * FROM job_corrections ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as JobCorrectionRow[];
}

// --- Job eval set ---

export interface JobEvalRow {
  email_id: string;
  gold_is_job: number;
  gold_stage: string;
  added_at: number;
}

export function addJobEvalLabel(emailId: string, isJob: boolean, stage = "") {
  db.prepare(`
    INSERT INTO job_eval_set (email_id, gold_is_job, gold_stage, added_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(email_id) DO UPDATE SET gold_is_job = excluded.gold_is_job, gold_stage = excluded.gold_stage, added_at = unixepoch()
  `).run(emailId, isJob ? 1 : 0, stage);
}

export function listJobEvalSet(): JobEvalRow[] {
  return db.prepare("SELECT * FROM job_eval_set").all() as JobEvalRow[];
}

export function removeJobEvalLabel(emailId: string) {
  db.prepare("DELETE FROM job_eval_set WHERE email_id = ?").run(emailId);
}

/** Return only emails that are NOT yet in job_emails AND not user-marked-not-job. */
export function getJobCandidatesNotYetClassified(emailIds: string[]): EmailRow[] {
  if (emailIds.length === 0) return [];
  const placeholders = emailIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM emails WHERE id IN (${placeholders}) AND id NOT IN (SELECT email_id FROM job_emails)`
  ).all(...emailIds) as EmailRow[];
}

// --- maybe_work tag (Jobs ingress) ---

export function setMaybeWork(emailId: string, flag: boolean) {
  db.prepare("UPDATE emails SET maybe_work = ? WHERE id = ?").run(flag ? 1 : 0, emailId);
}

/**
 * Thread IDs with at least one email already in job_emails. Used by prefetch
 * Step 2a as an L1.5 hard shortcut: if an incoming email's thread is already
 * tracked in Jobs, force maybe_work=1 without consulting the work-classifier.
 * Near-zero false positive (Gmail thread_id is deterministic), big recall win
 * for thread continuations (reject after interview scheduled, etc).
 */
export function listJobThreadIds(): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT e.thread_id AS thread_id
     FROM job_emails je JOIN emails e ON je.email_id = e.id
     WHERE e.thread_id != ''`
  ).all() as { thread_id: string }[];
  return new Set(rows.map((r) => r.thread_id));
}

export function getMaybeWorkEmails(): EmailRow[] {
  return db.prepare(
    `SELECT * FROM emails
     WHERE maybe_work = 1
       AND id NOT IN (SELECT email_id FROM job_emails)
       AND id NOT IN (SELECT email_id FROM job_skipped)
     ORDER BY received_at DESC`
  ).all() as EmailRow[];
}

// --- application_domains (sender-domain fast-path) ---

export function addApplicationDomain(applicationId: string, domain: string) {
  if (!domain) return;
  db.prepare(
    "INSERT OR IGNORE INTO application_domains (application_id, domain) VALUES (?, ?)"
  ).run(applicationId, domain.toLowerCase());
}

export function findApplicationsByDomain(domain: string): string[] {
  if (!domain) return [];
  return (db.prepare(
    "SELECT application_id FROM application_domains WHERE domain = ?"
  ).all(domain.toLowerCase()) as { application_id: string }[]).map((r) => r.application_id);
}

// --- job_skipped (cache is_job=false so we don't re-pay LLM) ---

export function markJobSkipped(emailId: string, reason: string) {
  db.prepare(
    `INSERT OR REPLACE INTO job_skipped (email_id, reason, skipped_at)
     VALUES (?, ?, unixepoch())`
  ).run(emailId, reason || "");
}

export function clearJobSkipped(emailId: string) {
  db.prepare("DELETE FROM job_skipped WHERE email_id = ?").run(emailId);
}

export function isJobSkipped(emailId: string): boolean {
  const r = db.prepare("SELECT 1 FROM job_skipped WHERE email_id = ?").get(emailId);
  return !!r;
}

// --- work_labels (training corpus for the work classifier) ---

export function upsertWorkLabel(emailId: string, label: 0 | 1, source: string) {
  db.prepare(`
    INSERT INTO work_labels (email_id, label, source, created_at, updated_at)
    VALUES (?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(email_id) DO UPDATE SET
      label = excluded.label,
      source = excluded.source,
      updated_at = unixepoch()
  `).run(emailId, label, source);
}

export interface WorkLabelRow {
  email_id: string;
  label: number;
  source: string;
  created_at: number;
  updated_at: number;
}

export function listWorkLabels(): WorkLabelRow[] {
  return db.prepare("SELECT * FROM work_labels ORDER BY created_at ASC").all() as WorkLabelRow[];
}

export function getLabeledEmailsWithEmbeddings(): Array<{ id: string; label: number; source: string; embedding: Buffer }> {
  return db.prepare(`
    SELECT wl.email_id AS id, wl.label, wl.source, e.embedding
    FROM work_labels wl
    JOIN emails e ON e.id = wl.email_id
    WHERE e.embedding IS NOT NULL
  `).all() as Array<{ id: string; label: number; source: string; embedding: Buffer }>;
}

export function countWorkLabels(): { total: number; positive: number; negative: number } {
  const row = db.prepare(
    "SELECT COUNT(*) c, SUM(label) p FROM work_labels"
  ).get() as { c: number; p: number | null };
  return { total: row.c, positive: row.p ?? 0, negative: row.c - (row.p ?? 0) };
}

// ── Calendar events table ──────────────────────────────────────────
// LLM-extracted events from emails: interview slots, deadlines,
// office hours, RSVPs. Feeds the /calendar view. Orthogonal to TTL
// rules (ttl-rules.ts) which only cover Primary upgrades.
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER,
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT NOT NULL DEFAULT '',
    rsvp_by INTEGER,
    source_start INTEGER,
    source_end INTEGER,
    hash TEXT NOT NULL,
    extracted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(email_id, hash)
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ts)"); } catch {}

export interface EventRow {
  id: string;
  email_id: string;
  title: string;
  start_ts: number;
  end_ts: number | null;
  all_day: number;
  location: string;
  rsvp_by: number | null;
  source_start: number | null;
  source_end: number | null;
  hash: string;
  extracted_at: number;
}

export function upsertEvent(ev: Omit<EventRow, "extracted_at">): void {
  db.prepare(
    `INSERT INTO events (id, email_id, title, start_ts, end_ts, all_day, location, rsvp_by, source_start, source_end, hash, extracted_at)
     VALUES (@id, @email_id, @title, @start_ts, @end_ts, @all_day, @location, @rsvp_by, @source_start, @source_end, @hash, unixepoch())
     ON CONFLICT(email_id, hash) DO UPDATE SET
       title = excluded.title,
       start_ts = excluded.start_ts,
       end_ts = excluded.end_ts,
       location = excluded.location,
       rsvp_by = excluded.rsvp_by`
  ).run(ev);
}

export function listEventsInRange(startTs: number, endTs: number): EventRow[] {
  return db.prepare(
    "SELECT * FROM events WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts ASC"
  ).all(startTs, endTs) as EventRow[];
}

export function listUpcomingEvents(fromTs: number, limit = 50): EventRow[] {
  return db.prepare(
    "SELECT * FROM events WHERE start_ts >= ? ORDER BY start_ts ASC LIMIT ?"
  ).all(fromTs, limit) as EventRow[];
}

export function getEventById(id: string): EventRow | undefined {
  return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
}

/**
 * Cross-email event dedup lookup.
 *
 * Why: `upsertEvent` ON CONFLICT uses `(email_id, hash)` which only dedups
 * inside the same email. A 5-email thread where each reply quotes a scheduled
 * meeting ends up writing 5 rows for the same real-world event. The caller
 * (event-extractor) should compute a normalized key (normalized title +
 * start-day + normalized location) and query this function before upserting.
 *
 * Scope: last 60 days. Far-past events shouldn't absorb a new duplicate from
 * an unrelated new email that happens to produce the same normalized key.
 * Scan-in-JS is fine — events table is small (tens to low hundreds of rows).
 */
export function findEventByNormalizedKey(
  predicate: (row: EventRow) => boolean,
  windowSec = 60 * 86400,
): EventRow | undefined {
  const rows = db.prepare(
    `SELECT * FROM events
     WHERE extracted_at > unixepoch() - ?
     ORDER BY extracted_at ASC`
  ).all(windowSec) as EventRow[];
  return rows.find(predicate);
}

/** Patch specific columns on an existing event row. Only non-undefined fields
 *  in `patch` are written. Used by cross-email dedup to merge a later email's
 *  better location/end_ts into the earlier row without overwriting good data. */
export function updateEventFields(
  id: string,
  patch: Partial<Pick<EventRow, "title" | "end_ts" | "location" | "rsvp_by">>,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.title !== undefined) { sets.push("title = @title"); params.title = patch.title; }
  if (patch.end_ts !== undefined) { sets.push("end_ts = @end_ts"); params.end_ts = patch.end_ts; }
  if (patch.location !== undefined) { sets.push("location = @location"); params.location = patch.location; }
  if (patch.rsvp_by !== undefined) { sets.push("rsvp_by = @rsvp_by"); params.rsvp_by = patch.rsvp_by; }
  if (sets.length === 0) return;
  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function deleteEvent(id: string): void {
  db.prepare("DELETE FROM events WHERE id = ?").run(id);
}

export function hasEventsForEmail(emailId: string): boolean {
  const row = db.prepare("SELECT 1 FROM events WHERE email_id = ? LIMIT 1").get(emailId) as unknown;
  return row != null;
}

export function listEmailsNeedingEventExtraction(limit = 50): EmailRow[] {
  // Architecture invariant: event_extractor LLM must NEVER see cat_news or
  // cat_junk. News = broadcast stream, Junk = marketing spam — neither
  // produces schedulable calendar events, and running LLM on them burns
  // tokens for guaranteed `[]` returns.
  //
  // Scope: primary + track, last 90 days, with body, no existing event row.
  // The prior `OR legacy category IN (...)` branch was dead code — by this
  // point all emails carry a `category_id` (verified: 0 NULLs on inspected
  // corpora), so the legacy fallback never fired. Removing it makes the
  // scope gate unambiguous.
  //
  // The JS-layer `.filter(hasTimeSignal)` after the query cuts ~50% of
  // calls that would return empty from LLM anyway (no date/time mention).
  // Deliberately not pushed into SQL — SQLite regex is awkward and the
  // candidate pool is small (<200 rows for 90-day primary/track).
  const rows = db.prepare(
    `SELECT e.* FROM emails e
     WHERE e.body != ''
       AND e.received_at > unixepoch() - 90*86400
       AND e.category_id IN ('cat_primary','cat_track')
       AND NOT EXISTS (SELECT 1 FROM events ev WHERE ev.email_id = e.id)
     ORDER BY e.received_at DESC
     LIMIT ?`
  ).all(limit * 2) as EmailRow[]; // fetch extra to survive filter attrition

  return rows
    .filter((r) => hasTimeSignal({ subject: r.subject, body: r.body }))
    .slice(0, limit);
}

// ── Email chunks (Ask AI RAG: chunked embedding) ──────────────────
// Orthogonal to `emails.embedding` (single vector used by Inbox
// MiniLM classifier). This table powers /ask retrieval — long emails
// are split into ~400-char chunks so event info / intent-bearing
// sentences don't get diluted by marketing boilerplate + URL noise.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_chunks (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    chunk_idx INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    UNIQUE(email_id, chunk_idx)
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_email ON email_chunks(email_id)"); } catch {}

export interface EmailChunkRow {
  id: string;
  email_id: string;
  chunk_idx: number;
  chunk_text: string;
  embedding: Buffer;
}

export function upsertChunk(chunk: { email_id: string; chunk_idx: number; chunk_text: string; embedding: Buffer }): void {
  const id = `${chunk.email_id}_${chunk.chunk_idx}`;
  db.prepare(
    `INSERT INTO email_chunks (id, email_id, chunk_idx, chunk_text, embedding)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email_id, chunk_idx) DO UPDATE SET
       chunk_text = excluded.chunk_text,
       embedding = excluded.embedding`
  ).run(id, chunk.email_id, chunk.chunk_idx, chunk.chunk_text, chunk.embedding);
}

/** Replace all chunks for an email atomically (used when re-chunking). */
export const replaceChunksForEmail = db.transaction((emailId: string, chunks: Array<{ chunk_idx: number; chunk_text: string; embedding: Buffer }>) => {
  db.prepare("DELETE FROM email_chunks WHERE email_id = ?").run(emailId);
  const ins = db.prepare(
    `INSERT INTO email_chunks (id, email_id, chunk_idx, chunk_text, embedding) VALUES (?, ?, ?, ?, ?)`
  );
  for (const c of chunks) {
    ins.run(`${emailId}_${c.chunk_idx}`, emailId, c.chunk_idx, c.chunk_text, c.embedding);
  }
});

export function listChunksForEmail(emailId: string): EmailChunkRow[] {
  return db.prepare("SELECT * FROM email_chunks WHERE email_id = ? ORDER BY chunk_idx ASC").all(emailId) as EmailChunkRow[];
}

export function deleteChunksForEmail(emailId: string): void {
  db.prepare("DELETE FROM email_chunks WHERE email_id = ?").run(emailId);
}

export function countChunks(): number {
  return (db.prepare("SELECT COUNT(*) c FROM email_chunks").get() as { c: number }).c;
}

export function hasChunks(emailId: string): boolean {
  const row = db.prepare("SELECT 1 FROM email_chunks WHERE email_id = ? LIMIT 1").get(emailId) as unknown;
  return row != null;
}

/** Stream ALL chunks with their embeddings for the retrieval pool. */
export function listAllChunks(windowDays: number, maxEmails: number): Array<EmailChunkRow & { received_at: number; subject: string; from_name: string; from_email: string; date: string; category_id: string | null; is_unread: number; primary_until: number | null; classifier: string }> {
  return db.prepare(`
    SELECT c.*, e.received_at, e.subject, e.from_name, e.from_email, e.date,
           e.category_id, e.is_unread, e.primary_until, e.classifier
      FROM email_chunks c
      JOIN emails e ON e.id = c.email_id
     WHERE e.body != ''
       AND e.received_at > unixepoch() - ?*86400
       AND (e.category_id != 'cat_junk' OR e.category_id IS NULL)
     ORDER BY e.received_at DESC
     LIMIT ?
  `).all(windowDays, maxEmails * 6) as Array<EmailChunkRow & { received_at: number; subject: string; from_name: string; from_email: string; date: string; category_id: string | null; is_unread: number; primary_until: number | null; classifier: string }>;
}

export function listEmailsNeedingChunks(limit = 200): EmailRow[] {
  return db.prepare(
    `SELECT e.* FROM emails e
     WHERE e.body != ''
       AND NOT EXISTS (SELECT 1 FROM email_chunks c WHERE c.email_id = e.id)
     ORDER BY e.received_at DESC
     LIMIT ?`
  ).all(limit) as EmailRow[];
}

// ── Ask AI conversations ─────────────────────────────────────────────
// Stored per visitor (`demo_user` = the gateway's X-Demo-User; always
// 'owner' outside DEMO_MODE). `conversations` is the history list;
// `conversation_messages` holds the user / assistant text turns shown when
// a conversation is reopened. The Claude CLI's own session file is only used
// for `--resume` context and is never read back by the app.
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    sid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
try { db.exec("ALTER TABLE conversations ADD COLUMN demo_user TEXT NOT NULL DEFAULT 'owner'"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(demo_user, updated_at DESC)"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid TEXT NOT NULL REFERENCES conversations(sid) ON DELETE CASCADE,
    demo_user TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_conv_messages_sid ON conversation_messages(sid, id)"); } catch {}

export interface ConversationRow {
  sid: string;
  title: string;
  created_at: number;
  updated_at: number;
  demo_user: string;
}

export interface ConversationMessageRow {
  id: number;
  sid: string;
  role: "user" | "assistant";
  text: string;
  created_at: number;
}

/** Record one finished Ask AI turn. Title is set once from the first user
 *  message and never overwritten — stable list labels. A sid that already
 *  belongs to another visitor is left untouched. */
export const saveConversationTurn = db.transaction((t: { sid: string; user: string; prompt: string; answer: string }) => {
  const title = t.prompt.slice(0, 60).replace(/\s+/g, " ").trim() || "Untitled";
  db.prepare(
    `INSERT INTO conversations (sid, title, demo_user) VALUES (?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET updated_at = unixepoch() WHERE conversations.demo_user = excluded.demo_user`
  ).run(t.sid, title, t.user);
  const owner = getConversation(t.sid, t.user);
  if (!owner) return;
  const ins = db.prepare("INSERT INTO conversation_messages (sid, demo_user, role, text) VALUES (?, ?, ?, ?)");
  ins.run(t.sid, t.user, "user", t.prompt);
  if (t.answer.trim()) ins.run(t.sid, t.user, "assistant", t.answer);
});

export function getConversation(sid: string, user: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE sid = ? AND demo_user = ?").get(sid, user) as ConversationRow | undefined;
}

export function listConversations(user: string, limit = 50): ConversationRow[] {
  return db.prepare(
    `SELECT * FROM conversations WHERE demo_user = ? ORDER BY updated_at DESC LIMIT ?`
  ).all(user, limit) as ConversationRow[];
}

export function listConversationMessages(sid: string, user: string): ConversationMessageRow[] {
  return db.prepare(
    `SELECT id, sid, role, text, created_at FROM conversation_messages
     WHERE sid = ? AND demo_user = ? ORDER BY id ASC`
  ).all(sid, user) as ConversationMessageRow[];
}

/** Returns true when a row owned by `user` was removed. */
export function deleteConversation(sid: string, user: string): boolean {
  db.prepare("DELETE FROM conversation_messages WHERE sid = ? AND demo_user = ?").run(sid, user);
  return db.prepare("DELETE FROM conversations WHERE sid = ? AND demo_user = ?").run(sid, user).changes > 0;
}

// ── Push subscriptions (Web Push / VAPID) ────────────────────────
// One row per browser (more precisely per pushManager.subscribe() result).
// `endpoint` is the unique key — the URL the push gateway routes to.
// 410 from the gateway means the subscription is gone (user revoked / cleared
// data); the row must be deleted (lib/push.ts handles this).
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_error TEXT NOT NULL DEFAULT '',
    last_error_at INTEGER
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_push_subs_created ON push_subscriptions(created_at DESC)"); } catch {}

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
  last_error: string;
  last_error_at: number | null;
}

export function addPushSubscription(input: { endpoint: string; p256dh: string; auth: string; userAgent?: string }): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       last_seen_at = unixepoch(),
       last_error = '',
       last_error_at = NULL`
  ).run(input.endpoint, input.p256dh, input.auth, input.userAgent || "");
}

export function listPushSubscriptions(): PushSubscriptionRow[] {
  return db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC").all() as PushSubscriptionRow[];
}

export function countPushSubscriptions(): number {
  return (db.prepare("SELECT COUNT(*) c FROM push_subscriptions").get() as { c: number }).c;
}

export function deletePushSubscriptionByEndpoint(endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function recordPushFailure(endpoint: string, error: string): void {
  db.prepare(
    `UPDATE push_subscriptions SET last_error = ?, last_error_at = unixepoch() WHERE endpoint = ?`
  ).run(error.slice(0, 300), endpoint);
}

export function bumpPushLastSeen(endpoint: string): void {
  db.prepare(
    `UPDATE push_subscriptions SET last_seen_at = unixepoch(), last_error = '', last_error_at = NULL WHERE endpoint = ?`
  ).run(endpoint);
}

export default db;
