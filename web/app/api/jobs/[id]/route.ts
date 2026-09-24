import db, { updateJobEmailStage, removeJobEmail, getJobEmail, insertJobCorrection, setMaybeWork, markJobSkipped, upsertWorkLabel, updateWorkEmbedding, type EmailRow } from "@/lib/db";
import { blobToEmbedding } from "@/lib/embedder";
import { driftWorkSeed } from "@/lib/work-seed";
import { trainWorkClassifier } from "@/lib/work-classifier";
import { isWorkEmbedderAvailable, embedTextForWork, workEmbeddingToBlob } from "@/lib/work-embedder";
import { trainSetfitHead } from "@/lib/setfit-head";
import { recomputeApplicationFromEmails } from "@/lib/applications";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const cur = getJobEmail(id);
  if (!cur) {
    return Response.json({ error: "Job email not found" }, { status: 404 });
  }

  // For correction logging we want the source email's metadata
  const emailMeta = db.prepare(
    "SELECT from_email, subject FROM emails WHERE id = ?"
  ).get(id) as Pick<EmailRow, "from_email" | "subject"> | undefined;

  if (body.action === "updateStage") {
    const nextStage = typeof body.stage === "string" ? body.stage : undefined;
    const nextCompany = typeof body.company === "string" ? body.company : undefined;
    updateJobEmailStage(id, {
      stage: nextStage,
      needsAction: typeof body.needsAction === "boolean" ? body.needsAction : undefined,
      actionType: typeof body.actionType === "string" ? body.actionType : undefined,
      priority: typeof body.priority === "string" ? body.priority : undefined,
      company: nextCompany,
      role: typeof body.role === "string" ? body.role : undefined,
    });
    if (nextStage && nextStage !== cur.stage) {
      insertJobCorrection({
        emailId: id,
        fromEmail: emailMeta?.from_email,
        subject: emailMeta?.subject,
        mlStage: cur.stage,
        userStage: nextStage,
        kind: "stage",
      });
    }
    if (nextCompany !== undefined && nextCompany !== cur.company) {
      insertJobCorrection({
        emailId: id,
        fromEmail: emailMeta?.from_email,
        subject: emailMeta?.subject,
        mlCompany: cur.company,
        userCompany: nextCompany,
        kind: "company",
      });
    }
    // Refresh parent application snapshot so the needs_action badge and
    // other derived fields on the kanban card reflect this email's change.
    if (cur.application_id) {
      try { recomputeApplicationFromEmails(cur.application_id); }
      catch (e) { console.warn("[jobs/updateStage] recompute failed:", e); }
    }
    return Response.json({ updated: true });
  }

  if (body.action === "remove") {
    insertJobCorrection({
      emailId: id,
      fromEmail: emailMeta?.from_email,
      subject: emailMeta?.subject,
      mlStage: cur.stage,
      kind: "remove",
    });
    removeJobEmail(id);
    // Lock this email out of future Jobs runs + record the negative label for the classifier.
    setMaybeWork(id, false);
    markJobSkipped(id, "user:not_job");
    upsertWorkLabel(id, 0, "user_correction");
    try {
      const row = db.prepare("SELECT embedding FROM emails WHERE id = ?").get(id) as { embedding: Buffer | null } | undefined;
      if (row?.embedding) driftWorkSeed(blobToEmbedding(row.embedding), "negative");
    } catch (e) {
      console.warn("[jobs/remove] drift failed:", e);
    }

    // Cache SetFit work_embedding (mirror jobs/forceClassifyAsJob path) so the
    // negative label has data for the head retrain to learn from. Skipping
    // this leaves the just-labeled email out of the SetFit training loop.
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
        console.warn("[jobs/remove] work_embedding cache failed:", e);
      }
    }

    // Fire-and-forget warm-start retrain. Handler returns immediately; model
    // update lands a second later, next classification tick sees new weights.
    // Prefers SetFit head; falls back to legacy raw-MiniLM LR if SetFit
    // unavailable. Both are best-effort.
    queueMicrotask(() => {
      if (isWorkEmbedderAvailable()) {
        try { trainSetfitHead({ warmStart: true }); }
        catch (e) { console.warn("[jobs/remove] setfit retrain failed:", e); }
      } else {
        try { trainWorkClassifier({ warmStart: true }); }
        catch (e) { console.warn("[jobs/remove] legacy retrain failed:", e); }
      }
    });
    return Response.json({ removed: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
