/**
 * Data for the /automation page: a replay of how the pipeline processed one
 * day of mail, built only from timestamps already in the DB (no model calls).
 *
 * Per email: received_at (IMAP INTERNALDATE) → classified_at + classifier
 * (local SetFit / MiniLM, LLM fallback, or user) → first extracted event →
 * first draft → job-tracker row. `fetched_at` is not used: every IMAP
 * re-fetch bumps it, so it is not the first-fetch time.
 *
 * DEMO_MODE freezes these fields into `pipeline_snapshot` on first boot, so
 * visitor clicks (re-labeling, scans, drafts) never rewrite the recorded day.
 * Without a snapshot the same query runs against the live tables.
 */
import db, { getAppState, setAppState } from "./db";

export const USER_TZ = process.env.EMAILDIGEST_USER_TZ || "America/Los_Angeles";

const LIVE_SQL = `
  SELECT
    e.id AS email_id,
    e.received_at,
    e.classified_at,
    e.classifier,
    e.category_id,
    e.subject,
    e.from_name,
    (SELECT MIN(x.extracted_at) FROM events x WHERE x.email_id = e.id) AS event_at,
    (SELECT COUNT(*) FROM events x WHERE x.email_id = e.id) AS event_count,
    (SELECT x.title FROM events x WHERE x.email_id = e.id ORDER BY x.extracted_at, x.id LIMIT 1) AS event_title,
    (SELECT MIN(d.created_at) FROM drafts d WHERE d.email_id = e.id AND d.demo_user = 'owner') AS draft_at,
    (SELECT d.type FROM drafts d WHERE d.email_id = e.id AND d.demo_user = 'owner' ORDER BY d.created_at LIMIT 1) AS draft_type,
    j.classified_at AS job_at,
    j.stage AS job_stage
  FROM emails e
  LEFT JOIN job_emails j ON j.email_id = e.id
  WHERE e.received_at > 0
`;

interface PipelineRow {
  email_id: string;
  received_at: number;
  classified_at: number | null;
  classifier: string | null;
  category_id: string | null;
  subject: string;
  from_name: string;
  event_at: number | null;
  event_count: number;
  event_title: string | null;
  draft_at: number | null;
  draft_type: string | null;
  job_at: number | null;
  job_stage: string | null;
}

function hasSnapshot(): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_snapshot'").get();
}

/** Create the snapshot once. Returns true when it was created by this call. */
export function ensurePipelineSnapshot(): boolean {
  if (hasSnapshot()) return false;
  db.transaction(() => {
    db.exec(`CREATE TABLE pipeline_snapshot AS ${LIVE_SQL}`);
    setAppState("pipeline_snapshot_at", String(Math.floor(Date.now() / 1000)));
  })();
  return true;
}

function loadRows(): PipelineRow[] {
  const sql = hasSnapshot() ? "SELECT * FROM pipeline_snapshot" : LIVE_SQL;
  return db.prepare(`SELECT * FROM (${sql}) ORDER BY received_at ASC, email_id ASC`).all() as PipelineRow[];
}

export type ClassifierKind = "local" | "llm" | "user" | "none" | "other";

/** Map stored classifier labels to the three routes the page explains. */
export function classifierKind(classifier: string | null, categoryId: string | null): ClassifierKind {
  const c = (classifier || "").toLowerCase();
  if (c === "setfit" || c === "minilm" || c === "centroid" || c === "local") return "local";
  if (c === "llm") return "llm";
  if (c === "user") return "user";
  if (!c && !categoryId) return "none";
  return "other";
}

/** "YYYY-MM-DD" of an epoch-seconds timestamp in the user's timezone. */
export function dayKey(ts: number, tz = USER_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ts * 1000));
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch seconds of local midnight that starts `day` in `tz`. */
export function localMidnight(day: string, tz = USER_TZ): number {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess, tz);
  // Re-check once in case midnight sits on the other side of a DST change.
  return Math.floor((guess - tzOffsetMs(first, tz)) / 1000);
}

