"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Sparkles, Loader2, X, CheckCircle2, AlertCircle, SendHorizonal, Paperclip, Clock, Maximize2, Minimize2, CloudUpload, MessageSquarePlus, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Hint } from "@/components/ui/hint";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { pollJob } from "@/lib/hooks/useJob";
import { parseJsonObject } from "@/lib/parse";
import { cn } from "@/lib/utils";
import { readJson, aiErrorMessage } from "@/lib/demo-client";
import { useDemo } from "@/components/demo/demo-context";
import type { Draft, DraftType } from "@/lib/types";

const AI_TIMEOUT_SEC = 120;
const PUSH_TIMEOUT_SEC = 60;
const PUSHED_AUTO_CLOSE_MS = 5000;

type DraftEditorProps = {
  onClose: () => void;
  onSent?: () => void;
} & (
  | { emailId: string; type: DraftType; initialDraft?: never }
  | { initialDraft: Draft; emailId?: never; type?: never }
  | { compose: true; emailId?: never; type?: never; initialDraft?: never }
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTOSAVE_MS = 2000;
const UNDO_SEND_MS = 10000;
// Regex to detect "attachment" mentions in body (missing attachment check)
const ATTACH_WORDS_RE = /(attach(ed|ment)?|附件|请见附件|查收|see the attached|enclosed)/i;

interface AttachmentInfo {
  id: number;
  filename: string;
  size: number;
  mimeType: string;
}

interface Contact { email: string; name: string; count: number }

function validateEmails(value: string): boolean {
  if (!value.trim()) return true;
  return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean).every((e) => EMAIL_RE.test(e));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Strip text-art chrome (ASCII separators, "> " line prefixes) from the
 * quoted block for display purposes. The actual stored/sent quote keeps
 * these conventions so recipients' email clients recognize the citation.
 */
function cleanQuoteForDisplay(quote: string): string {
  return quote
    .replace(/^\n+/, "")                          // leading blank lines
    .replace(/^---+\n/, "")                       // reply separator ---
    .replace(/^-{6,} Forwarded message -{6,}\n/, "")  // forward separator
    .replace(/^> /gm, "")                         // line-start > quote prefix
    .trim();
}

function localDateTimeValue(timestamp?: number): string {
  const d = timestamp ? new Date(timestamp * 1000) : new Date(Date.now() + 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DraftEditor({ onClose, onSent, ...props }: DraftEditorProps) {
  const isMobile = useIsMobile();
  // DEMO_MODE simulates Send, Schedule and Save to Gmail server-side
  // (lib/smtp.ts, app/api/drafts); the result states say so.
  const demo = useDemo();
  const [draft, setDraft] = useState<Draft | null>(props.initialDraft || null);
  const [loading, setLoading] = useState(!props.initialDraft);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiIntent, setAiIntent] = useState("");            // optional: user's intent for this reply/forward
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Form state
  const [to, setTo] = useState(props.initialDraft?.to || "");
  const [cc, setCc] = useState(props.initialDraft?.cc || "");
  const [bcc, setBcc] = useState(props.initialDraft?.bcc || "");
  const [subject, setSubject] = useState(props.initialDraft?.subject || "");
  const [body, setBody] = useState(props.initialDraft?.body || "");
  const lastInitId = useRef<string | null>(props.initialDraft?.id || null);
  const [showCc, setShowCc] = useState(!!props.initialDraft?.cc || props.type === "forward");
  const [showBcc, setShowBcc] = useState(!!props.initialDraft?.bcc);

  // Contacts
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [toSuggestions, setToSuggestions] = useState<Contact[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);

  // Attachments
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Signature
  const [signature, setSignature] = useState("");
  const [includeSignature, setIncludeSignature] = useState(true);

  // Send state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Schedule
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTime, setScheduleTime] = useState(localDateTimeValue());
  const [scheduled, setScheduled] = useState(false);

  // Autosave
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCompose = "compose" in props && props.compose;
  const emailId = props.initialDraft?.emailId || ("emailId" in props ? props.emailId : undefined);
  const draftType = (props.initialDraft?.type as DraftType) || ("type" in props ? props.type : undefined) || (isCompose ? "new" : "reply");
  const toValid = validateEmails(to);
  const ccValid = validateEmails(cc);
  const bccValid = validateEmails(bcc);
  const canSend = to.trim().length > 0 && toValid && ccValid && bccValid && body.trim().length > 0;

  // Split body into editable user-portion + quoted/forwarded block.
  // The quote block is always at the tail of body (generated server-side
  // when the draft is created). We show it separately in the UI so the
  // raw `> ` prefixes and "On X wrote:" chrome don't clutter the writing
  // surface. Storage and send-time behavior are unchanged.
  const { userPart, quotedPart } = useMemo(() => {
    const replyIdx = body.indexOf("\n\n---\nOn ");
    const fwdIdx = body.indexOf("\n\n---------- Forwarded message");
    const candidates = [replyIdx, fwdIdx].filter((i) => i >= 0);
    if (candidates.length === 0) return { userPart: body, quotedPart: "" };
    const idx = Math.min(...candidates);
    return { userPart: body.slice(0, idx), quotedPart: body.slice(idx) };
  }, [body]);

  // Forgot attachment check: body mentions attachment but none uploaded
  const forgotAttachment = ATTACH_WORDS_RE.test(body) && attachments.length === 0;

  // Load contacts + signature once
  useEffect(() => {
    fetch("/api/contacts").then((r) => r.json()).then((d) => setContacts(d.contacts || [])).catch(() => {});
    fetch("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "getSignature" }) })
      .then((r) => r.json()).then((d) => setSignature(d.signature || "")).catch(() => {});
  }, []);

  // Create draft on mount (only when creating new)
  useEffect(() => {
    if (props.initialDraft) return;
    const isCompose = "compose" in props && props.compose;
    const eid = isCompose ? undefined : props.emailId;
    const key = isCompose ? "__compose__" : eid;
    if (!key || lastInitId.current === key) return;
    lastInitId.current = key;
    const payload = isCompose
      ? { action: "create", type: "new" }
      : { action: "create", emailId: eid, type: props.type };
    fetch("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.draft) {
          const d = data.draft as Draft;
          setDraft(d);
          setTo(d.to); setCc(d.cc); setBcc(d.bcc); setSubject(d.subject); setBody(d.body);
          if (d.cc) setShowCc(true);
          if (d.bcc) setShowBcc(true);
        }
      })
      .finally(() => setLoading(false));
  }, [props]);

  // Load attachments when draft exists
  useEffect(() => {
    if (!draft?.id) return;
    fetch(`/api/drafts/${draft.id}/attachments`).then((r) => r.json()).then((d) => setAttachments(d.attachments || [])).catch(() => {});
  }, [draft?.id]);

  // Autosave
  const saveDraft = useCallback(async () => {
    if (!draft) return;
    setSaveStatus("saving");
    await fetch("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: draft.id, to, cc, bcc, subject, body }),
    });
    setSaveStatus("saved");
  }, [draft, to, cc, bcc, subject, body]);

  useEffect(() => {
    if (!draft || loading) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setSaveStatus("idle");
    autosaveTimer.current = setTimeout(() => { saveDraft(); }, AUTOSAVE_MS);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [to, cc, bcc, subject, body, draft, loading, saveDraft]);

  // To field autocomplete
  const handleToChange = (value: string) => {
    setTo(value);
    const last = value.split(/[,;]/).pop()?.trim().toLowerCase() || "";
    if (last.length >= 2) {
      const matches = contacts
        .filter((c) => c.email.toLowerCase().includes(last) || c.name.toLowerCase().includes(last))
        .slice(0, 5);
      setToSuggestions(matches);
      setShowSuggest(matches.length > 0);
    } else {
      setShowSuggest(false);
    }
  };

  const applySuggestion = (contact: Contact) => {
    const parts = to.split(/[,;]/);
    parts[parts.length - 1] = ` ${contact.email}`;
    setTo(parts.join(",").trim().replace(/^,\s*/, ""));
    setShowSuggest(false);
  };

  // Attachments
  const uploadFile = useCallback(async (file: File) => {
    if (!draft) return;
    // Client-side size check (server buffers limit to 10MB)
    if (file.size > 10 * 1024 * 1024) {
      setSendError(`${file.name} exceeds the 10 MB limit. Save as a Gmail draft to attach larger files.`);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/drafts/${draft.id}/attachments`, { method: "POST", body: fd });
      if (!res.ok) {
        const d = await readJson(res);
        setSendError(aiErrorMessage(res, d, `Upload failed (${res.status})`));
        return;
      }
      const data = await res.json();
      if (data.attachment) setAttachments((prev) => [...prev, data.attachment]);
      else if (data.error) setSendError(data.error);
    } catch (e) {
      setSendError(String(e));
    } finally { setUploading(false); }
  }, [draft]);

  const removeAttachment = useCallback(async (id: number) => {
    if (!draft) return;
    await fetch(`/api/drafts/${draft.id}/attachments?attachmentId=${id}`, { method: "DELETE" });
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, [draft]);

  // Drain a polling result + tell backend the AI marker can be cleared.
  // Shared between fresh aiGenerate runs and resume-on-mount.
  // Backend ackAi clears `ai_generating_started_at` so a future F5 doesn't
  // see "still generating" after a finished run.
  const consumeAiResult = useCallback(
    async (jobId: string, draftIdForAck: string | null) => {
      try {
        const result = await pollJob(jobId, { timeoutSec: AI_TIMEOUT_SEC });
        if (result.status === "timeout") {
          setAiError("Generation timed out, please try again");
        } else if (result.status === "error") {
          setAiError(result.error || "Generation failed, please try again");
        } else if (result.status === "done" && result.result) {
          if (isCompose) {
            const parsed = parseJsonObject<{ subject: string; body: string }>(result.result);
            if (!parsed || typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
              setAiError("Unable to parse AI response, please try again");
            } else {
              setSubject(parsed.subject);
              setBody(parsed.body);
            }
          } else {
            const aiBody = result.result.trim();
            const quoteSep = body.indexOf("\n\n---\n");
            const fwdSep = body.indexOf("\n\n---------- Forwarded message");
            const sepIdx = quoteSep !== -1 ? quoteSep : fwdSep;
            setBody(sepIdx !== -1 ? aiBody + body.slice(sepIdx) : aiBody);
          }
        }
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(false);
        if (draftIdForAck) {
          fetch("/api/drafts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "ackAi", id: draftIdForAck }),
          }).catch(() => {});
        }
      }
    },
    [isCompose, body],
  );

  // AI generate: polish compose draft (compose mode) OR generate reply (reply/forward mode)
  const aiGenerate = useCallback(async () => {
    if (!draft) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const payload = isCompose
        ? { action: "aiGenerate", compose: true, subject, body, draftId: draft.id }
        : {
            action: "aiGenerate",
            emailId: emailId || "",
            type: draftType,                    // "reply" | "forward"
            intent: aiIntent.trim() || undefined,
            draftId: draft.id,
          };
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson<{ jobId?: string }>(res);
      // 409 = draft already has a fresh in-flight job. The response carries
      // the existing jobId; resume polling instead of double-spawning. This
      // is the F5-after-click race the persistence hook was designed for.
      if (res.status === 409 && data.jobId) {
        await consumeAiResult(data.jobId, draft.id);
        return;
      }
      if (!res.ok || data.error) {
        // 429 from the demo gateway: its message is shown as-is.
        setAiError(aiErrorMessage(res, data, "Generation failed, please try again"));
        setAiLoading(false);
        return;
      }
      if (!data.jobId) {
        setAiLoading(false);
        return;
      }
      await consumeAiResult(data.jobId, draft.id);
    } catch (e) {
      setAiError(String(e));
      setAiLoading(false);
    }
  }, [isCompose, emailId, subject, body, draftType, aiIntent, draft, consumeAiResult]);

  // F5-recovery: if the draft we mounted with already has a fresh
  // ai_generating marker, resume polling that jobId. Without this we'd
  // either show "ready" (lying — backend is still working) or the user
  // would re-click and double-spawn.
  useEffect(() => {
    if (!draft) return;
    const startedAt = draft.ai_generating_started_at;
    const jobId = draft.ai_generating_job_id;
    if (!startedAt || !jobId) return;
    const ageSec = Math.floor(Date.now() / 1000) - startedAt;
    if (ageSec >= AI_TIMEOUT_SEC + 10) {
      // Stale (job almost certainly already finished or died). Best-effort
      // cleanup; user can click Sparkles again.
      fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ackAi", id: draft.id }),
      }).catch(() => {});
      return;
    }
    setAiLoading(true);
    consumeAiResult(jobId, draft.id);
    // We only want this to fire on mount (per-draft).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id]);

  // Drain a polling result for Push to Gmail. Shared between fresh
  // pushToGmail clicks and resume-on-mount when we land on a draft that
  // already has a fresh push marker. Runs markPushed on success (which both
  // flips status and clears the marker server-side), or ackPush on terminal
  // failure (so the freshness window doesn't keep blocking retries).
  const consumePushResult = useCallback(
    async (jobId: string, draftIdForAck: string) => {
      try {
        const result = await pollJob(jobId, { timeoutSec: PUSH_TIMEOUT_SEC });
        if (result.status === "done") {
          const markRes = await fetch("/api/drafts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "markPushed", id: draftIdForAck, result: result.result || "" }),
          });
          if (!markRes.ok) {
            const e = await markRes.json().catch(() => ({}));
            setPushError(e.error || "Gmail did not confirm the draft. Try again.");
          } else {
            setPushed(true);
            onSent?.();
          }
        } else if (result.status === "timeout") {
          setPushError("Saving to Gmail timed out. Try again.");
        } else if (result.status === "error") {
          setPushError(result.error || "Saving to Gmail failed. Try again.");
        }
        if (result.status !== "done") {
          // Clear the marker so the freshness window doesn't keep blocking
          // a retry. (Success path's markPushed already cleared it.)
          fetch("/api/drafts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "ackPush", id: draftIdForAck }),
          }).catch(() => {});
        }
      } catch (e) {
        setPushError(String(e));
      } finally {
        setPushing(false);
      }
    },
    [onSent],
  );

  const pushToGmail = useCallback(async () => {
    if (!draft) return;
    await saveDraft();
    setPushing(true);
    setPushError(null);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pushToGmail", id: draft.id }),
      });
      const data = await res.json();
      // 409 = draft already has a fresh in-flight push job (e.g. user
      // clicked, F5'd, and re-clicked). Resume polling rather than
      // double-spawning gmail_create_draft.
      if (res.status === 409 && data.jobId) {
        await consumePushResult(data.jobId, draft.id);
        return;
      }
      if (!res.ok || !data.jobId) {
        setPushError(data.error || "Failed to start push, please try again");
        setPushing(false);
        return;
      }
      await consumePushResult(data.jobId, draft.id);
    } catch (e) {
      setPushError(String(e));
      setPushing(false);
    }
  }, [draft, saveDraft, consumePushResult]);

  // F5-recovery for Push to Gmail: if the loaded draft already has a fresh
  // push marker, resume polling that jobId. Symmetric with the AI Generate
  // mount-effect above.
  useEffect(() => {
    if (!draft) return;
    const startedAt = draft.push_started_at;
    const jobId = draft.push_job_id;
    if (!startedAt || !jobId) return;
    const ageSec = Math.floor(Date.now() / 1000) - startedAt;
    if (ageSec >= PUSH_TIMEOUT_SEC + 10) {
      // Stale — best-effort cleanup so the next click isn't blocked by a
      // dead marker.
      fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ackPush", id: draft.id }),
      }).catch(() => {});
      return;
    }
    setPushing(true);
    consumePushResult(jobId, draft.id);
    // Per-draft mount-only resume; same dep pattern as the AI marker effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id]);

  // Auto-close after pushed badge shown (per memory: transparency + non-stuck UI)
  useEffect(() => {
    if (!pushed) return;
    const t = setTimeout(() => onClose(), PUSHED_AUTO_CLOSE_MS);
    return () => clearTimeout(t);
  }, [pushed, onClose]);

  const startSend = useCallback(() => {
    setConfirmOpen(false);
    setSending(true);
    setSendError(null);
    setUndoSecondsLeft(Math.ceil(UNDO_SEND_MS / 1000));
    undoCountdownRef.current = setInterval(() => setUndoSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    undoTimerRef.current = setTimeout(async () => {
      if (undoCountdownRef.current) clearInterval(undoCountdownRef.current);
      if (!draft) return;
      try {
        await saveDraft();
        const res = await fetch("/api/drafts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sendNow",
            id: draft.id,
            includeSignature,
            userConfirmedDirectSend: true,  // user passed confirm modal
          }),
        });
        const data = await res.json();
        if (data.sent) { setSent(true); onSent?.(); }
        else setSendError(data.error || "Send failed");
      } catch (e) { setSendError(String(e)); }
      finally { setSending(false); }
    }, UNDO_SEND_MS);
  }, [draft, saveDraft, onSent, includeSignature]);

  const cancelSend = useCallback(() => {
    if (undoTimerRef.current) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null; }
    if (undoCountdownRef.current) { clearInterval(undoCountdownRef.current); undoCountdownRef.current = null; }
    setSending(false);
    setUndoSecondsLeft(0);
  }, []);

  const scheduleSend = useCallback(async () => {
    if (!draft) return;
    await saveDraft();
    const sendAt = Math.floor(new Date(scheduleTime).getTime() / 1000);
    const res = await fetch("/api/drafts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scheduleSend", id: draft.id, sendAt }),
    });
    const data = await res.json();
    if (data.scheduled) { setScheduled(true); setScheduleOpen(false); onSent?.(); }
    else setSendError(data.error || "Schedule failed");
  }, [draft, saveDraft, scheduleTime, onSent]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (undoCountdownRef.current) clearInterval(undoCountdownRef.current);
  }, []);

  const discard = useCallback(async () => {
    if (draft) {
      await fetch("/api/drafts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discard", id: draft.id }),
      });
    }
    onClose();
  }, [draft, onClose]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (canSend && !sending && !sent && !confirmOpen) setConfirmOpen(true);
      } else if (e.key === "Escape" && !confirmOpen && !scheduleOpen && !sending) {
        if (fullscreen) setFullscreen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canSend, sending, sent, confirmOpen, scheduleOpen, fullscreen, onClose]);

  if (loading) {
    return (
      <div className="p-4 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> <span className="text-sm">Preparing {draftType}…</span>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="p-4 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        <Badge variant="outline" className="text-[10px]">{demo ? "Send simulated, nothing was emailed" : "Email sent"}</Badge>
        <Button variant="ghost" size="sm" className="ml-2 h-6 text-xs" onClick={onClose}>Close</Button>
      </div>
    );
  }

  if (scheduled) {
    return (
      <div className="p-4 flex items-center gap-2">
        <Clock className="h-4 w-4 text-blue-500" />
        <Badge variant="outline" className="text-[10px]">
          {demo ? "Simulated send scheduled for" : "Send scheduled for"} {new Date(scheduleTime).toLocaleString("en-US")}
        </Badge>
        <Button variant="ghost" size="sm" className="ml-2 h-6 text-xs" onClick={onClose}>Close</Button>
      </div>
    );
  }

  if (pushed) {
    return (
      <div className="p-4 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        <Badge variant="outline" className="text-[10px]">{demo ? "Gmail save simulated, nothing was sent to Gmail" : "Draft saved to Gmail"}</Badge>
        <span className="text-[10px] text-muted-foreground/70">Closing…</span>
        <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" onClick={onClose}>Close now</Button>
      </div>
    );
  }

  const fieldInputCls = isMobile
    ? "h-9 text-sm border-0 bg-transparent focus-visible:ring-0 px-2"
    : "h-8 text-sm border-0 bg-transparent focus-visible:ring-0 px-2";
  const labelCls = "text-[12px] text-muted-foreground/70 shrink-0 w-16";

  // fullscreen overlay extends edge-to-edge under iOS notch in standalone PWA;
  // pt-safe drops the header below the status bar / dynamic island.
  const containerCls = fullscreen
    ? "fixed inset-0 z-40 bg-background flex flex-col pt-safe"
    : `flex flex-col flex-1 min-h-0 ${props.initialDraft ? "" : "border-t border-border"}`;

  const iconBtn = "inline-flex items-center justify-center h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none";

  return (
    <div className={containerCls}>
      {/* Header */}
      <div className={`flex items-center gap-2 border-b border-border/60 shrink-0 ${isMobile ? "px-4 py-2.5" : "px-5 py-2.5"}`}>
        <Badge variant="outline" className="text-[10px] font-medium border-border/60">
          {draftType === "reply" ? "Reply" : draftType === "forward" ? "Forward" : "New"}
        </Badge>
        <span className="text-[11px] text-muted-foreground/80 flex-1 flex items-center gap-1.5">
          {saveStatus === "saving" ? (<><Loader2 className="h-3 w-3 animate-spin" /> Saving</>)
            : saveStatus === "saved" ? (<><CheckCircle2 className="h-3 w-3 text-green-500/80" /> Saved</>)
            : <span className="opacity-60">Draft</span>}
        </span>
        {!isMobile && (
          <Hint label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
            <button onClick={() => setFullscreen((v) => !v)}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </Hint>
        )}
        <Hint label="Discard (Esc)">
          <button onClick={discard}
            className={`${isMobile ? "h-8 w-8" : "h-7 w-7"} inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors`}>
            <X className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
          </button>
        </Hint>
      </div>

      {/* Fields — each row has subtle bottom divider */}
      <div className={`shrink-0 ${isMobile ? "px-4" : "px-5"}`}>
        <div className="flex items-center gap-3 relative border-b border-border/40 py-1.5">
          <span className={labelCls}>To</span>
          <Input
            value={to}
            onChange={(e) => handleToChange(e.target.value)}
            onBlur={() => setTimeout(() => setShowSuggest(false), 200)}
            className={`${fieldInputCls} ${to.trim() && !toValid ? "text-destructive" : ""}`}
            placeholder="recipient@example.com"
          />
          <div className="flex gap-2 shrink-0">
            {!showCc && <button type="button" onClick={() => setShowCc(true)} className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors">Cc</button>}
            {!showBcc && <button type="button" onClick={() => setShowBcc(true)} className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors">Bcc</button>}
          </div>
          {showSuggest && toSuggestions.length > 0 && (
            <div className="absolute top-full left-16 right-0 mt-1 z-10 rounded-lg overflow-hidden shadow-2xl max-h-60 overflow-y-auto"
              style={{ background: "rgba(20,20,20,0.85)", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.08)" }}>
              {toSuggestions.map((c) => (
                <button key={c.email} onClick={() => applySuggestion(c)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 text-xs transition-colors">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-muted-foreground truncate text-[11px]">{c.email}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        {showCc && (
          <div className="flex items-center gap-3 border-b border-border/40 py-1.5">
            <span className={labelCls}>Cc</span>
            <Input value={cc} onChange={(e) => setCc(e.target.value)} className={`${fieldInputCls} ${cc && !ccValid ? "text-destructive" : ""}`} />
            <button type="button" onClick={() => { setShowCc(false); setCc(""); }} className="text-muted-foreground/50 hover:text-foreground shrink-0">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {showBcc && (
          <div className="flex items-center gap-3 border-b border-border/40 py-1.5">
            <span className={labelCls}>Bcc</span>
            <Input value={bcc} onChange={(e) => setBcc(e.target.value)} className={`${fieldInputCls} ${bcc && !bccValid ? "text-destructive" : ""}`} />
            <button type="button" onClick={() => { setShowBcc(false); setBcc(""); }} className="text-muted-foreground/50 hover:text-foreground shrink-0">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex items-center gap-3 border-b border-border/40 py-1.5">
          <span className={labelCls}>Subject</span>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} className={fieldInputCls} placeholder="No subject" />
        </div>
      </div>

      {/* Body — split into editable user portion + collapsible quoted/forwarded block.
          The DB stores the full concatenated string (body); the split is purely
          presentational. This matches how Gmail / Apple Mail hide the citation
          chrome from the active editing surface while still sending it along. */}
      <div className={`flex-1 overflow-auto ${isMobile ? "px-4 pt-8" : "px-5 pt-8"}`}>
        <Textarea
          value={userPart}
          onChange={(e) => setBody(e.target.value + quotedPart)}
          className={`border-0 bg-transparent focus-visible:ring-0 resize-none px-2 py-0 leading-relaxed ${isMobile ? "min-h-[200px] text-base" : "min-h-[140px] text-sm"}`}
          placeholder="Write your message…"
        />
        {quotedPart && (
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setQuoteExpanded((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors px-2 py-1 rounded-md hover:bg-white/[.03]"
            >
              {quoteExpanded
                ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                : <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />}
              {draftType === "forward" ? "Forwarded message" : "Original message"}
            </button>
            {quoteExpanded && (
              <div
                className="mt-2 ml-2 pl-3 py-1 border-l-2 border-[var(--accent-blue)]/30
                           text-[12.5px] text-muted-foreground/70 leading-relaxed
                           whitespace-pre-wrap font-mono"
              >
                {cleanQuoteForDisplay(quotedPart)}
              </div>
            )}
          </div>
        )}
        {signature && includeSignature && (
          <div className="text-xs text-muted-foreground/60 whitespace-pre-wrap pt-3 border-t border-border/30 mt-4">
            {signature}
          </div>
        )}
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className={`shrink-0 flex flex-wrap gap-1.5 ${isMobile ? "px-4 py-2" : "px-5 py-2"} border-t border-border/40`}>
          {attachments.map((a) => (
            <div key={a.id} className="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <Paperclip className="h-3 w-3 text-muted-foreground" />
              <span className="truncate max-w-[180px]">{a.filename}</span>
              <span className="text-muted-foreground text-[10px]">{formatBytes(a.size)}</span>
              <button onClick={() => removeAttachment(a.id)} className="text-muted-foreground/50 hover:text-destructive transition-colors">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Warnings */}
      {to.trim() && !toValid && (
        <div className={`${isMobile ? "px-4" : "px-5"} py-1 flex items-center gap-1.5 text-[11px] text-destructive`}>
          <AlertCircle className="h-3 w-3" /> Invalid recipient email
        </div>
      )}

      {/* Actions — primary Send | utility icons.
          Mobile uses pb-safe-3 (= py-3 baseline + iOS safe-inset-bottom) so
          the action bar has breathing room in browser AND clears the home
          indicator in standalone PWA mode. */}
      <div className={`flex items-center gap-1.5 shrink-0 ${isMobile ? "px-4 pt-3 pb-safe-3 border-t border-border/60" : "px-5 py-3 border-t border-border/60"}`}>
        <Hint label="Send email (⌘↵)">
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={!canSend || sending}
            className={`${isMobile ? "h-10 flex-1" : "h-9"} inline-flex items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-foreground transition-all disabled:opacity-30 disabled:pointer-events-none`}
            style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.04) 100%)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
            }}
          >
            <SendHorizonal className="h-4 w-4" /> Send
          </button>
        </Hint>

        <div className="flex-1" />

        <input type="file" ref={fileInputRef} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />

        <Hint label="Schedule send">
          <button onClick={() => setScheduleOpen(true)} disabled={!canSend} className={iconBtn}>
            <Clock className="h-4 w-4" />
          </button>
        </Hint>
        <Hint label="Attach file">
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading || !draft} className={iconBtn}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
        </Hint>
        <Hint label={pushing ? "Saving to Gmail…" : "Save as Gmail draft"}>
          <button onClick={pushToGmail} disabled={pushing || !to.trim() || !body.trim()} className={iconBtn}>
            {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
          </button>
        </Hint>
        <Hint label={aiLoading ? (isCompose ? "Polishing" : draftType === "forward" ? "Generating forward" : "Generating reply") : (isCompose ? "Polish with AI" : draftType === "forward" ? "Generate forward note with AI" : "Generate reply with AI")}>
          <button
            onClick={aiGenerate}
            disabled={aiLoading || (!emailId && !isCompose) || (isCompose && !subject.trim() && !body.trim())}
            className={iconBtn}
          >
            {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          </button>
        </Hint>
      </div>

      {/* AI intent strip — reply/forward only.
          Design: utility row in glass idiom. Accent-blue icon signals "feeds the AI".
          Small sentence-case label, same as the To/Subject field labels.
          focus-within tints row with transparent accent-blue, mirroring the Ask AI input.
          No keyboard shortcut here — Cmd/Ctrl+Enter is reserved project-wide for Send.
          To generate, click the Sparkles button in the toolbar above. */}
      {!isCompose && emailId && (
        <div
          className={cn(
            "shrink-0 flex items-center gap-2.5 border-t border-white/[0.06]",
            "transition-colors duration-300",
            "focus-within:bg-[rgba(122,183,255,0.04)]",
            isMobile ? "px-4 py-2.5" : "px-5 py-2.5",
          )}
        >
          <MessageSquarePlus className="h-4 w-4 text-[var(--accent-blue)]/70 shrink-0" strokeWidth={2.2} />
          <span className="hidden sm:inline text-[12px] text-muted-foreground/60 shrink-0">
            Intent
          </span>
          <Input
            value={aiIntent}
            onChange={(e) => setAiIntent(e.target.value)}
            placeholder={draftType === "forward" ? "Why forward this?" : "What do you want to say?"}
            className="h-8 text-[13px] border-0 bg-transparent shadow-none focus-visible:ring-0 px-0 placeholder:text-muted-foreground/45"
            disabled={aiLoading}
          />
          <button
            type="button"
            onClick={aiGenerate}
            disabled={aiLoading}
            className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px]
                       border border-[rgba(122,183,255,0.22)]
                       bg-[rgba(122,183,255,0.08)] hover:bg-[rgba(122,183,255,0.14)]
                       text-[11px] font-medium text-[var(--accent-blue)]
                       transition-all duration-200
                       disabled:opacity-40 disabled:pointer-events-none
                       hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(122,183,255,0.18)]"
          >
            {aiLoading
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Sparkles className="h-3 w-3" strokeWidth={2.2} />}
            Generate
          </button>
        </div>
      )}

      {/* Inline progress strip */}
      {(aiLoading || pushing) && (
        <div className={`shrink-0 flex items-center gap-2 ${isMobile ? "px-4 py-2" : "px-5 py-2"} border-t border-border/40 text-xs text-muted-foreground`}>
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          <span className="flex-1 truncate">
            {aiLoading ? (isCompose ? "Polishing…" : draftType === "forward" ? "Generating forward…" : "Generating reply…") : "Saving to Gmail…"}
          </span>
        </div>
      )}

      {/* Confirm Send Modal */}
      {confirmOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setConfirmOpen(false)}>
            <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-semibold">Send email?</h3>
              <div className="space-y-2 text-sm">
                <div className="flex gap-2"><span className="text-muted-foreground w-14 shrink-0">To</span><span className="truncate">{to}</span></div>
                {cc && <div className="flex gap-2"><span className="text-muted-foreground w-14 shrink-0">Cc</span><span className="truncate">{cc}</span></div>}
                {bcc && <div className="flex gap-2"><span className="text-muted-foreground w-14 shrink-0">Bcc</span><span className="truncate">{bcc}</span></div>}
                <div className="flex gap-2"><span className="text-muted-foreground w-14 shrink-0">Subject</span><span className="truncate">{subject || <span className="italic text-muted-foreground">Empty</span>}</span></div>
                {attachments.length > 0 && (
                  <div className="flex gap-2"><span className="text-muted-foreground w-14 shrink-0">Files</span><span className="truncate">{attachments.length} attached</span></div>
                )}
              </div>
              {!subject.trim() && (<div className="flex items-center gap-1.5 text-xs text-amber-500"><AlertCircle className="h-3 w-3" /> Subject is empty</div>)}
              {forgotAttachment && (<div className="flex items-center gap-1.5 text-xs text-amber-500"><AlertCircle className="h-3 w-3" /> Body mentions an attachment, none attached</div>)}
              {signature && (
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="checkbox" checked={includeSignature} onChange={(e) => setIncludeSignature(e.target.checked)} />
                  Include signature
                </label>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={startSend}><SendHorizonal className="h-3.5 w-3.5 mr-1.5" /> Send</Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Schedule modal */}
      {scheduleOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setScheduleOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setScheduleOpen(false)}>
            <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-semibold">Schedule send</h3>
              <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)}
                className="w-full h-10 px-3 bg-background border border-border rounded-md text-sm" />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setScheduleOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={scheduleSend}><Clock className="h-3.5 w-3.5 mr-1.5" /> Schedule</Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Undo Send banner */}
      {sending && undoSecondsLeft > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-foreground text-background rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Sending in {undoSecondsLeft}s</span>
          <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={cancelSend}>Undo</Button>
        </div>
      )}

      {aiError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 max-w-md">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{aiError}</span>
          <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={() => setAiError(null)}>Dismiss</Button>
        </div>
      )}

      {sendError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 max-w-md">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{sendError}</span>
          <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={() => setSendError(null)}>Dismiss</Button>
        </div>
      )}

      {pushError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 max-w-md">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{pushError}</span>
          <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={() => setPushError(null)}>Dismiss</Button>
        </div>
      )}
    </div>
  );
}
