import db, { listJobEmails, setMaybeWork, clearJobSkipped, upsertWorkLabel, updateWorkEmbedding, type EmailRow } from "@/lib/db";
import { blobToEmbedding } from "@/lib/embedder";
import { driftWorkSeed } from "@/lib/work-seed";
import { trainWorkClassifier } from "@/lib/work-classifier";
import {
  isWorkEmbedderAvailable,
  embedTextForWork,
  workEmbeddingToBlob,
} from "@/lib/work-embedder";
import { trainSetfitHead } from "@/lib/setfit-head";
import { forceClassifySingleEmail } from "@/lib/jobs-pipeline";
import { collectUsage, withUsageHeader } from "@/lib/demo-usage";

// In-process locks. The persistent truth (maybe_work, work_labels, job_emails,
// app_state.setfit_head_runtime) all live in SQLite — these maps only dedupe
// concurrent compute when a user double-clicks or two tabs both hit the same
// email. Doc §1 accepts in-process locks when the persistent state is held
// elsewhere; same pattern as regenInFlight in lib/email-digest.ts.
const forceClassifyInFlight = new Set<string>();
let setfitRetrainInFlight = false;

interface JobJoined {
  emailId: string;
  stage: string;
  needsAction: boolean;
  actionType: string;
  priority: string;
  deadline: number | null;
  summary: string;
  company: string;
  role: string;
  isUserCorrected: boolean;
  classifiedAt: number;
  // joined from emails
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  date: string;
  receivedAt: number;
  threadId: string;
  isUnread: boolean;
}

export async function GET() {
  try {
    const jobs = listJobEmails();
    if (jobs.length === 0) return Response.json({ jobs: [] });
    const ids = jobs.map((j) => j.email_id);
    const placeholders = ids.map(() => "?").join(",");
    const emails = db.prepare(
      `SELECT id, from_name, from_email, subject, snippet, date, received_at, thread_id, is_unread
       FROM emails WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Pick<EmailRow, "id" | "from_name" | "from_email" | "subject" | "snippet" | "date" | "received_at" | "thread_id" | "is_unread">>;
    const eMap = new Map(emails.map((e) => [e.id, e]));

    const result: JobJoined[] = jobs.flatMap((j) => {
      const e = eMap.get(j.email_id);
      if (!e) return [];
      return [{
        emailId: j.email_id,
        stage: j.stage,
        needsAction: j.needs_action === 1,
        actionType: j.action_type,
        priority: j.priority,
        deadline: j.deadline,
        summary: j.summary,
        company: j.company,
        role: j.role,
        isUserCorrected: j.is_user_corrected === 1,
        classifiedAt: j.classified_at,
        from: e.from_name,
        fromEmail: e.from_email,
        subject: e.subject,
        snippet: e.snippet,
        date: e.date,
        receivedAt: e.received_at,
        threadId: e.thread_id,
        isUnread: e.is_unread === 1,
      }];
    });

    return Response.json({ jobs: result });
  } catch (e) {
    console.error("[api/jobs GET]", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (body.action === "forceClassifyAsJob") {
    // User-driven: "this IS a job, classify it now". Bypasses the is_job LLM
    // gate so a terse reject email / ATS auto-reply cannot be re-skipped.
    const id = body.emailId as string;
    if (!id) return Response.json({ error: "emailId required" }, { status: 400 });
    // Dedupe: if the same email is already being classified (multi-tab,
    // double-click), reject the second request rather than firing a parallel
    // ~10s spawn that would race with the first on resolveApplication.
    if (forceClassifyInFlight.has(id)) {
      return Response.json(
        { error: "classification_in_progress", emailId: id },
        { status: 409 },
      );
    }
    forceClassifyInFlight.add(id);
    setMaybeWork(id, true);
    clearJobSkipped(id);
    upsertWorkLabel(id, 1, "user_correction");
    try {
      const row = db.prepare("SELECT embedding FROM emails WHERE id = ?").get(id) as { embedding: Buffer | null } | undefined;
      if (row?.embedding) driftWorkSeed(blobToEmbedding(row.embedding), "positive");
    } catch (e) {
      console.warn("[jobs/forceClassifyAsJob] drift failed:", e);
    }

    // Ensure SetFit work_embedding is cached for this email so the LR head
    // retrain (next step) has data to learn from. If we skip this, the email
    // we just labeled won't actually contribute to the new head.
    if (isWorkEmbedderAvailable()) {
      try {
        const row = db.prepare(
          "SELECT subject, snippet, work_embedding FROM emails WHERE id = ?"
        ).get(id) as { subject: string; snippet: string; work_embedding: Buffer | null } | undefined;
        if (row && !row.work_embedding) {
          const text = (row.subject || "").slice(0, 200) + "\n" + (row.snippet || "").slice(0, 1500);
          const emb = await embedTextForWork(text);
          updateWorkEmbedding(id, workEmbeddingToBlob(emb));
        }
      } catch (e) {
        console.warn("[jobs/forceClassifyAsJob] work_embedding cache failed:", e);
      }
    }

    queueMicrotask(() => {
      // SetFit LR-head warm-start retrain (preferred). Falls back to legacy
      // raw-MiniLM LR if SetFit head/data is unavailable. Both are best-effort
      // — failure here doesn't break the user-visible classify-as-job flow.
      // Dedup: skip if a retrain is already in flight. Without this, two
      // user corrections within ~100ms can both load the current head, train
      // independently, and last-write-wins — losing one correction's
      // gradient updates.
      if (setfitRetrainInFlight) return;
      setfitRetrainInFlight = true;
      try {
        if (isWorkEmbedderAvailable()) {
          try { trainSetfitHead({ warmStart: true }); }
          catch (e) { console.warn("[jobs/forceClassifyAsJob] setfit retrain failed:", e); }
        } else {
          try { trainWorkClassifier({ warmStart: true }); }
          catch (e) { console.warn("[jobs/forceClassifyAsJob] legacy retrain failed:", e); }
        }
      } finally {
        setfitRetrainInFlight = false;
      }
    });
    const { result: response, usage } = await collectUsage(async () => {
      try {
        const result = await forceClassifySingleEmail(id);
        if (!result) return Response.json({ error: "email not found" }, { status: 404 });
        return Response.json({ ok: true, result });
      } catch (e) {
        console.error("[jobs/forceClassifyAsJob]", e);
        return Response.json({ error: String(e) }, { status: 500 });
      } finally {
        forceClassifyInFlight.delete(id);
      }
    });
    return withUsageHeader(response, usage);
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
