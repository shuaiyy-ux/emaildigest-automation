/**
 * Applications layer — aggregates job emails into "one application = one company + role".
 * Independent of Gmail thread_id, so multi-thread applications (ATS confirm + HR personal
 * note + Greenhouse calendar) can collapse to a single Kanban card.
 */
import db, { type ApplicationRow, type JobEmailRow, setJobEmailApplicationId } from "./db";

const COMPANY_SUFFIX_RE = /\b(inc|llc|corp|corporation|ltd|limited|gmbh|co|company|capital|america)\b/g;
const ROLE_SENIORITY_RE = /\b(sr|jr|senior|junior|lead|principal|staff)\b\.?/g;
const ROLE_NUMERIC_RE = /\b(i|ii|iii|iv|v|vi)\b/g;
const NON_ALNUM_RE = /[^a-z0-9]+/g;

export function normalizeCompany(s: string): string {
  if (!s) return "";
  return s.toLowerCase()
    .replace(/[.,&]+/g, " ")
    .replace(COMPANY_SUFFIX_RE, " ")
    .replace(NON_ALNUM_RE, "");
}

export function normalizeRole(s: string): string {
  if (!s) return "";
  return s.toLowerCase()
    .replace(ROLE_SENIORITY_RE, " ")
    .replace(ROLE_NUMERIC_RE, " ")
    .replace(NON_ALNUM_RE, "");
}

function generateApplicationId(): string {
  return "app_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Find an application by normalized (company, role) or create one.
 * Returns the application id. Empty company → returns the special "?" bucket.
 */
export function findOrCreateApplication(args: {
  company: string;
  role: string;
  firstEmailAt: number;
}): string {
  const company = normalizeCompany(args.company) || "?";
  const role = normalizeRole(args.role); // empty role allowed (will fold into one app per company)

  const existing = db.prepare(
    "SELECT id FROM applications WHERE company = ? AND role = ?"
  ).get(company, role) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = generateApplicationId();
  db.prepare(`
    INSERT INTO applications (
      id, company, role, company_display, role_display,
      current_stage, current_priority,
      first_email_at, latest_email_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'applied', 'medium', ?, ?, unixepoch(), unixepoch())
  `).run(
    id,
    company,
    role,
    args.company || "(unknown)",
    args.role || "",
    args.firstEmailAt,
    args.firstEmailAt,
  );
  return id;
}

/**
 * Recompute the application's "current_*" snapshot from its job_emails.
 * Latest email's values win for current_*; first_email_at and latest_email_at
 * span the full range; salary/location/etc take the latest non-empty value.
 */
export function recomputeApplicationFromEmails(applicationId: string) {
  const rows = db.prepare(`
    SELECT je.*, e.received_at AS received_at
    FROM job_emails je
    JOIN emails e ON e.id = je.email_id
    WHERE je.application_id = ?
    ORDER BY e.received_at ASC
  `).all(applicationId) as Array<JobEmailRow & { received_at: number }>;

  if (rows.length === 0) {
    // No emails left — caller may want to delete the empty application.
    db.prepare("DELETE FROM applications WHERE id = ?").run(applicationId);
    return;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  // Aggregate metadata (last non-empty wins)
  const pickLast = (key: keyof JobEmailRow) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i][key];
      if (v) return v;
    }
    return "";
  };

  const company = pickLast("company") as string || "(unknown)";
  const role = pickLast("role") as string;

  // needs_action is OR across child emails: if ANY email still needs action,
  // the application does. Previously this took last.needs_action, so
  // dismissing only the newest email would zero the badge even when earlier
  // emails still had open actions. action_type follows the latest email
  // that still has needs_action=1; if none, keep last.action_type for context.
  const anyNeedsAction = rows.some((r) => r.needs_action === 1) ? 1 : 0;
  const actionType = anyNeedsAction
    ? ([...rows].reverse().find((r) => r.needs_action === 1)?.action_type ?? last.action_type)
    : last.action_type;

  db.prepare(`
    UPDATE applications SET
      company = ?,
      role = ?,
      company_display = CASE WHEN is_user_corrected = 1 THEN company_display ELSE ? END,
      role_display = CASE WHEN is_user_corrected = 1 THEN role_display ELSE ? END,
      current_stage = ?,
      current_priority = ?,
      current_summary = ?,
      current_deadline = ?,
      needs_action = ?,
      action_type = ?,
      salary = ?,
      location = ?,
      remote_mode = ?,
      visa_note = ?,
      first_email_at = ?,
      latest_email_at = ?,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    normalizeCompany(company) || "?",
    normalizeRole(role),
    company,
    role,
    last.stage,
    last.priority,
    last.summary,
    last.deadline,
    anyNeedsAction,
    actionType,
    pickLast("salary"),
    pickLast("location"),
    pickLast("remote_mode"),
    pickLast("visa_note"),
    first.received_at,
    last.received_at,
    applicationId,
  );
}

export function listApplications(): ApplicationRow[] {
  return db.prepare(
    "SELECT * FROM applications ORDER BY latest_email_at DESC"
  ).all() as ApplicationRow[];
}

export function getApplication(id: string): ApplicationRow | undefined {
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as ApplicationRow | undefined;
}

export function listApplicationEmails(applicationId: string): Array<JobEmailRow & {
  from_name: string; from_email: string; subject: string; snippet: string; date: string; received_at: number; thread_id: string; is_unread: number;
}> {
  return db.prepare(`
    SELECT je.*, e.from_name, e.from_email, e.subject, e.snippet, e.date, e.received_at, e.thread_id, e.is_unread
    FROM job_emails je
    JOIN emails e ON e.id = je.email_id
    WHERE je.application_id = ?
    ORDER BY e.received_at ASC
  `).all(applicationId) as Array<JobEmailRow & {
    from_name: string; from_email: string; subject: string; snippet: string; date: string; received_at: number; thread_id: string; is_unread: number;
  }>;
}

/**
 * Merge sourceIds into targetId. All emails reassigned, sources deleted.
 * targetId's user-corrected display values are preserved.
 */
export function mergeApplications(targetId: string, sourceIds: string[]) {
  if (sourceIds.length === 0) return;
  const target = getApplication(targetId);
  if (!target) throw new Error(`target application ${targetId} not found`);
  const tx = db.transaction(() => {
    const placeholders = sourceIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE job_emails SET application_id = ? WHERE application_id IN (${placeholders})`
    ).run(targetId, ...sourceIds);
    db.prepare(`DELETE FROM applications WHERE id IN (${placeholders})`).run(...sourceIds);
  });
  tx();
  recomputeApplicationFromEmails(targetId);
}