export interface AutomationOverview {
  tz: string;
  snapshot: boolean;
  range: { first: number | null; last: number | null };
  days: Array<{ day: string; emails: number }>;
  counts: {
    emails: number;
    local: number;
    llm: number;
    user: number;
    unclassified: number;
    other: number;
    events: number;
    emailsWithEvents: number;
    drafts: number;
    jobEmails: number;
  };
}

export function getAutomationOverview(): AutomationOverview {
  const rows = loadRows();
  const perDay = new Map<string, number>();
  for (const r of rows) {
    const k = dayKey(r.received_at);
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }

  // Live counts: the database as it is now (not the snapshot).
  const byClassifier = db.prepare(
    "SELECT classifier, category_id IS NULL AS uncategorized, COUNT(*) AS n FROM emails GROUP BY classifier, category_id IS NULL"
  ).all() as Array<{ classifier: string | null; uncategorized: number; n: number }>;
  const counts = { emails: 0, local: 0, llm: 0, user: 0, unclassified: 0, other: 0, events: 0, emailsWithEvents: 0, drafts: 0, jobEmails: 0 };
  for (const r of byClassifier) {
    counts.emails += r.n;
    const kind = classifierKind(r.classifier, r.uncategorized ? null : "x");
    if (kind === "none") counts.unclassified += r.n;
    else counts[kind] += r.n;
  }
  const scalar = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  counts.events = scalar("SELECT COUNT(*) AS n FROM events");
  counts.emailsWithEvents = scalar("SELECT COUNT(DISTINCT email_id) AS n FROM events");
  counts.drafts = scalar("SELECT COUNT(*) AS n FROM drafts WHERE demo_user = 'owner'");
  counts.jobEmails = scalar("SELECT COUNT(*) AS n FROM job_emails");

  return {
    tz: USER_TZ,
    snapshot: hasSnapshot() && !!getAppState("pipeline_snapshot_at"),
    range: {
      first: rows.length ? rows[0].received_at : null,
      last: rows.length ? rows[rows.length - 1].received_at : null,
    },
    days: Array.from(perDay, ([day, emails]) => ({ day, emails })),
    counts,
  };
}

export interface ReplayItem {
  id: string;
  receivedAt: number;
  subject: string;
  from: string;
  classifier: ClassifierKind;
  classifiedAt: number | null;
  event: { at: number; title: string; count: number } | null;
  draft: { at: number; type: string } | null;
  job: { at: number; stage: string } | null;
}

export interface ReplayDay {
  day: string;
  tz: string;
  dayStart: number;
  dayEnd: number;
  items: ReplayItem[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getReplayDay(day: string): ReplayDay | null {
  if (!DAY_RE.test(day)) return null;
  const dayStart = localMidnight(day);
  const next = new Date((dayStart + 36 * 3600) * 1000);
  const dayEnd = localMidnight(dayKey(Math.floor(next.getTime() / 1000)));
  const items = loadRows()
    .filter((r) => dayKey(r.received_at) === day)
    .map((r): ReplayItem => {
      const kind = classifierKind(r.classifier, r.category_id);
      // classified_at is set on insert and moved by every later verdict;
      // only a time at or after arrival is a real classification time.
      const classifiedAt = kind !== "none" && r.classified_at && r.classified_at >= r.received_at ? r.classified_at : null;
      return {
        id: r.email_id,
        receivedAt: r.received_at,
        subject: r.subject,
        from: r.from_name,
        classifier: kind,
        classifiedAt,
        event: r.event_at ? { at: r.event_at, title: r.event_title || "", count: r.event_count } : null,
        draft: r.draft_at ? { at: r.draft_at, type: r.draft_type || "reply" } : null,
        job: r.job_at ? { at: r.job_at, stage: r.job_stage || "" } : null,
      };
    });
  return { day, tz: USER_TZ, dayStart, dayEnd, items };
}
