import { randomBytes } from "crypto";
import { getAllDrafts, getSentDrafts, createDraft, updateDraft, updateDraftStatus, deleteDraft, getEmailById, getDraftById, getOwnDraft, markDraftSent, scheduleDraft, getAttachments, getThreadEmails, getFailedScheduledDrafts, retryFailedDraft, markDraftAiGenerating, clearDraftAiGenerating, markDraftPushing, clearDraftPushing, markDraftSmtpSending, clearDraftSmtpSending } from "@/lib/db";
import { generateDraft } from "@/lib/draft-gen";
import { replyPrompt, forwardPrompt, composePrompt } from "@/lib/draft-prompts";
import { runCommand } from "@/lib/subprocess";
import { sendEmail, isSmtpConfigured, getSignature } from "@/lib/smtp";
import { createJob, updateJob, waitForJob } from "@/lib/jobs";
import { isDemoMode, getDemoUser } from "@/lib/demo";
import { EMPTY_USAGE, usageHeader } from "@/lib/demo-usage";
import { getProfileName } from "@/lib/profile";
import { log } from "@/lib/logger";

function generateId() {
  return `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Verify Claude's subprocess output actually shows gmail_create_draft ran.
// Conservative: require either a Gmail draft id (alphanumeric ≥12 chars after
// an "r" or hex-like) OR an explicit "draft created/saved" statement, AND
// no plain refusal/failure language that isn't offset by a success marker.
const GMAIL_DRAFT_ID_RE = /\b(r[-\w]{10,}|[a-f0-9]{16,})\b/i;
const DRAFT_CREATED_RE = /\bdraft\s+(has\s+been\s+)?(created|saved|successfully\s+created)\b|草稿(已|成功)?(创建|保存|已生成)|created\s+successfully/i;
const REFUSAL_RE = /\b(i\s+(cannot|can'?t|am\s+unable|couldn'?t|was\s+unable)|unable\s+to|failed\s+to|refused|not\s+authorized|permission\s+denied)\b|无法|未能|拒绝|没有权限/i;

function verifyGmailDraftCreated(result: string): { ok: boolean; reason?: string } {
  const s = (result || "").trim();
  if (s.length < 10) return { ok: false, reason: "empty or too-short subprocess result" };
  const hasSuccess = GMAIL_DRAFT_ID_RE.test(s) || DRAFT_CREATED_RE.test(s);
  const hasRefusal = REFUSAL_RE.test(s);
  if (!hasSuccess) return { ok: false, reason: "no draft-id or creation confirmation found" };
  if (hasRefusal && !GMAIL_DRAFT_ID_RE.test(s)) {
    return { ok: false, reason: "subprocess mentioned refusal/failure without a draft id" };
  }
  return { ok: true };
}

function toResponse(d: ReturnType<typeof getDraftById>) {
  if (!d) return null;
  return {
    id: d.id,
    emailId: d.email_id,
    threadId: d.thread_id,
    type: d.type,
    to: d.to_address,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    body: d.body,
    contentType: d.content_type,
    status: d.status,
    gmailDraftId: d.gmail_draft_id,
    sentAt: d.sent_at,
    gmailMessageId: d.gmail_message_id,
    scheduledAt: d.scheduled_at ?? null,
    sendAttempts: d.send_attempts ?? 0,
    lastSendError: d.last_send_error ?? null,
    lastSendAttemptAt: d.last_send_attempt_at ?? null,
    ai_generating_started_at: d.ai_generating_started_at ?? null,
    ai_generating_job_id: d.ai_generating_job_id ?? null,
    push_started_at: d.push_started_at ?? null,
    push_job_id: d.push_job_id ?? null,
    smtp_send_started_at: d.smtp_send_started_at ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const user = getDemoUser(request);
    const rows = status === "sent" ? getSentDrafts(user) : getAllDrafts(user);
    return Response.json({ drafts: rows.map((d) => toResponse(d)) });
  } catch (e) {
    console.error("[drafts GET] error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const user = getDemoUser(request);
  const demo = isDemoMode();

  try {
  // Every action that names a draft (id / draftId) must name one of the
  // requesting visitor's own drafts. Other visitors' drafts look absent.
  const refId = typeof body.id === "string" ? body.id : typeof body.draftId === "string" ? body.draftId : null;
  if (refId && !getOwnDraft(refId, user)) {
    return Response.json({ error: "Draft not found" }, { status: 404 });
  }

  // Create a new local draft (reply / forward / new)
  if (body.action === "create") {
    const emailId = body.emailId as string | undefined;
    const type = (body.type as string) || "reply";

    let to = "";
    let subject = "";
    let threadId = "";
    let quotedBody = "";

    if (emailId) {
      const email = getEmailById(emailId);
      if (email) {
        to = email.from_email;
        threadId = email.thread_id || "";
        if (type === "reply") {
          subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
          if (email.body) {
            const lines = email.body.split("\n").map((l) => `> ${l}`).join("\n");
            quotedBody = `\n\n---\nOn ${email.date}, ${email.from_name} wrote:\n${lines}`;
          }
        } else if (type === "forward") {
          subject = email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`;
          to = "";
          if (email.body) {
            quotedBody = `\n\n---------- Forwarded message ----------\nFrom: ${email.from_name} <${email.from_email}>\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.body}`;
          }
        }
      }
    }

    const draft = createDraft({
      id: generateId(),
      emailId,
      threadId,
      type,
      to: (body.to as string) || to,
      cc: (body.cc as string) || "",
      subject: (body.subject as string) || subject,
      body: (body.body as string) || quotedBody,
      user,
    });

    return Response.json({ draft: toResponse(draft) });
  }

  // Update an existing draft
  if (body.action === "update" && body.id) {
    const updated = updateDraft(body.id as string, {
      to: body.to as string | undefined,
      cc: body.cc as string | undefined,
      bcc: body.bcc as string | undefined,
      subject: body.subject as string | undefined,
      body: body.body as string | undefined,
    });
    if (!updated) return Response.json({ error: "Draft not found" }, { status: 404 });
    return Response.json({ draft: toResponse(updated) });
  }

  // Discard a draft
  if (body.action === "discard" && body.id) {
    updateDraftStatus(body.id as string, "discarded");
    return Response.json({ discarded: true });
  }

  // Delete a draft permanently
  if (body.action === "delete" && body.id) {
    deleteDraft(body.id as string);
    return Response.json({ deleted: true });
  }

  // Push draft to Gmail via gmail_create_draft.
  //
  // State-boundary: anchor the in-flight job to the draft so a refresh /
  // re-click during the 60s spawn doesn't fire a second gmail_create_draft
  // (which would leave two identical drafts in the user's Gmail). Mirror of
  // the AI Generate marker below; see docs/design/state-boundary.md.
  if (body.action === "pushToGmail" && body.id) {
    const draftId = body.id as string;
    const draft = getDraftById(draftId);
    if (!draft) return Response.json({ error: "Draft not found" }, { status: 404 });

    // DEMO_MODE: simulated. No Claude spawn, no Gmail connector. The job is
    // born finished with a result that passes verifyGmailDraftCreated, so the
    // editor shows the normal "saved to Gmail" state. Content goes to the log.
    if (demo) {
      const job = createJob("inquiry", user);
      const fakeId = `r-demo-${randomBytes(8).toString("hex")}`;
      updateJob(job.id, {
        status: "done",
        result: `Draft created (simulated in this demo; nothing was sent to Gmail). Gmail draft id: ${fakeId}`,
        finishedAt: Date.now(),
      });
      log.info("demo", "simulated push to Gmail", {
        user, draftId, to: draft.to_address, cc: draft.cc, subject: draft.subject, body: draft.body.slice(0, 2000),
      });
      return Response.json({ jobId: job.id, draftId, simulated: true });
    }

    const PUSH_FRESHNESS_SEC = 70; // PUSH_TIMEOUT_SEC (60) + 10s grace
    if (draft.push_started_at && draft.push_job_id) {
      const age = Math.floor(Date.now() / 1000) - draft.push_started_at;
      if (age < PUSH_FRESHNESS_SEC) {
        // Existing fresh push still in flight — let the frontend resume that
        // job rather than burning a duplicate spawn.
        return Response.json(
          { jobId: draft.push_job_id, draftId, resumed: true, ageSec: age },
          { status: 409 },
        );
      }
      // Stale (process likely died); clear before starting fresh.
      clearDraftPushing(draftId);
    }

    const draftParams: Record<string, string> = {
      to: draft.to_address,
      subject: draft.subject,
      body: draft.body,
    };
    if (draft.thread_id) draftParams.threadId = draft.thread_id;
    if (draft.cc) draftParams.cc = draft.cc;

    const job = runCommand("inquiry", [
      `Use gmail_create_draft to create a draft. The parameters are the JSON below — pass each field through exactly as-is, do not modify the content:\n${JSON.stringify(draftParams)}\nOnly create the draft and return the creation result.`,
    ]);
    markDraftPushing(draftId, job.id);
    return Response.json({ jobId: job.id, draftId });
  }

  // Mark draft as pushed to Gmail (after Gmail draft creation succeeds).
  // Verify the subprocess result mentions explicit draft creation — subprocess
  // exit 0 alone doesn't prove the gmail_create_draft tool was actually
  // invoked (Claude may have refused, errored mid-turn, or gone silent).
  if (body.action === "markPushed" && body.id) {
    const draftId = body.id as string;
    const result = String(body.result || "");
    const verdict = verifyGmailDraftCreated(result);
    if (!verdict.ok) {
      // Verification failed: clear the marker so the user can retry without
      // hitting the freshness 409. The draft stays in 'draft' status.
      clearDraftPushing(draftId);
      return Response.json({
        error: `Gmail didn't confirm draft creation (${verdict.reason}). Draft stays as a local draft — try Push again.`,
        sample: result.slice(0, 400),
      }, { status: 409 });
    }
    updateDraftStatus(draftId, "pushed");
    clearDraftPushing(draftId);
    return Response.json({ updated: true });
  }

  // Frontend acknowledges a terminal Push to Gmail status (timeout / error)
  // and clears the persisted marker. Same role as ackAi; without this,
  // page-refresh after a failed run would still see "pushing" until the
  // 70s freshness window expired on its own.
  if (body.action === "ackPush" && typeof body.id === "string") {
    clearDraftPushing(body.id);
    return Response.json({ ok: true });
  }

  // Legacy alias: old code called markSent for "pushed to Gmail"
  if (body.action === "markSent" && body.id) {
    updateDraftStatus(body.id as string, "pushed");
    return Response.json({ updated: true });
  }

  // Actually send the email via SMTP
  if (body.action === "sendNow" && body.id) {
    // Defense-in-depth against accidental sends. The frontend always sets
    // userConfirmedDirectSend=true after the modal confirmation; missing this
    // flag means the request didn't go through the proper UI flow.
    if (body.userConfirmedDirectSend !== true) {
      return Response.json({
        error: "userConfirmedDirectSend required — direct sends must be explicitly confirmed by the user",
      }, { status: 400 });
    }
    if (!isSmtpConfigured()) {
      return Response.json({
        error: "SMTP not configured. Set GMAIL_APP_PASSWORD in .env.local. Generate at https://myaccount.google.com/apppasswords (requires 2FA).",
      }, { status: 400 });
    }
    const draftId = body.id as string;
    const draft = getDraftById(draftId);
    if (!draft) return Response.json({ error: "Draft not found" }, { status: 404 });
    // Already sent — terminal state; reject the duplicate. status='sent' is
    // the strongest possible idempotency check (set the moment markDraftSent
    // runs in this same handler).
    if (draft.status === "sent") {
      return Response.json({
        error: "already_sent",
        sentAt: draft.sent_at,
        gmailMessageId: draft.gmail_message_id,
      }, { status: 409 });
    }
    if (!draft.to_address.trim()) return Response.json({ error: "Missing recipient" }, { status: 400 });
    if (!draft.subject.trim()) return Response.json({ error: "Missing subject" }, { status: 400 });
    if (!draft.body.trim()) return Response.json({ error: "Empty body" }, { status: 400 });
    // Short server-side lock around sendEmail. Network retry / multi-tab
    // / a quick re-click after the 10s undo window can land two sendNow
    // POSTs at the SMTP server within seconds — this rejects the second
    // before nodemailer fires. SMTP_SEND_FRESHNESS covers the realistic
    // sendEmail wall time including a slow Gmail handshake.
    const SMTP_SEND_FRESHNESS_SEC = 60;
    if (draft.smtp_send_started_at) {
      const age = Math.floor(Date.now() / 1000) - draft.smtp_send_started_at;
      if (age < SMTP_SEND_FRESHNESS_SEC) {
        return Response.json(
          { error: "send_in_progress", ageSec: age },
          { status: 409 },
        );
      }
      // Stale (probably failed mid-flight before reaching the finally
      // block); clear and proceed with a fresh attempt.
      clearDraftSmtpSending(draftId);
    }
    markDraftSmtpSending(draftId);
    try {
      const attachments = getAttachments(draftId).map((a) => ({ filename: a.filename, path: a.path }));
      const result = await sendEmail({
        to: draft.to_address,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
        attachments,
        includeSignature: body.includeSignature !== false,
      });
      markDraftSent(draftId, result.messageId);
      return Response.json({ sent: true, messageId: result.messageId, accepted: result.accepted });
    } catch (e) {
      console.error("[drafts sendNow] error:", e);
      return Response.json({ error: String(e) }, { status: 500 });
    } finally {
      // Always clear the lock. Success path's markDraftSent already moved
      // status to 'sent' (which is the real idempotency guard going
      // forward); the timestamp itself is just for the in-flight window.
      clearDraftSmtpSending(draftId);
    }
  }

  // Schedule send for future
  if (body.action === "scheduleSend" && body.id && typeof body.sendAt === "number") {
    const draft = getDraftById(body.id as string);
    if (!draft) return Response.json({ error: "Draft not found" }, { status: 404 });
    if (body.sendAt <= Math.floor(Date.now() / 1000)) return Response.json({ error: "Schedule time must be in the future" }, { status: 400 });
    scheduleDraft(draft.id, body.sendAt);
    return Response.json({ scheduled: true, sendAt: body.sendAt });
  }

  // Cancel a scheduled send (back to draft)
  if (body.action === "cancelSchedule" && body.id) {
    updateDraftStatus(body.id as string, "draft");
    return Response.json({ cancelled: true });
  }

  // Retry a draft that tripped the circuit breaker — reset attempts counter
  // and schedule for the next minute so the cron picks it up on the next tick.
  if (body.action === "retryScheduled" && body.id) {
    const nextMinute = Math.floor(Date.now() / 1000) + 30;
    retryFailedDraft(body.id as string, nextMinute);
    return Response.json({ rescheduled: true, sendAt: nextMinute });
  }

  // List failed scheduled drafts — UI surface so the user sees the silent
  // retry loop that previously spun forever.
  if (body.action === "listFailed") {
    const rows = getFailedScheduledDrafts(user);
    return Response.json({ drafts: rows.map(toResponse) });
  }

  // Get signature (for display in editor)
  if (body.action === "getSignature") {
    return Response.json({ signature: getSignature() });
  }

  // ── AI draft generation (no Gmail MCP; direct claude -p spawn) ──
  //
  // 3 branches keyed by shape:
  //   compose:true              → polish a blank/partial new email (composePrompt)
  //   emailId + type=forward    → forward lead-in (forwardPrompt)
  //   emailId (reply default)   → reply to an existing email (replyPrompt)
  //
  // All call generateDraft() → one tool-less `claude -p` run through
  // lib/claude-cli.ts (empty cwd, no MCP). See lib/draft-gen.ts.

  // State-boundary persistence: when draftId is supplied, anchor the
  // generation to the draft so a page refresh during the 120s LLM call
  // resumes the same jobId rather than double-spawning. The 409 guard
  // below short-circuits if a fresh marker still exists — defense in
  // depth even if the frontend forgot to ackAi after a prior run.
  // See docs/design/state-boundary.md.
  const AI_FRESHNESS_SEC = 130; // AI_TIMEOUT_SEC (120) + 10s grace

  function startAiJob(prompt: string, draftId: string | undefined) {
    if (draftId) {
      const existing = getDraftById(draftId);
      if (existing?.ai_generating_started_at) {
        const age = Math.floor(Date.now() / 1000) - existing.ai_generating_started_at;
        if (age < AI_FRESHNESS_SEC && existing.ai_generating_job_id) {
          // A fresh job is still in flight. Surface 409 so the frontend
          // can resume polling that job instead of starting a new one.
          return { conflict: existing.ai_generating_job_id, age };
        }
        // Stale marker — clear before starting fresh.
        clearDraftAiGenerating(draftId);
      }
    }
    const job = generateDraft(prompt, { user });
    if (draftId) markDraftAiGenerating(draftId, job.id);
    return { jobId: job.id };
  }

  // DEMO_MODE: hold the response until the model run finishes so the
  // gateway gets X-Demo-Usage on the request it counted. The editor then
  // polls /api/status and finds the job already done.
  async function aiJobResponse(jobId: string): Promise<Response> {
    if (!demo) return Response.json({ jobId });
    const job = await waitForJob(jobId, AI_FRESHNESS_SEC * 1000);
    return Response.json({ jobId }, { headers: usageHeader(job?.usage ?? EMPTY_USAGE) });
  }

  if (body.action === "aiGenerate" && body.compose === true) {
    const draftSubject = (typeof body.subject === "string" ? body.subject : "").slice(0, 200);
    const draftBody = (typeof body.body === "string" ? body.body : "").slice(0, 2000);
    if (!draftSubject.trim() && !draftBody.trim()) {
      return Response.json({ error: "Empty draft. Write some notes first." }, { status: 400 });
    }
    // draftId is required so the marker path is never silently bypassed
    // (without it, two tabs polishing the same compose burn two spawns).
    // Compose is always invoked from DraftEditor which has just created a
    // draft, so this is a contract not a regression.
    const draftId = typeof body.draftId === "string" ? body.draftId : "";
    if (!draftId) {
      return Response.json({ error: "draftId required" }, { status: 400 });
    }
    const userName = getProfileName(user);
    const prompt = composePrompt({ subject: draftSubject, body: draftBody, userName });
    const r = startAiJob(prompt, draftId);
    if ("conflict" in r) {
      return Response.json({ jobId: r.conflict, resumed: true, ageSec: r.age }, { status: 409 });
    }
    return aiJobResponse(r.jobId);
  }

  if (body.action === "aiGenerate" && body.emailId) {
    const email = getEmailById(body.emailId as string);
    if (!email) return Response.json({ error: "Email not found" }, { status: 404 });

    const userName = getProfileName(user);
    const intent = typeof body.intent === "string" ? body.intent.slice(0, 1000) : "";
    const type = typeof body.type === "string" ? body.type : "reply";
    // draftId is required so 409-resume + ackAi work; see compose branch above.
    const draftId = typeof body.draftId === "string" ? body.draftId : "";
    if (!draftId) {
      return Response.json({ error: "draftId required" }, { status: 400 });
    }

    if (type === "forward") {
      const recipientContext = typeof body.recipientContext === "string"
        ? body.recipientContext.slice(0, 300) : "";
      const prompt = forwardPrompt({ email, intent, recipientContext, userName });
      const r = startAiJob(prompt, draftId);
      if ("conflict" in r) {
        return Response.json({ jobId: r.conflict, resumed: true, ageSec: r.age }, { status: 409 });
      }
      return aiJobResponse(r.jobId);
    }

    // Default: reply (both "reply" and unknown types fall here)
    const threadEmails = getThreadEmails(email.thread_id || "", email.id, 3);
    const prompt = replyPrompt({ email, threadEmails, intent, userName });
    const r = startAiJob(prompt, draftId);
    if ("conflict" in r) {
      return Response.json({ jobId: r.conflict, resumed: true, ageSec: r.age }, { status: 409 });
    }
    return aiJobResponse(r.jobId);
  }

  // Frontend acknowledges a terminal AI Generate status (done/error/timeout)
  // and clears the persisted marker. Without this, a page refresh after
  // completion would still see "generating" until the 130s freshness window
  // elapses on its own.
  if (body.action === "ackAi" && typeof body.id === "string") {
    clearDraftAiGenerating(body.id);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[drafts POST] error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
