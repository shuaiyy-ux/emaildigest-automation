/**
 * Sender-level behavioral + structural features for the Inbox classifier.
 *
 * Inspired by Gmail Priority Inbox (Aberdeen & Pacovsky 2010): the most
 * important classification signals are not in the email body — they are in
 * the sender's interaction history with the user, and in mail-protocol
 * headers (List-Unsubscribe / List-Id / Auto-Submitted / Precedence).
 *
 * We compute a 10-dim feature vector per email that gets concatenated with
 * the SetFit 384-d content embedding to form the 394-d input to the LR head.
 * See classify-embedder.ts CLASSIFY_INPUT_DIM.
 *
 * Indices are FROZEN — reordering breaks all trained heads. To add a feature,
 * append at the end and bump CLASSIFY_INPUT_DIM (which triggers retrain).
 *
 *   [0]  sender_read_rate_30d   ∈ [0,1]   ← fraction of this sender's mail you've marked read
 *   [1]  log1p(reply_count)     ≥ 0       ← # times you've drafted to this sender (any status)
 *   [2]  log1p(sender_freq_30d) ≥ 0       ← total mail from this sender in last 30d
 *   [3]  is_system_sender       0/1       ← regex on local-part: noreply/notifications/etc
 *   [4]  is_first_contact       0/1       ← we've never seen this sender before this row
 *   [5]  has_list_unsubscribe   0/1       ← RFC 2369 List-Unsubscribe header present
 *   [6]  has_list_id            0/1       ← RFC 2919 List-Id header present
 *   [7]  is_auto_submitted      0/1       ← Auto-Submitted: auto-* (RFC 3834)
 *   [8]  is_bulk_precedence     0/1       ← Precedence: bulk/list/junk (de-facto header)
 *   [9]  reserved               0         ← future: thread_reply_depth, time-of-day, etc
 */
import db from "./db";

export const FEATURE_DIM = 10;

/** Local-part patterns that strongly indicate a system/no-reply sender —
 *  these are never primary (1:1 human) regardless of subject content. */
const SYSTEM_LOCAL_PART_RE =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|updates?|mailer|postmaster|bounce|automated?|system\w*|systemmessage|reply\+|info|hello|support|hi|admin|hr|robot|daemon)[+.\-]?/i;

export interface SenderHeaderInputs {
  /** Lowercased email of sender. Pass raw — we lowercase internally. */
  fromEmail: string;
  /** Skip ID when computing stats for an in-flight new arrival (it's already
   *  upserted by the time prefetch Step 2a runs). For retroactive feature
   *  computation on existing rows, pass the email's id to exclude itself. */
  excludeEmailId?: string;
  /** RFC 2369 List-Unsubscribe header (we only check for presence, not value). */
  listUnsubscribe?: string;
  /** RFC 2919 List-Id. */
  listId?: string;
  /** RFC 3834 Auto-Submitted. "no" is treated as absent. */
  autoSubmitted?: string;
  /** Precedence (de-facto). bulk / list / junk all count as bulk. */
  precedence?: string;
}

export interface SenderFeatures {
  read_rate_30d: number;
  reply_count: number;
  sender_freq_30d: number;
  is_system_sender: number;
  is_first_contact: number;
  has_list_unsubscribe: number;
  has_list_id: number;
  is_auto_submitted: number;
  is_bulk_precedence: number;
}

/** Pack a SenderFeatures object into the FEATURE_DIM Float32Array consumed
 *  by the LR head. Indices match the comment block at top of this file. */
export function featuresToVector(f: SenderFeatures): Float32Array {
  const v = new Float32Array(FEATURE_DIM);
  v[0] = f.read_rate_30d;
  v[1] = Math.log1p(f.reply_count);
  v[2] = Math.log1p(f.sender_freq_30d);
  v[3] = f.is_system_sender;
  v[4] = f.is_first_contact;
  v[5] = f.has_list_unsubscribe;
  v[6] = f.has_list_id;
  v[7] = f.is_auto_submitted;
  v[8] = f.is_bulk_precedence;
  v[9] = 0;
  return v;
}

