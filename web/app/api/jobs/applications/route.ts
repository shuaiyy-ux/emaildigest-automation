import { listApplications, listApplicationEmails } from "@/lib/applications";

export async function GET() {
  try {
    const apps = listApplications();
    const enriched = apps.map((a) => {
      const emails = listApplicationEmails(a.id);
      const unread = emails.filter((e) => e.is_unread === 1).length;
      return {
        id: a.id,
        company: a.company_display || a.company,
        role: a.role_display || a.role,
        currentStage: a.current_stage,
        currentPriority: a.current_priority,
        currentSummary: a.current_summary,
        currentDeadline: a.current_deadline,
        needsAction: a.needs_action === 1,
        actionType: a.action_type,
        salary: a.salary,
        location: a.location,
        remoteMode: a.remote_mode,
        visaNote: a.visa_note,
        isUserCorrected: a.is_user_corrected === 1,
        firstEmailAt: a.first_email_at,
        latestEmailAt: a.latest_email_at,
        emailCount: emails.length,
        unreadCount: unread,
        emails: emails.map((e) => ({
          emailId: e.email_id,
          from: e.from_name,
          fromEmail: e.from_email,
          subject: e.subject,
          snippet: e.snippet,
          date: e.date,
          receivedAt: e.received_at,
          threadId: e.thread_id,
          isUnread: e.is_unread === 1,
          stage: e.stage,
          needsAction: e.needs_action === 1,
          actionType: e.action_type,
          priority: e.priority,
          deadline: e.deadline,
          summary: e.summary,
        })),
      };
    });
    return Response.json({ applications: enriched });
  } catch (e) {
    console.error("[api/jobs/applications GET]", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
