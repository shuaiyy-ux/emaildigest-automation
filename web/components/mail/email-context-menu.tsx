"use client";

/**
 * Right-click / long-press context menu for an email thread.
 *
 * Used by:
 *   - MailList (Inbox / Drafts / Jobs view) — triggers on email row right-click
 *   - AIPanel popup card (Dashboard category modal) — triggers on email row right-click
 *
 * The component manages its own jobClassify async state + toast so callers
 * don't need to wire that boilerplate. They only pass the thread + position +
 * category/read-state callbacks.
 *
 * Renders TWO portals to document.body so backdrop-filter parents don't trap
 * the menu inside their own containing block.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { readJson, aiErrorMessage } from "@/lib/demo-client";
import { Eye, EyeOff, Tag, Briefcase, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { CATEGORIES, type Email, type EmailCategory } from "@/lib/types";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { STAGE_LABEL } from "@/lib/job-helpers";
import {
  type Thread,
  threadIsUnread,
  compactSenders,
  threadEmailIds,
} from "@/lib/thread-helpers";

type JobClassifyState =
  | { phase: "idle" }
  | { phase: "pending"; emailId: string; subject: string }
  | { phase: "success"; emailId: string; subject: string; stage: string; company: string; role: string }
  | { phase: "error"; emailId: string; subject: string; error: string };

interface ForceClassifyApiResult {
  ok?: boolean;
  error?: string;
  result?: { stage: string; company: string; role: string };
}

export interface EmailContextMenuProps {
  thread: Thread;
  x: number;
  y: number;
  onCategoryChange?: (thread: Thread, cat: EmailCategory) => void;
  onToggleRead?: (ids: string[], isUnread: boolean) => void;
  onClose: () => void;
}

export function EmailContextMenu({
  thread,
  x,
  y,
  onCategoryChange,
  onToggleRead,
  onClose,
}: EmailContextMenuProps) {
  const isMobile = useIsMobile();
  const [jobClassify, setJobClassify] = useState<JobClassifyState>({ phase: "idle" });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => onClose(), [onClose]);

  const classifyAsJob = useCallback(async (email: Email) => {
    setJobClassify({ phase: "pending", emailId: email.id, subject: email.subject });
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "forceClassifyAsJob", emailId: email.id }),
      });
      const data = await readJson<ForceClassifyApiResult>(res);
      if (!res.ok || !data.ok || !data.result) {
        // 429 from the demo gateway: its message is shown as-is.
        setJobClassify({ phase: "error", emailId: email.id, subject: email.subject, error: aiErrorMessage(res, data, `HTTP ${res.status}`) });
        return;
      }
      setJobClassify({
        phase: "success",
        emailId: email.id,
        subject: email.subject,
        stage: data.result.stage,
        company: data.result.company,
        role: data.result.role,
      });
    } catch (e) {
      setJobClassify({ phase: "error", emailId: email.id, subject: email.subject, error: String(e) });
    }
  }, []);

  // Auto-dismiss success/error toast (success 4s, error 6s — error needs longer read time)
  useEffect(() => {
    if (jobClassify.phase === "success" || jobClassify.phase === "error") {
      const t = setTimeout(() => setJobClassify({ phase: "idle" }), jobClassify.phase === "success" ? 4000 : 6000);
      return () => clearTimeout(t);
    }
  }, [jobClassify]);

  // click-outside / Escape closes menu
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [closeMenu]);

  const latest = thread.latest;
  const hasUnread = threadIsUnread(thread);

  const menuContent = (
    <>
      <div className={`flex items-center gap-1.5 text-muted-foreground ${isMobile ? "px-4 py-2 text-sm font-medium" : "px-1.5 py-1 text-xs font-medium"}`}>
        <Tag className="h-3 w-3" /> Reclassify
        {thread.count > 1 && <span className="ml-auto tabular-nums">{thread.count} emails</span>}
      </div>
      {CATEGORIES.map((cat) => {
        const allMatch = thread.emails.every((e) => e.category === cat.value);
        return (
          <button
            key={cat.value}
            className={cn(
              "relative flex w-full items-center outline-none select-none",
              isMobile ? "px-4 py-3 text-base active:bg-accent"
                : "cursor-default rounded-md px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground",
              allMatch && "text-accent-foreground font-medium"
            )}
            onClick={() => {
              if (!allMatch) onCategoryChange?.(thread, cat.value);
              closeMenu();
            }}
          >
            {cat.label}
            {allMatch && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
          </button>
        );
      })}

      <div className={isMobile ? "my-1 h-px bg-border" : "-mx-1 my-1 h-px bg-border"} />

      <button
        className={cn(
          "flex w-full items-center gap-1.5 outline-none select-none",
          isMobile ? "px-4 py-3 text-base active:bg-accent"
            : "cursor-default rounded-md px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
        )}
        onClick={() => {
          closeMenu();
          // Act on the latest email; resolveApplication Layer A (thread match)
          // will absorb older siblings into the same application card.
          void classifyAsJob(latest);
        }}
      >
        <Briefcase className="h-4 w-4" /> Classify as job
      </button>

      <div className={isMobile ? "my-1 h-px bg-border" : "-mx-1 my-1 h-px bg-border"} />

      <button
        className={cn(
          "flex w-full items-center gap-1.5 outline-none select-none",
          isMobile ? "px-4 py-3 text-base active:bg-accent"
            : "cursor-default rounded-md px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
        )}
        onClick={() => {
          onToggleRead?.(threadEmailIds(thread), !hasUnread);
          closeMenu();
        }}
      >
        {hasUnread
          ? <><Eye className="h-4 w-4" /> Mark {thread.count > 1 ? "all " : ""}as read</>
          : <><EyeOff className="h-4 w-4" /> Mark {thread.count > 1 ? "all " : ""}as unread</>}
      </button>
    </>
  );

  const jobToast = jobClassify.phase === "idle" ? null : (
    <div
      className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 flex items-center gap-2 rounded-full px-4 py-2 text-sm shadow-2xl animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
      style={{
        background: "rgba(20, 20, 20, 0.85)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
      }}
    >
      {jobClassify.phase === "pending" && (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
          <span className="text-foreground/90">Classifying as job…</span>
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">{jobClassify.subject}</span>
        </>
      )}
      {jobClassify.phase === "success" && (
        <>
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span className="text-foreground/90">Added to Job tracker</span>
          {jobClassify.company && <span className="text-foreground/90">{jobClassify.company}</span>}
          {jobClassify.role && <span className="text-xs text-muted-foreground truncate max-w-[200px]">{jobClassify.role}</span>}
          {jobClassify.stage && <span className="text-xs text-muted-foreground">{STAGE_LABEL[jobClassify.stage] || jobClassify.stage}</span>}
          <a href="/jobs" className="text-xs text-primary underline underline-offset-2">View board</a>
        </>
      )}
      {jobClassify.phase === "error" && (
        <>
          <AlertCircle className="h-4 w-4 text-red-400" />
          <span className="text-foreground/90">Classification failed</span>
          <span className="text-xs text-muted-foreground truncate max-w-[240px]">{jobClassify.error}</span>
        </>
      )}
    </div>
  );

  if (typeof document === "undefined") return null;

  return (
    <>
      {/* Desktop: floating panel at click coords. z-[70] sits above the popup
          card backdrop (z-40) and modal (z-50). */}
      {!isMobile && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[70] w-[280px] rounded-xl shadow-2xl animate-in fade-in-0 zoom-in-95 duration-100 overflow-hidden"
          style={{
            top: y,
            left: x,
            background: "rgba(20, 20, 20, 0.72)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div className="px-4 py-3">
            <p className="text-sm font-medium truncate">{thread.latest.subject}</p>
            <p className="flex gap-3 text-xs text-muted-foreground mt-0.5">
              <span className="truncate">{compactSenders(thread)}</span>
              {thread.count > 1 && <span className="shrink-0 tabular-nums">{thread.count} emails</span>}
            </p>
          </div>
          <div className="h-px bg-white/10" />
          <div className="p-2">{menuContent}</div>
        </div>,
        document.body
      )}

      {/* Mobile: bottom sheet */}
      {isMobile && createPortal(
        <>
          <div className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" onClick={closeMenu} />
          <div
            ref={menuRef}
            className="fixed bottom-2 left-2 right-2 z-[70] rounded-2xl shadow-2xl animate-in slide-in-from-bottom duration-200 safe-area-pb overflow-hidden"
            style={{
              background: "rgba(20, 20, 20, 0.78)",
              backdropFilter: "blur(24px) saturate(180%)",
              WebkitBackdropFilter: "blur(24px) saturate(180%)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
            }}
          >
            <div className="flex justify-center py-2">
              <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="px-5 pb-3">
              <p className="text-sm font-medium truncate">{thread.latest.subject}</p>
              <p className="flex gap-3 text-xs text-muted-foreground mt-0.5">
                <span className="truncate">{compactSenders(thread)}</span>
                {thread.count > 1 && <span className="shrink-0 tabular-nums">{thread.count} emails</span>}
              </p>
            </div>
            <div className="h-px bg-white/10" />
            <div className="p-2 pb-4">{menuContent}</div>
          </div>
        </>,
        document.body
      )}

      {jobToast && createPortal(jobToast, document.body)}
    </>
  );
}