/**
 * Split: move `emailIds` out of `applicationId` into a new application.
 * If newCompany/newRole provided, override; otherwise use the first split email's values.
 */
export function splitApplication(args: {
  applicationId: string;
  emailIds: string[];
  newCompany?: string;
  newRole?: string;
}): string {
  if (args.emailIds.length === 0) throw new Error("no emails to split");
  const movingRows = db.prepare(
    `SELECT je.*, e.received_at AS received_at FROM job_emails je
     JOIN emails e ON e.id = je.email_id
     WHERE je.email_id IN (${args.emailIds.map(() => "?").join(",")})`
  ).all(...args.emailIds) as Array<JobEmailRow & { received_at: number }>;
  if (movingRows.length === 0) throw new Error("emails not found in job_emails");

  const company = args.newCompany || movingRows[0].company || "(unknown)";
  const role = args.newRole || movingRows[0].role || "";
  const firstEmailAt = Math.min(...movingRows.map((r) => r.received_at));

  // Force-create a new application even if the normalized key already matches an existing one
  // (user explicitly wants to split). Use a unique key suffix to bypass the unique index.
  const id = generateApplicationId();
  db.prepare(`
    INSERT INTO applications (
      id, company, role, company_display, role_display,
      current_stage, current_priority,
      first_email_at, latest_email_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'applied', 'medium', ?, ?, unixepoch(), unixepoch())
  `).run(
    id,
    `${normalizeCompany(company)}__split_${id.slice(-6)}`, // ensure uniqueness; can be re-normalized later by user
    normalizeRole(role),
    company,
    role,
    firstEmailAt,
    firstEmailAt,
  );

  const tx = db.transaction(() => {
    const placeholders = args.emailIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE job_emails SET application_id = ? WHERE email_id IN (${placeholders})`
    ).run(id, ...args.emailIds);
  });
  tx();

  recomputeApplicationFromEmails(id);
  // Recompute source application (it may now be empty → auto-deleted)
  recomputeApplicationFromEmails(args.applicationId);
  return id;
}

/**
 * User-driven rename. Updates display + normalized fields. Locks against future
 * automatic overwrite. If normalized form collides with existing application,
 * caller should detect and offer merge.
 */
export function renameApplication(applicationId: string, args: {
  company?: string;
  role?: string;
}) {
  const cur = getApplication(applicationId);
  if (!cur) throw new Error("application not found");
  const newCompany = args.company !== undefined ? args.company : cur.company_display;
  const newRole = args.role !== undefined ? args.role : cur.role_display;
  db.prepare(`
    UPDATE applications SET
      company = ?,
      role = ?,
      company_display = ?,
      role_display = ?,
      is_user_corrected = 1,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    normalizeCompany(newCompany) || "?",
    normalizeRole(newRole),
    newCompany,
    newRole,
    applicationId,
  );
}

export function updateApplicationStage(applicationId: string, patch: {
  stage?: string;
  priority?: string;
  needsAction?: boolean;
  actionType?: string;
}) {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.stage !== undefined) { fields.push("current_stage = ?"); values.push(patch.stage); }
  if (patch.priority !== undefined) { fields.push("current_priority = ?"); values.push(patch.priority); }
  if (patch.needsAction !== undefined) { fields.push("needs_action = ?"); values.push(patch.needsAction ? 1 : 0); }
  if (patch.actionType !== undefined) { fields.push("action_type = ?"); values.push(patch.actionType); }
  if (fields.length === 0) return;
  fields.push("is_user_corrected = 1");
  fields.push("updated_at = unixepoch()");
  values.push(applicationId);
  db.prepare(`UPDATE applications SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteApplication(applicationId: string) {
  // Cascade: also delete linked job_emails so their emails fall out of Job tracker
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM job_emails WHERE application_id = ?").run(applicationId);
    db.prepare("DELETE FROM applications WHERE id = ?").run(applicationId);
  });
  tx();
}

/** Convenience used by job-classify pipeline:
 *  ensure email is linked to its application, then refresh application snapshot. */
export function linkEmailToApplication(args: {
  emailId: string;
  company: string;
  role: string;
  emailAt: number;
}): string {
  const appId = findOrCreateApplication({
    company: args.company,
    role: args.role,
    firstEmailAt: args.emailAt,
  });
  setJobEmailApplicationId(args.emailId, appId);
  recomputeApplicationFromEmails(appId);
  return appId;
}