/** Concatenate a content embedding (e.g. 384-d SetFit) with a feature vector. */
export function concatEmbeddingWithFeatures(embedding: Float32Array, features: Float32Array): Float32Array {
  const out = new Float32Array(embedding.length + features.length);
  out.set(embedding, 0);
  out.set(features, embedding.length);
  return out;
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(0, at) : email;
}

function isAutoSubmittedHeader(v: string | undefined): number {
  if (!v) return 0;
  const t = v.trim().toLowerCase();
  if (!t || t === "no") return 0;
  return /^auto-/.test(t) ? 1 : 0;
}

function isBulkPrecedenceHeader(v: string | undefined): number {
  if (!v) return 0;
  const t = v.trim().toLowerCase();
  return t === "bulk" || t === "list" || t === "junk" ? 1 : 0;
}

/** Compute sender features for an email. Pure function over current DB state +
 *  passed header values. Designed to be cheap (~3 prepared SQL queries
 *  totaling sub-millisecond) so it's called inline during prefetch Step 2a. */
export function computeSenderFeatures(input: SenderHeaderInputs): SenderFeatures {
  const fromEmail = (input.fromEmail || "").toLowerCase().trim();
  const exclude = input.excludeEmailId || "";

  // Defensive default if from_email empty/malformed: zero-feature vector,
  // SetFit content path will still handle it.
  if (!fromEmail || fromEmail.indexOf("@") < 0) {
    return {
      read_rate_30d: 0,
      reply_count: 0,
      sender_freq_30d: 0,
      is_system_sender: 0,
      is_first_contact: 1,
      has_list_unsubscribe: input.listUnsubscribe ? 1 : 0,
      has_list_id: input.listId ? 1 : 0,
      is_auto_submitted: isAutoSubmittedHeader(input.autoSubmitted),
      is_bulk_precedence: isBulkPrecedenceHeader(input.precedence),
    };
  }

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

  // Sender frequency last 30d + read count (one query, two cols).
  const stats = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN is_unread = 0 THEN 1 ELSE 0 END) AS read_count
     FROM emails
     WHERE LOWER(from_email) = ?
       AND received_at > ?
       AND id != ?`,
  ).get(fromEmail, thirtyDaysAgo, exclude) as { total: number; read_count: number } | undefined;

  const total = stats?.total ?? 0;
  const readCount = stats?.read_count ?? 0;
  // Read rate denominator includes 0 because freq_30d already captures volume —
  // a sender with 1 email both read and unread should not score higher than
  // one with 10 emails 5 of which read. The model can compose freq + rate.
  const readRate = total > 0 ? readCount / total : 0;

  // Reply count: any draft (draft / pushed / sent / scheduled) whose
  // to_address contains this sender's full email (case-insensitive). LIKE is
  // OK here: to_address is small and not user-controlled SQL.
  const replyRow = db.prepare(
    `SELECT COUNT(*) AS n FROM drafts WHERE LOWER(to_address) LIKE ? AND status IN ('draft','pushed','sent','scheduled')`,
  ).get(`%${fromEmail}%`) as { n: number } | undefined;
  const replyCount = replyRow?.n ?? 0;

  // First-contact heuristic: 0 prior emails ever in DB from this sender
  // (excluding the row we're scoring). Cheap second query since we already
  // know total in last 30d — but a sender could be in DB > 30d ago and the
  // first-contact bit should reflect "ever seen", not "seen recently".
  const everRow = db.prepare(
    `SELECT 1 FROM emails WHERE LOWER(from_email) = ? AND id != ? LIMIT 1`,
  ).get(fromEmail, exclude) as { 1: number } | undefined;
  const isFirstContact = everRow ? 0 : 1;

  const isSystem = SYSTEM_LOCAL_PART_RE.test(localPart(fromEmail)) ? 1 : 0;

  return {
    read_rate_30d: readRate,
    reply_count: replyCount,
    sender_freq_30d: total,
    is_system_sender: isSystem,
    is_first_contact: isFirstContact,
    has_list_unsubscribe: input.listUnsubscribe ? 1 : 0,
    has_list_id: input.listId ? 1 : 0,
    is_auto_submitted: isAutoSubmittedHeader(input.autoSubmitted),
    is_bulk_precedence: isBulkPrecedenceHeader(input.precedence),
  };
}
