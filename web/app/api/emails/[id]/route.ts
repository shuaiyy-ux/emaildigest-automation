import db, { getEmailById } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const email = getEmailById(id);

  if (!email) {
    return Response.json({ error: "Email not found" }, { status: 404 });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Job-related = tracked by the Jobs pipeline (used for the demo's
  // "company names are anonymized" note on the detail view).
  const isJob = !!db.prepare("SELECT 1 FROM job_emails WHERE email_id = ?").get(email.id);
  const primaryUntilActive = email.primary_until != null && email.primary_until > nowSec;
  return Response.json({
    id: email.id,
    from: email.from_name,
    fromEmail: email.from_email,
    subject: email.subject,
    snippet: email.snippet,
    body: email.body,
    bodyHtml: email.body_html,
    date: email.date,
    category: email.category,
    categoryId: email.category_id,
    confidence: email.confidence,
    classifier: email.classifier,
    threadId: email.thread_id,
    isUnread: email.is_unread === 1,
    primaryUntil: email.primary_until,
    isPriority:
      email.category_id !== "cat_junk" &&
      (email.category_id === "cat_primary" || primaryUntilActive),
    isJob,
  });
}
