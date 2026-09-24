import {
  getApplication,
  renameApplication,
  updateApplicationStage,
  deleteApplication,
  listApplicationEmails,
} from "@/lib/applications";
import { insertJobCorrection } from "@/lib/db";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!getApplication(id)) {
    return Response.json({ error: "Application not found" }, { status: 404 });
  }

  if (body.action === "updateStage") {
    const cur = getApplication(id)!;
    const nextStage = typeof body.stage === "string" ? body.stage : undefined;
    updateApplicationStage(id, {
      stage: nextStage,
      priority: typeof body.priority === "string" ? body.priority : undefined,
      needsAction: typeof body.needsAction === "boolean" ? body.needsAction : undefined,
      actionType: typeof body.actionType === "string" ? body.actionType : undefined,
    });
    // Log stage corrections so the LLM learns from them next time.
    if (nextStage && nextStage !== cur.current_stage) {
      const emails = listApplicationEmails(id);
      for (const e of emails) {
        insertJobCorrection({
          emailId: e.email_id,
          fromEmail: e.from_email,
          subject: e.subject,
          mlStage: e.stage,
          userStage: nextStage,
          kind: "stage",
        });
      }
    }
    return Response.json({ updated: true });
  }

  if (body.action === "rename") {
    const cur = getApplication(id)!;
    const newCompany = typeof body.company === "string" ? body.company : undefined;
    renameApplication(id, {
      company: newCompany,
      role: typeof body.role === "string" ? body.role : undefined,
    });
    // Log company correction so LLM learns the user's preferred company name.
    if (newCompany !== undefined && newCompany !== cur.company_display) {
      const emails = listApplicationEmails(id);
      for (const e of emails) {
        insertJobCorrection({
          emailId: e.email_id,
          fromEmail: e.from_email,
          subject: e.subject,
          mlCompany: cur.company_display,
          userCompany: newCompany,
          kind: "company",
        });
      }
    }
    return Response.json({ renamed: true });
  }

  if (body.action === "remove") {
    // Log "not a job" correction for every email in the app, BEFORE deletion,
    // so the LLM sees them as negative examples next time it triages similar mail.
    const emails = listApplicationEmails(id);
    for (const e of emails) {
      insertJobCorrection({
        emailId: e.email_id,
        fromEmail: e.from_email,
        subject: e.subject,
        mlStage: e.stage,
        kind: "remove",
      });
    }
    deleteApplication(id);
    return Response.json({ removed: true, learned: emails.length });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
