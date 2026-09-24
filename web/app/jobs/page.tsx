"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Briefcase, AlertCircle, X, Clock, Mail, Trash2, Send, Hourglass, GitMerge, Split, Check, ChevronRight, Tag } from "lucide-react";
import { EmailSidePanel } from "@/components/mail/email-side-panel";
import { CompanyNameNote } from "@/components/demo/demo-marks";
import { formatEmailDate } from "@/lib/email-date";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  COLUMN_ORDER, COLUMN_LABEL, COLUMN_COLOR, COLUMN_HEADER_COLOR,
  STAGE_LABEL, ALL_STAGES, PRIORITY_COLOR, ACTION_LABEL,
  formatDeadline, formatRelative, stageToColumn, isSilentThread, daysSinceLastEmail,
  type JobColumn,
} from "@/lib/job-helpers";

interface AppEmail {
  emailId: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  date: string;
  receivedAt: number;
  threadId: string;
  isUnread: boolean;
  stage: string;
  needsAction: boolean;
  actionType: string;
  priority: string;
  deadline: number | null;
  summary: string;
}

interface Application {
  id: string;
  company: string;
  role: string;
  currentStage: string;
  currentPriority: string;
  currentSummary: string;
  currentDeadline: number | null;
  needsAction: boolean;
  actionType: string;
  salary: string;
  location: string;
  remoteMode: string;
  visaNote: string;
  isUserCorrected: boolean;
  firstEmailAt: number;
  latestEmailAt: number;
  emailCount: number;
  unreadCount: number;
  emails: AppEmail[];
}

type ContextMenuState = { app: Application; x: number; y: number } | null;

const sentenceCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function JobsPage() {
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [openApp, setOpenApp] = useState<Application | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set());
  const isMobile = useIsMobile();

  const fetchApps = useCallback(async () => {
    const res = await fetch("/api/jobs/applications");
    const data = await res.json();
    if (Array.isArray(data.applications)) setApps(data.applications);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  // Keep openApp synced with fresh fetch
  useEffect(() => {
    if (!openApp) return;
    const fresh = apps.find((a) => a.id === openApp.id);
    if (fresh && fresh !== openApp) setOpenApp(fresh);
  }, [apps, openApp]);

  const updateStage = async (app: Application, stage: string) => {
    setApps((prev) => prev.map((a) => a.id === app.id ? { ...a, currentStage: stage, isUserCorrected: true } : a));
    await fetch(`/api/jobs/applications/${app.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "updateStage", stage }),
    });
  };

  const removeApp = async (app: Application) => {
    if (!confirm(`Remove the ${app.company || "unknown company"} application${app.role ? ` for ${app.role}` : ""} from Job tracker?`)) return;
    setApps((prev) => prev.filter((a) => a.id !== app.id));
    if (openApp?.id === app.id) setOpenApp(null);
    await fetch(`/api/jobs/applications/${app.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove" }),
    });
  };

  const renameApp = async (app: Application, company: string, role: string) => {
    await fetch(`/api/jobs/applications/${app.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", company, role }),
    });
    await fetchApps();
  };

  const startMerge = (anchor: Application) => {
    setMergeMode(true);
    setMergeSelection(new Set([anchor.id]));
    setOpenApp(null);
    setCtxMenu(null);
  };

  const performMerge = async () => {
    const ids = Array.from(mergeSelection);
    if (ids.length < 2) { setMergeMode(false); setMergeSelection(new Set()); return; }
    const [targetId, ...sourceIds] = ids;
    await fetch("/api/jobs/applications/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, sourceIds }),
    });
    setMergeMode(false);
    setMergeSelection(new Set());
    await fetchApps();
  };

  const cancelMerge = () => {
    setMergeMode(false);
    setMergeSelection(new Set());
  };

  const toggleMergeSelect = (id: string) => {
    setMergeSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const byColumn: Record<JobColumn, Application[]> = {
    applied: [],
    acknowledged: [],
    interview_scheduled: [],
    interviewed: [],
    offer: [],
    closed: [],
  };
  for (const a of apps) byColumn[stageToColumn(a.currentStage)].push(a);
  for (const col of COLUMN_ORDER) {
    byColumn[col].sort((a, b) => {
      if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
      const aD = a.currentDeadline ?? Infinity;
      const bD = b.currentDeadline ?? Infinity;
      if (aD !== bD) return aD - bD;
      return b.latestEmailAt - a.latestEmailAt;
    });
  }

  const stats = {
    total: apps.length,
    needsAction: apps.filter((a) => a.needsAction).length,
    interview: byColumn.interview_scheduled.length + byColumn.interviewed.length,
    offer: byColumn.offer.length,
    rejected: apps.filter((a) => a.currentStage === "rejected").length,
  };

  const cardOpenHandler = (a: Application) => {
    if (mergeMode) toggleMergeSelect(a.id);
    else setOpenApp(a);
  };

  const cardContextMenuHandler = (a: Application, e: React.MouseEvent) => {
    e.preventDefault();
    if (mergeMode) return;
    setCtxMenu({ app: a, x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 280) });
  };

  return (
    <div
      className="flex h-screen flex-col text-foreground glass-panel m-4"
      style={{
        animation: "rise .64s var(--ease-out) both",
        // m-4 already gives 16px on each side; subtract that + iOS safe-area
        // insets so the panel doesn't extend under the notch / home indicator
        // in standalone PWA mode.
        height: "calc(100vh - 32px - var(--demo-banner-h, 0px) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
        marginTop: "calc(1rem + env(safe-area-inset-top, 0px))",
        marginBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3 shrink-0 hairline-b" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <Link href="/" className="rounded-md p-1 hover:bg-white/[.05]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {/* Tri-color gradient icon (HANDOFF §4.1 style) */}
        <div
          className="relative w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0
                     bg-[linear-gradient(135deg,#c4b5fd,#7ab7ff_50%,#6ee7b7)]
                     shadow-[0_4px_14px_rgba(196,181,253,.28),inset_0_1px_0_rgba(255,255,255,.4)]"
        >
          <Briefcase className="h-3.5 w-3.5 text-[#0b0b10]" strokeWidth={2.5} />
        </div>
        <h1 className="text-lg font-semibold">Job tracker</h1>
        <div className="ml-auto flex items-center gap-2">
          {mergeMode && (
            <>
              <span className="text-xs text-muted-foreground tabular-nums">
                {mergeSelection.size} selected
              </span>
              <Button variant="ghost" size="sm" onClick={cancelMerge} className="h-8 text-xs">Cancel</Button>
              <Button variant="default" size="sm" disabled={mergeSelection.size < 2} onClick={performMerge} className="h-8 gap-1 text-xs">
                <Check className="h-3.5 w-3.5" /> Merge
              </Button>
            </>
          )}
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 text-xs shrink-0 font-mono"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}
      >
        <span><span className="font-semibold">{stats.total}</span> applications</span>
        <span><span className="font-semibold text-[#fcd34d]">{stats.needsAction}</span> need action</span>
        <span><span className="font-semibold text-[#c4b5fd]">{stats.interview}</span> interviews</span>
        <span><span className="font-semibold text-[#6ee7b7]">{stats.offer}</span> offers</span>
        <span className="text-[var(--fg-muted)]"><span className="font-semibold">{stats.rejected}</span> rejected</span>
      </div>
      <CompanyNameNote className="mx-4 mt-2 shrink-0 self-start" />

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : apps.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
          <Briefcase className="h-10 w-10 opacity-30" strokeWidth={1.5} />
          <p className="text-sm font-medium text-foreground/80">No applications yet</p>
          <p className="max-w-sm text-xs">
            Job-related emails appear here automatically. To add one by hand, right-click it in the inbox and choose Classify as job.
          </p>
        </div>
      ) : isMobile ? (
        <MobileAppList
          byColumn={byColumn}
          mergeMode={mergeMode}
          mergeSelection={mergeSelection}
          onOpen={cardOpenHandler}
          onContextMenu={cardContextMenuHandler}
          onRefresh={fetchApps}
        />
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-h-[400px] gap-3 p-3" style={{ width: "max-content", minWidth: "100%" }}>
            {COLUMN_ORDER.map((col) => (
              <div key={col} className="w-[260px] shrink-0 md:w-[280px]">
                <KanbanColumn
                  column={col}
                  apps={byColumn[col]}
                  mergeMode={mergeMode}
                  mergeSelection={mergeSelection}
                  onOpen={cardOpenHandler}
                  onContextMenu={cardContextMenuHandler}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {openApp && !mergeMode && !isMobile && (
        <ApplicationModal
          app={openApp}
          onClose={() => setOpenApp(null)}
          onRefresh={fetchApps}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onUpdateStage={(stage) => { updateStage(ctxMenu.app, stage); setCtxMenu(null); }}
          onRename={() => { setOpenApp(ctxMenu.app); setCtxMenu(null); /* edit happens in modal */ }}
          onMerge={() => startMerge(ctxMenu.app)}
          onRemove={() => { removeApp(ctxMenu.app); setCtxMenu(null); }}
        />
      )}
    </div>
  );
}

/* ── KanbanColumn ──────────────────────────────────────── */

function KanbanColumn({ column, apps, mergeMode, mergeSelection, onOpen, onContextMenu }: {
  column: JobColumn;
  apps: Application[];
  mergeMode: boolean;
  mergeSelection: Set<string>;
  onOpen: (a: Application) => void;
  onContextMenu: (a: Application, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="flex h-full flex-col gap-2 rounded-[14px] p-2.5 border border-[rgba(255,255,255,0.06)]"
      style={{ background: "rgba(255,255,255,0.02)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <span className={`truncate text-[12px] font-semibold ${COLUMN_HEADER_COLOR[column]}`}>
          {COLUMN_LABEL[column]}
        </span>
        <span className="shrink-0 text-xs text-[var(--fg-muted)] font-mono">{apps.length}</span>
      </header>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {apps.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/[0.06] px-3 py-6 text-center text-[11px] text-[var(--fg-muted)]">
            None
          </div>
        ) : apps.map((a) => (
          <ApplicationCard
            key={a.id}
            app={a}
            mergeMode={mergeMode}
            isSelected={mergeSelection.has(a.id)}
            onOpen={() => onOpen(a)}
            onContextMenu={(e) => onContextMenu(a, e)}
          />
        ))}
      </div>
    </div>
  );
}

/* ── ApplicationCard with long-press → context menu ─────────── */

function ApplicationCard({ app, mergeMode, isSelected, onOpen, onContextMenu }: {
  app: Application;
  mergeMode: boolean;
  isSelected: boolean;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const headerName = app.company || "Unknown company";
  const silent = isSilentThread({ latestStage: app.currentStage, latestEmailAt: app.latestEmailAt });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    longPressFired.current = false;
    const touch = e.touches[0];
    if (!touch) return;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      // Synthesize a context menu event at touch position
      onContextMenu({
        preventDefault: () => {},
        clientX: touch.clientX,
        clientY: touch.clientY,
      } as unknown as React.MouseEvent);
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <button
      onClick={() => { if (!longPressFired.current) onOpen(); }}
      onContextMenu={onContextMenu}
      onTouchStart={onTouchStart}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
      onTouchCancel={cancelLongPress}
      className={`group relative flex flex-col gap-1.5 rounded-[12px] px-3 py-2.5 text-left
                  transition-all duration-300 ease-[cubic-bezier(.34,1.56,.64,1)]
                  hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(0,0,0,0.35)]
                  ${isSelected
                    ? "border border-[#7ab7ff] ring-2 ring-[rgba(122,183,255,0.28)] bg-[rgba(122,183,255,0.08)]"
                    : app.needsAction
                    ? "border border-[rgba(252,211,77,0.32)] bg-[rgba(252,211,77,0.04)]"
                    : "border border-[rgba(255,255,255,0.06)] bg-[rgba(20,20,24,0.48)]"
                  }`}
      style={{ backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{headerName}</div>
          {app.role && (
            <div className="truncate text-[11px] text-muted-foreground">{app.role}</div>
          )}
        </div>
        <span
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_COLOR[app.currentPriority] || PRIORITY_COLOR.medium}`}
          title={app.currentPriority}
        />
      </div>

      <p className="line-clamp-2 text-[12px] leading-snug text-foreground/80">
        {app.currentSummary || app.emails[app.emails.length - 1]?.subject}
      </p>

      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        {app.needsAction && (
          <span className="inline-flex items-center gap-0.5 text-amber-400">
            <AlertCircle className="h-2.5 w-2.5" />
            {ACTION_LABEL[app.actionType] || "Needs action"}
          </span>
        )}
        {app.currentDeadline && (
          <span className="inline-flex items-center gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            {sentenceCase(formatDeadline(app.currentDeadline))}
          </span>
        )}
        {silent && !app.needsAction && (
          <span className="inline-flex items-center gap-0.5 text-orange-400">
            <Hourglass className="h-2.5 w-2.5" />
            Silent {daysSinceLastEmail(app.latestEmailAt)}d
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2.5">
          {app.emailCount > 1 && (
            <span className="inline-flex items-center gap-0.5">
              <Mail className="h-2.5 w-2.5" />
              {app.emailCount}
            </span>
          )}
          <span>{formatRelative(app.latestEmailAt)}</span>
        </span>
      </div>
    </button>
  );
}

/* ── Mobile accordion list (< 768px) ───────────────────── */

function MobileAppList({ byColumn, mergeMode, mergeSelection, onOpen, onContextMenu, onRefresh }: {
  byColumn: Record<JobColumn, Application[]>;
  mergeMode: boolean;
  mergeSelection: Set<string>;
  onOpen: (a: Application) => void;
  onContextMenu: (a: Application, e: React.MouseEvent) => void;
  onRefresh: () => Promise<void>;
}) {
  const [openSections, setOpenSections] = useState<Set<JobColumn>>(
    () => new Set(COLUMN_ORDER.filter((c) => byColumn[c]?.length > 0).slice(0, 2))
  );
  const [expandedAppId, setExpandedAppId] = useState<string | null>(null);
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);

  const toggleSection = (col: JobColumn) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {COLUMN_ORDER.map((col) => {
        const apps = byColumn[col];
        if (!apps || apps.length === 0) return null;
        const open = openSections.has(col);
        return (
          <section
            key={col}
            className="rounded-[14px] border border-white/[0.06] overflow-hidden"
            style={{ background: "rgba(255,255,255,0.02)" }}
          >
            <button
              onClick={() => toggleSection(col)}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[.02] transition-colors"
            >
              <ChevronRight
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className={`text-[12px] font-semibold ${COLUMN_HEADER_COLOR[col]}`}>
                {COLUMN_LABEL[col]}
              </span>
              <span className="ml-auto text-xs text-[var(--fg-muted)] font-mono">{apps.length}</span>
            </button>
            {open && (
              <div className="flex flex-col gap-2 px-2 pb-2">
                {apps.map((a) => (
                  <MobileAppCard
                    key={a.id}
                    app={a}
                    mergeMode={mergeMode}
                    isSelected={mergeSelection.has(a.id)}
                    expanded={expandedAppId === a.id}
                    onToggle={() => {
                      if (mergeMode) { onOpen(a); return; }
                      setExpandedAppId((prev) => (prev === a.id ? null : a.id));
                    }}
                    onContextMenu={(e) => onContextMenu(a, e)}
                    onOpenEmail={(eid) => setOpenEmailId(eid)}
                    onRefresh={onRefresh}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {openEmailId && <EmailSidePanel emailId={openEmailId} onClose={() => setOpenEmailId(null)} />}
    </div>
  );
}

function MobileAppCard({ app, mergeMode, isSelected, expanded, onToggle, onContextMenu, onOpenEmail, onRefresh }: {
  app: Application;
  mergeMode: boolean;
  isSelected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onOpenEmail: (emailId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const headerName = app.company || "Unknown company";
  const silent = isSilentThread({ latestStage: app.currentStage, latestEmailAt: app.latestEmailAt });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    longPressFired.current = false;
    const touch = e.touches[0];
    if (!touch) return;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      onContextMenu({
        preventDefault: () => {},
        clientX: touch.clientX,
        clientY: touch.clientY,
      } as unknown as React.MouseEvent);
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  const toggleEmailAction = async (emailId: string, next: boolean) => {
    setToggling(emailId);
    try {
      await fetch(`/api/jobs/${emailId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "updateStage", needsAction: next }),
      });
      await onRefresh();
    } finally {
      setToggling(null);
    }
  };

  return (
    <div
      className={`rounded-[12px] overflow-hidden transition-colors
        ${isSelected
          ? "border border-[#7ab7ff] ring-2 ring-[rgba(122,183,255,0.28)] bg-[rgba(122,183,255,0.08)]"
          : app.needsAction
          ? "border border-[rgba(252,211,77,0.32)] bg-[rgba(252,211,77,0.04)]"
          : "border border-[rgba(255,255,255,0.06)] bg-[rgba(20,20,24,0.48)]"
        }`}
    >
      {/* Summary row (always visible, tap to expand) */}
      <button
        type="button"
        onClick={() => { if (!longPressFired.current) onToggle(); }}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e); }}
        onTouchStart={onTouchStart}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onTouchCancel={cancelLongPress}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform mt-0.5 ${expanded ? "rotate-90" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold flex-1">{headerName}</span>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_COLOR[app.currentPriority] || PRIORITY_COLOR.medium}`}
            />
          </div>
          {app.role && <div className="truncate text-[11px] text-muted-foreground">{app.role}</div>}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
            {app.needsAction && (
              <span className="inline-flex items-center gap-0.5 text-amber-400">
                <AlertCircle className="h-2.5 w-2.5" />
                {ACTION_LABEL[app.actionType] || "Needs action"}
              </span>
            )}
            {app.currentDeadline && (
              <span className="inline-flex items-center gap-0.5">
                <Clock className="h-2.5 w-2.5" />
                {sentenceCase(formatDeadline(app.currentDeadline))}
              </span>
            )}
            {silent && !app.needsAction && (
              <span className="inline-flex items-center gap-0.5 text-orange-400">
                <Hourglass className="h-2.5 w-2.5" />
                Silent {daysSinceLastEmail(app.latestEmailAt)}d
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2.5">
              {app.emailCount > 1 && (
                <span className="inline-flex items-center gap-0.5">
                  <Mail className="h-2.5 w-2.5" />
                  {app.emailCount}
                </span>
              )}
              <span>{formatRelative(app.latestEmailAt)}</span>
            </span>
          </div>
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-white/[0.06] px-3 py-3 space-y-3">
          {app.currentSummary && (
            <p className="text-[12px] leading-snug text-foreground/80">{app.currentSummary}</p>
          )}
          <div>
            <div className="flex gap-2 text-[11px] text-muted-foreground mb-1.5">
              <span>Emails</span>
              <span className="tabular-nums">{app.emailCount}</span>
            </div>
            <ul className="divide-y divide-white/[0.04]">
              {[...app.emails].reverse().map((e) => {
                const busy = toggling === e.emailId;
                return (
                  <li key={e.emailId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenEmail(e.emailId)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onOpenEmail(e.emailId); } }}
                      className="flex w-full items-start gap-2 py-2 text-left hover:bg-white/[.02] rounded cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`truncate text-[12px] ${e.isUnread ? "font-semibold" : "text-foreground/85"}`}>
                            {e.from}
                          </span>
                          {e.isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatEmailDate(e.receivedAt, e.date)}</span>
                        </div>
                        <div className="truncate text-[12px] text-foreground/80">{e.subject}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="rounded border border-white/[0.08] px-1 py-0.5">{STAGE_LABEL[e.stage] || e.stage}</span>
                          {e.needsAction && (
                            <span className="inline-flex items-center gap-0.5 text-amber-400">
                              <AlertCircle className="h-2.5 w-2.5" />
                              {ACTION_LABEL[e.actionType] || "Needs action"}
                            </span>
                          )}
                        </div>
                      </div>
                      {e.needsAction && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(ev) => { ev.stopPropagation(); toggleEmailAction(e.emailId, false); }}
                          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-400 disabled:opacity-50"
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Done
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── ApplicationModal — centered, info + email history list ─── */

function ApplicationModal({ app, onClose, onRefresh }: {
  app: Application;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [toggling, setToggling] = useState<string | null>(null);
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);

  const headerName = app.company || "Unknown company";
  const silent = isSilentThread({ latestStage: app.currentStage, latestEmailAt: app.latestEmailAt });

  // Click an email → open side panel (don't navigate away from Jobs board).
  const jumpToEmail = (emailId: string) => {
    setOpenEmailId(emailId);
  };

  // Flip a single email's needs_action. is_user_corrected gets set server-side
  // so future LLM re-classification can't revert this.
  const toggleNeedsAction = async (emailId: string, next: boolean) => {
    setToggling(emailId);
    try {
      await fetch(`/api/jobs/${emailId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "updateStage", needsAction: next }),
      });
      await onRefresh();
    } catch (e) {
      console.error("[jobs] toggle needs_action:", e);
    } finally {
      setToggling(null);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto flex w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-2xl max-h-[85vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <header className="flex items-start gap-3 border-b border-border px-5 py-4 shrink-0">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold">{headerName}</h2>
              {app.role && <p className="truncate text-sm text-muted-foreground">{app.role}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-full border border-border px-2 py-0.5 font-medium">
                  {STAGE_LABEL[app.currentStage] || app.currentStage}
                </span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${PRIORITY_COLOR[app.currentPriority] || PRIORITY_COLOR.medium} text-white/90`}>
                  {sentenceCase(app.currentPriority.replace(/_/g, " "))}
                </span>
                {app.needsAction && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300">
                    <AlertCircle className="h-3 w-3" />
                    {ACTION_LABEL[app.actionType] || "Needs action"}
                  </span>
                )}
                {app.currentDeadline && (
                  <span className="text-muted-foreground">
                    {formatDeadline(app.currentDeadline) === "Overdue" ? "Overdue" : `Due ${formatDeadline(app.currentDeadline)}`}
                  </span>
                )}
                {silent && (
                  <span className="inline-flex items-center gap-1 text-orange-400">
                    <Hourglass className="h-3 w-3" />
                    Silent {daysSinceLastEmail(app.latestEmailAt)}d
                  </span>
                )}
                {app.isUserCorrected && <span className="text-blue-400">Edited</span>}
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </header>

          {/* Job details — salary / location / remote / visa */}
          {(app.salary || app.location || app.remoteMode || app.visaNote) && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-b border-border bg-muted/10 px-5 py-3 text-xs">
              {app.salary && <div><span className="text-muted-foreground">Salary</span><div className="font-medium text-foreground/90">{app.salary}</div></div>}
              {app.location && <div><span className="text-muted-foreground">Location</span><div className="font-medium text-foreground/90">{app.location}</div></div>}
              {app.remoteMode && <div><span className="text-muted-foreground">Mode</span><div className="font-medium text-foreground/90">{app.remoteMode}</div></div>}
              {app.visaNote && <div className="col-span-2"><span className="text-muted-foreground">Visa</span><div className="font-medium text-foreground/90">{app.visaNote}</div></div>}
            </div>
          )}

          {/* Latest summary */}
          {app.currentSummary && (
            <div className="border-b border-border px-5 py-3 text-sm leading-relaxed text-foreground/85">
              {app.currentSummary}
            </div>
          )}

          {/* Email history list — click jumps to inbox */}
          <div className="flex items-center gap-2 border-b border-border px-5 py-2 shrink-0">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Email history</span>
            <span className="text-xs text-muted-foreground tabular-nums">{app.emailCount}</span>
          </div>
          <ScrollArea className="flex-1">
            <ul className="divide-y divide-border">
              {[...app.emails].reverse().map((e) => {
                const busy = toggling === e.emailId;
                return (
                  <li key={e.emailId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => jumpToEmail(e.emailId)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jumpToEmail(e.emailId); } }}
                      className="group flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40 cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`truncate text-sm ${e.isUnread ? "font-semibold" : "font-medium text-foreground/85"}`}>
                            {e.from}
                          </span>
                          {e.isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{formatEmailDate(e.receivedAt, e.date)}</span>
                        </div>
                        <div className="truncate text-[13px] text-foreground/80">{e.subject}</div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="rounded border border-border px-1.5 py-0.5">{STAGE_LABEL[e.stage] || e.stage}</span>
                          {e.needsAction ? (
                            <span className="inline-flex items-center gap-0.5 text-amber-400">
                              <AlertCircle className="h-2.5 w-2.5" />
                              {ACTION_LABEL[e.actionType] || "Needs action"}
                            </span>
                          ) : e.actionType ? (
                            // Previously had an action which user dismissed → show faded "handled" label with undo
                            <span className="inline-flex items-center gap-0.5 text-muted-foreground/60">
                              <Check className="h-2.5 w-2.5" />
                              Handled
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {/* Per-email action: mark done (or undo). Click stops
                          propagation so the row's jump-to-inbox doesn't fire. */}
                      {e.needsAction ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(ev) => { ev.stopPropagation(); toggleNeedsAction(e.emailId, false); }}
                          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                          title="Mark this email's action as handled"
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Mark done
                        </button>
                      ) : e.actionType ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(ev) => { ev.stopPropagation(); toggleNeedsAction(e.emailId, true); }}
                          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/40 disabled:opacity-50 transition-colors opacity-0 group-hover:opacity-100"
                          title="Re-flag this email as needing action"
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          Undo
                        </button>
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>

        </div>
      </div>
      {openEmailId && <EmailSidePanel emailId={openEmailId} onClose={() => setOpenEmailId(null)} />}
    </>
  );
}

/* ── ContextMenu — right-click / long-press actions ─────── */

function ContextMenu({ state, onClose, onUpdateStage, onRename, onMerge, onRemove }: {
  state: { app: Application; x: number; y: number };
  onClose: () => void;
  onUpdateStage: (stage: string) => void;
  onRename: () => void;
  onMerge: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [stageSubOpen, setStageSubOpen] = useState(false);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[60] w-[220px] rounded-xl shadow-2xl animate-in fade-in-0 zoom-in-95 duration-100 overflow-hidden"
      style={{
        top: state.y,
        left: state.x,
        background: "rgba(20, 20, 20, 0.85)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
      }}
    >
      <div className="px-3 py-2 border-b border-white/10">
        <div className="truncate text-xs font-semibold">{state.app.company || "Unknown company"}</div>
        {state.app.role && <div className="truncate text-[11px] text-muted-foreground">{state.app.role}</div>}
      </div>

      {!stageSubOpen ? (
        <div className="p-1">
          <MenuButton icon={Tag} onClick={() => setStageSubOpen(true)}>
            Change stage
            <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-70" />
          </MenuButton>
          <MenuButton icon={Briefcase} onClick={onRename}>Open details</MenuButton>
          <MenuButton icon={GitMerge} onClick={onMerge}>Merge with…</MenuButton>
          <div className="my-1 h-px bg-white/10" />
          <MenuButton icon={Trash2} onClick={onRemove} variant="destructive">Not a job</MenuButton>
        </div>
      ) : (
        <div className="p-1 max-h-[280px] overflow-y-auto">
          <button
            onClick={() => setStageSubOpen(false)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-white/5"
          >
            <ArrowLeft className="h-3 w-3" /> Back
          </button>
          <div className="my-1 h-px bg-white/10" />
          {ALL_STAGES.map((s) => (
            <button
              key={s}
              onClick={() => onUpdateStage(s)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-white/5 ${
                state.app.currentStage === s ? "text-blue-300" : ""
              }`}
            >
              {state.app.currentStage === s && <Check className="h-3.5 w-3.5" />}
              <span className={state.app.currentStage === s ? "" : "ml-5"}>
                {STAGE_LABEL[s]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuButton({ icon: Icon, children, onClick, variant }: {
  icon: typeof Tag;
  children: React.ReactNode;
  onClick: () => void;
  variant?: "destructive";
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-white/5 ${
        variant === "destructive" ? "text-rose-300 hover:text-rose-200" : ""
      }`}
    >
      <Icon className="h-3.5 w-3.5 opacity-80" />
      {children}
    </button>
  );
}
