"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Send, Loader2, CalendarClock, ChevronDown, ChevronRight, X, PenSquare, Briefcase, AlertCircle, Sparkles, CheckCheck, RotateCw, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BlurFade } from "@/components/ui/blur-fade";
import { useJob } from "@/lib/hooks/useJob";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { useMail, useCategories } from "./use-mail";
import { InstallHint } from "@/components/pwa/install-hint";
import { getCategoryIcon } from "@/lib/category-icons";
import { cleanSnippet } from "@/lib/email-body";
import type { Email } from "@/lib/types";
import { groupByThread, type Thread } from "@/lib/thread-helpers";
import { EmailContextMenu } from "./email-context-menu";
import { useDemo } from "@/components/demo/demo-context";
import { readJson, aiErrorMessage } from "@/lib/demo-client";

const POPUP_MENU_WIDTH = 280;
const POPUP_MENU_HEIGHT = 380;

const ASK_TIMEOUT_SEC = 120;

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const SUGGESTIONS = [
  "What assignments are due this week?",
  "Summarize recent emails from professors",
  "Which emails are still waiting for a reply?",
];

/** Derive category ID for an email, falling back to a legacy string-category → cat_<name> mapping. */
function emailCategoryId(e: Email): string {
  if (e.categoryId) return e.categoryId;
  const legacy = e.category || "notification";
  return "cat_" + legacy;
}

function groupEmails(emails: Email[]): Record<string, Email[]> {
  const groups: Record<string, Email[]> = {};
  for (const e of emails) {
    if (e.category === "spam") continue;
    const key = emailCategoryId(e);
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  return groups;
}

/** Compact relative-time formatter for the digest header (mono font idiom). */
function formatRelative(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Approximate next refresh time. Email digest stale-check fires at most
 *  every 2h, so the next eligible regen is generated_at + 2h. Returns
 *  "in ~Xm" or "in ~Xh" relative to now. Never used as a hard cron — it's
 *  a UX hint only. */
function formatNextEmailDigestRefresh(generatedAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const next = generatedAt + 2 * 3600;
  const diff = next - now;
  if (diff <= 60) return "soon";
  if (diff < 3600) return `in ~${Math.ceil(diff / 60)}m`;
  return `in ~${Math.ceil(diff / 3600)}h`;
}

/** One of the four digest sections (Primary / Track / News / Review).
 *  Accent-coded left rule: blue / emerald / violet / amber per project palette. */
function DigestSection({ label, color, text }: { label: string; color: string; text: string }) {
  const isEmpty = !text || text.trim() === "(No activity)" || text.trim() === "";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        <span className="text-[11px] font-semibold" style={{ color }}>
          {label}
        </span>
      </div>
      {isEmpty ? (
        <p className="pl-3 text-xs italic text-muted-foreground/50">No unread activity.</p>
      ) : (
        <p className="pl-3 border-l-2 text-[13px] leading-relaxed text-foreground/85 whitespace-pre-wrap"
           style={{ borderColor: `${color}33` /* ~20% alpha */ }}>
          {text}
        </p>
      )}
    </div>
  );
}

export function AIPanel({ emails, askOnly, onCompose, onMarkCategoriesRead, onCategoryChange, onToggleRead }: {
  emails: Email[];
  askOnly?: boolean;
  onCompose?: () => void;
  onMarkCategoriesRead?: (categories: string[]) => void;
  // Forwarded into <EmailContextMenu> when user right-clicks an email row
  // inside the category popup card. Both sides share the same callbacks
  // as MailList so behavior is identical.
  onCategoryChange?: (thread: import("@/lib/thread-helpers").Thread, cat: import("@/lib/types").EmailCategory) => void;
  onToggleRead?: (ids: string[], isUnread: boolean) => void;
}) {
  const { setSelected } = useMail();
  const { categories } = useCategories();
  const isMobile = useIsMobile();
  const router = useRouter();
  // DEMO_MODE: the quick actions below use the Gmail connector CLI (/api/run),
  // which the demo turns off; they are hidden instead of failing.
  const demo = useDemo();
  const askJob = useJob();
  const [askInput, setAskInput] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Email digest — long-form narrative summary, refreshed every 2h with stale-check.
  interface EmailDigest {
    generated_at: number;
    primary: string;
    track: string;
    news: string;
    review: string;
    email_count: number;
    review_count?: number;
  }
  const [digest, setDigest] = useState<EmailDigest | null>(null);
  const [digestRefreshing, setDigestRefreshing] = useState(false);
  const [digestError, setDigestError] = useState<{ message: string; at: number } | null>(null);
  const [digestOpen, setDigestOpen] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchDigest = async () => {
      try {
        const r = await fetch("/api/emails/digest");
        if (!r.ok || cancelled) return;
        const d = await r.json();
        setDigest(d.digest ?? null);
        setDigestRefreshing(!!d.refreshing);
        setDigestError(d.error ?? null);
        // Poll only while regen is in flight AND there's no error. An error
        // means the last attempt failed — stop polling so the UI doesn't spin
        // forever; the Retry button is the user's way to try again.
        if (d.refreshing && !d.error && !cancelled) {
          pollTimer = setTimeout(fetchDigest, 8000);
        }
      } catch {/* silent */}
    };
    fetchDigest();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  const regenerateDigest = async () => {
    setDigestRefreshing(true);
    setDigestError(null);
    try {
      const r = await fetch("/api/emails/digest", { method: "POST" });
      const d = await readJson<{ digest?: EmailDigest }>(r);
      if (!r.ok) {
        setDigestError({ message: aiErrorMessage(r, d, "Regeneration failed"), at: Math.floor(Date.now() / 1000) });
      } else if (d.digest) {
        setDigest(d.digest);
      }
    } catch (e) {
      setDigestError({ message: String(e), at: Math.floor(Date.now() / 1000) });
    }
    finally {
      setDigestRefreshing(false);
    }
  };

  const unreadCount = emails.filter((e) => e.isUnread).length;
  const inboxCount = emails.filter((e) => e.categoryId !== "cat_junk" && e.category !== "junk" && e.category !== "spam").length;
  const groups = useMemo(() => groupEmails(emails), [emails]);
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // Sort categories by sort_order (matches settings page order)
  const sortedCategories = useMemo(
    () => [...categories].filter((c) => c.id !== "cat_spam").sort((a, b) => a.sortOrder - b.sortOrder),
    [categories]
  );

  // Right-click context menu on category cards
  const [jobStats, setJobStats] = useState<{ total: number; needsAction: number; interview: number; offer: number } | null>(null);
  useEffect(() => {
    fetch("/api/jobs/applications").then((r) => r.json()).then((data) => {
      if (!Array.isArray(data.applications)) return;
      const t = data.applications as { currentStage: string; needsAction: boolean }[];
      setJobStats({
        total: t.length,
        needsAction: t.filter((x) => x.needsAction).length,
        interview: t.filter((x) => x.currentStage === "interview_scheduled" || x.currentStage === "interviewed").length,
        offer: t.filter((x) => x.currentStage === "offer").length,
      });
    }).catch(() => {});
  }, [emails.length]);

  const [cardCtx, setCardCtx] = useState<{ groupKey: string; x: number; y: number } | null>(null);
  const cardMenuRef = useRef<HTMLDivElement | null>(null);

  // Right-click on an individual email row inside the category popup card.
  // Wraps the single Email as a 1-element Thread so we can reuse <EmailContextMenu>
  // without diverging the menu logic from MailList — see lessons §21 (parallel-
  // implementation drift) for why we pay the wrap-then-unwrap tax.
  const [popupEmailCtx, setPopupEmailCtx] = useState<{ thread: Thread; x: number; y: number } | null>(null);
  const handlePopupEmailContextMenu = (e: React.MouseEvent, email: Email) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - POPUP_MENU_WIDTH - 8);
    const y = Math.min(e.clientY, window.innerHeight - POPUP_MENU_HEIGHT - 8);
    const [thread] = groupByThread([email]);
    setPopupEmailCtx({ thread, x, y });
  };
  // Long-press state per category card (touch devices). Key = cat.id.
  const longPressState = useRef<Map<string, { timer: ReturnType<typeof setTimeout> | null; fired: boolean }>>(new Map());
  useEffect(() => {
    if (!cardCtx) return;
    const close = (e: MouseEvent) => {
      // Don't close if click happened inside the menu (else the button click
      // never fires because the document mousedown closes us first).
      if (cardMenuRef.current && cardMenuRef.current.contains(e.target as Node)) return;
      setCardCtx(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCardCtx(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [cardCtx]);

  // Per-category briefing was retired 2026-05-02 — replaced by the unified
  // email-digest at the top. Cards now show only the email count + first
  // 8 unread subjects (no LLM summary line).

  // Ask AI input now navigates to /ask (local RAG + Sonnet multi-turn chat).
  // Kept the old askJob plumbing for the Follow-ups button which still uses inquiry.
  const handleAsk = (question?: string) => {
    const q = (question || askInput.trim()).trim();
    if (!q) return;
    setAskInput("");
    router.push(`/ask?q=${encodeURIComponent(q)}`);
  };

  const askResult = askJob.status === "done" ? askJob.result : null;
  const askError = askJob.status === "error" ? askJob.error || "Execution failed" : null;

  // askOnly mode: only render the Ask AI section (for mobile Ask AI tab)
  if (askOnly) {
    return (
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-2xl py-6 px-4 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Ask AI</h2>
          </div>

          <div className="glass rounded-xl p-3">
            <div className="flex gap-2">
              <Input
                placeholder="Ask anything about your inbox…"
                value={askInput}
                onChange={(e) => setAskInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleAsk();
                  }
                }}
                disabled={askJob.isRunning}
                className="border-0 bg-transparent focus-visible:ring-0 text-base placeholder:text-muted-foreground/50 h-11"
              />
              <Button size="icon" variant="ghost" onClick={() => handleAsk()} disabled={askJob.isRunning || !askInput.trim()} className="shrink-0 h-11 w-11">
                {askJob.isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => handleAsk(s)} disabled={askJob.isRunning}
                className="glass rounded-full px-3 py-2 text-sm text-muted-foreground disabled:opacity-30">
                {s}
              </button>
            ))}
          </div>

          {/* Quick actions */}
          {!demo && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-9 text-sm gap-1.5" onClick={() => askJob.run("digest", [], { timeoutSec: 180 })}>
              <CalendarClock className="h-3.5 w-3.5" /> Deadlines
            </Button>
            <Button variant="outline" size="sm" className="h-9 text-sm gap-1.5" onClick={() => askJob.run("inquiry", ["Please check which of my recently sent emails have not yet received a reply."], { timeoutSec: ASK_TIMEOUT_SEC })}>
              <Bell className="h-3.5 w-3.5" /> Follow-ups
            </Button>
          </div>
          )}

          {askJob.isRunning && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-xs">Thinking…</span>
            </div>
          )}
          {askResult && (
            <div className="glass rounded-xl p-4">
              <pre className="text-sm whitespace-pre-wrap leading-relaxed">{askResult}</pre>
            </div>
          )}
          {askError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertCircle className="h-3.5 w-3.5" />
                {askError}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className={`mx-auto max-w-2xl space-y-5 ${isMobile ? "py-5 px-4" : "py-8 px-5"}`}>
        {/* iOS install hint — only shows when iOS && !standalone && !dismissed */}
        <InstallHint mobile={isMobile} />

        {/* Greeting + Compose */}
        <BlurFade delay={0}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className={`font-semibold tracking-[-0.025em] leading-[1.1] bg-gradient-to-b from-white to-white/55 bg-clip-text text-transparent ${isMobile ? "text-[28px]" : "text-[34px]"}`}>
                {getGreeting()}, Shuaiyu
              </h1>
              <p className="mt-1.5 flex flex-wrap gap-x-4 text-[13.5px] text-[var(--fg-muted)] font-mono">
                <span>{new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
                <span>{unreadCount} unread</span>
                <span>{inboxCount} total</span>
              </p>
            </div>
            {onCompose && isMobile && (
              <Hint label="Compose new email">
                <Button onClick={onCompose} className="h-10 gap-2 shrink-0">
                  <PenSquare className="h-4 w-4" />
                </Button>
              </Hint>
            )}
          </div>
        </BlurFade>

        {/* Job Search entry — only render when there's at least one tracked job */}
        {jobStats && jobStats.total > 0 && (
          <BlurFade delay={0.1}>
            <Link
              href="/jobs"
              className="glass-card flex items-center gap-3 rounded-xl px-3 py-2.5"
            >
              {/* Violet glass icon square (HANDOFF §4.3) */}
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0
                              bg-gradient-to-br from-[rgba(196,181,253,0.25)] to-[rgba(122,183,255,0.15)]
                              border border-[rgba(196,181,253,0.25)]">
                <Briefcase className="w-[18px] h-[18px] text-[#c4b5fd]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">Job tracker</span>
                  <span className="text-[11px] text-muted-foreground">{jobStats.total} {jobStats.total === 1 ? "application" : "applications"}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                  {jobStats.needsAction > 0 && (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <AlertCircle className="h-2.5 w-2.5" />
                      {jobStats.needsAction} need action
                    </span>
                  )}
                  {jobStats.interview > 0 && (
                    <span className="text-violet-400">{jobStats.interview} {jobStats.interview === 1 ? "interview" : "interviews"}</span>
                  )}
                  {jobStats.offer > 0 && (
                    <span className="text-emerald-400">{jobStats.offer} {jobStats.offer === 1 ? "offer" : "offers"}</span>
                  )}
                </div>
              </div>
              <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground shrink-0" />
            </Link>
          </BlurFade>
        )}

        {/* Automation page entry — desktop has it in the sidebar nav */}
        {isMobile && (
          <BlurFade delay={0.12}>
            <Link href="/automation" className="glass-card flex items-center gap-3 rounded-xl px-3 py-2.5">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0
                              bg-gradient-to-br from-[rgba(110,231,183,0.22)] to-[rgba(122,183,255,0.14)]
                              border border-[rgba(110,231,183,0.25)]">
                <Workflow className="w-[18px] h-[18px] text-[#6ee7b7]" />
              </div>
              <span className="text-sm font-semibold flex-1">Automation</span>
              <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground shrink-0" />
            </Link>
          </BlurFade>
        )}

        {/* Category cards — count + first 8 unread subjects per category.
            (Briefings retired 2026-05-02; UX consolidated into the email-digest
            section above.) */}
        <div className={`grid gap-1.5 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
        {sortedCategories.map((cat, idx) => {
          const Icon = getCategoryIcon(cat.icon);
          const all = groups[cat.id] || [];
          const unread = all.filter((e) => e.isUnread);
          const readRecent = all.filter((e) => !e.isUnread).slice(0, 5);

          // No emails in this category at all: compact greyed-out card.
          // self-start prevents the grid row from stretching this empty card to
          // match a tall sibling (e.g. Newsletter next to a busy Promotion).
          if (all.length === 0) {
            return (
              <BlurFade key={cat.id} delay={0.05 * (idx + 1)} className="self-start">
                <div className="rounded-lg border border-border/40 px-3 py-2 space-y-1 opacity-40">
                  <div className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {cat.name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground/60 italic">No new emails</p>
                </div>
              </BlurFade>
            );
          }

          // Junk is a low-attention bucket: no AI summary, no read/unread
          // distinction (everything looks the same — muted), always grayed.
          // User's mental model is "spam-adjacent — just confirm it's not
          // important", not "read this carefully".
          const isJunk = cat.id === "cat_junk" || (cat.name || "").toLowerCase() === "junk";
          const hasUnread = !isJunk && unread.length > 0;
          const isExpanded = expanded[cat.id];
          // Cards now show 8 emails (was 3 + AI briefing). With briefings
          // removed, surface more concrete subjects in the same vertical
          // space so the card stays information-dense.
          const PREVIEW_COUNT = 8;
          const visibleEmails = isJunk
            ? all.slice(0, PREVIEW_COUNT)
            : hasUnread
              ? (isExpanded ? unread : unread.slice(0, PREVIEW_COUNT))
              : readRecent;
          const hasMore = hasUnread && unread.length > PREVIEW_COUNT;

          const shortName = cat.id.startsWith("cat_") ? cat.id.slice(4) : cat.id;
          return (
            <BlurFade key={cat.id} delay={0.05 * (idx + 1)} className="h-full">
              <div
                className={
                  `c-${shortName} h-full glass-card p-3.5 flex flex-col gap-2.5 cursor-pointer overflow-hidden relative ` +
                  // Spotlight hover: radial highlight that follows the mouse (HANDOFF §4.3)
                  `before:content-[''] before:absolute before:inset-0 before:opacity-0 before:pointer-events-none before:transition-opacity before:duration-300 ` +
                  `before:bg-[radial-gradient(400px_200px_at_var(--mx,50%)_var(--my,0%),rgba(255,255,255,0.10),transparent_60%)] ` +
                  `hover:before:opacity-100 ${!hasUnread ? "opacity-60" : ""}`
                }
                onClick={() => {
                  // Swallow the click that fires right after a long-press-triggered menu.
                  const s = longPressState.current.get(cat.id);
                  if (s?.fired) { s.fired = false; return; }
                  setOpenCategory(cat.id);
                }}
                onMouseMove={(ev) => {
                  const r = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
                  (ev.currentTarget as HTMLDivElement).style.setProperty("--mx", (ev.clientX - r.left) + "px");
                  (ev.currentTarget as HTMLDivElement).style.setProperty("--my", (ev.clientY - r.top) + "px");
                }}
                onContextMenu={(e) => {
                  if (!hasUnread) return;
                  e.preventDefault();
                  const x = Math.min(e.clientX, window.innerWidth - 220);
                  const y = Math.min(e.clientY, window.innerHeight - 80);
                  setCardCtx({ groupKey: cat.id, x, y });
                }}
                onTouchStart={(e) => {
                  if (!hasUnread) return;
                  const touch = e.touches[0];
                  if (!touch) return;
                  const state = { timer: null as ReturnType<typeof setTimeout> | null, fired: false };
                  longPressState.current.set(cat.id, state);
                  state.timer = setTimeout(() => {
                    state.fired = true;
                    const x = Math.min(touch.clientX, window.innerWidth - 220);
                    const y = Math.min(touch.clientY, window.innerHeight - 80);
                    setCardCtx({ groupKey: cat.id, x, y });
                  }, 500);
                }}
                onTouchEnd={() => {
                  const s = longPressState.current.get(cat.id);
                  if (s?.timer) { clearTimeout(s.timer); s.timer = null; }
                }}
                onTouchMove={() => {
                  const s = longPressState.current.get(cat.id);
                  if (s?.timer) { clearTimeout(s.timer); s.timer = null; }
                }}
                onTouchCancel={() => {
                  const s = longPressState.current.get(cat.id);
                  if (s?.timer) { clearTimeout(s.timer); s.timer = null; }
                }}
              >
                {/* Group header with tinted icon chip */}
                <div className="flex items-center gap-2">
                  <div className="cat-ico w-[26px] h-[26px] rounded-lg flex items-center justify-center shrink-0 border">
                    <Icon className="w-[13px] h-[13px]" />
                  </div>
                  <span className="text-[12px] font-semibold text-muted-foreground">
                    {cat.name}
                  </span>
                  {!isJunk && (
                    <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1.5">
                      {unread.length}
                    </Badge>
                  )}
                  {/* One-tap clear — visible only when there's something to clear.
                      Works without long-press on touch devices (direct click/tap).
                      stopPropagation so the card's setOpenCategory handler doesn't also fire. */}
                  {hasUnread && (
                    <Hint label="Mark all as read">
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onMarkCategoriesRead?.([cat.id]);
                        }}
                        aria-label={`Mark all ${cat.name} as read`}
                        className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-md
                                   text-muted-foreground/60 hover:text-[var(--accent-emerald)]
                                   hover:bg-[rgba(110,231,183,0.10)]
                                   active:bg-[rgba(110,231,183,0.18)]
                                   transition-colors duration-150"
                      >
                        <CheckCheck className="h-3 w-3" strokeWidth={2.4} />
                      </button>
                    </Hint>
                  )}
                </div>

                {/* "No new emails" placeholder for non-Junk cards with no
                    unread. Junk skips both the summary and this placeholder. */}
                {!isJunk && !hasUnread && (
                  <p className="text-xs text-muted-foreground/60 italic">No new emails</p>
                )}

                {/* Email list */}
                <div className="space-y-0.5">
                  {visibleEmails.map((e) => {
                    // Junk: no read/unread visual distinction — every row
                    // looks the same (muted). Other categories: blue dot for
                    // unread, regular text for unread, muted text for read.
                    const showAsRead = isJunk || !e.isUnread;
                    return (
                      <button
                        key={e.id}
                        onClick={(ev) => { ev.stopPropagation(); setSelected(e.id); }}
                        className="w-full flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent transition-colors duration-150"
                      >
                        {!isJunk && e.isUnread && <div className="h-1 w-1 rounded-full bg-blue-500 shrink-0" />}
                        {(isJunk || !e.isUnread) && <div className="h-1 w-1 shrink-0" />}
                        <span className={`font-medium truncate ${showAsRead ? "text-muted-foreground" : ""}`}>{e.from}</span>
                        <span className="text-muted-foreground truncate flex-1">{e.subject}</span>
                      </button>
                    );
                  })}
                  {hasMore && !isExpanded && (
                    <button
                      onClick={(ev) => { ev.stopPropagation(); setExpanded((p) => ({ ...p, [cat.id]: true })); }}
                      className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown className="h-3 w-3" />
                      {unread.length - PREVIEW_COUNT} more
                    </button>
                  )}
                </div>
              </div>
            </BlurFade>
          );
        })}
        </div>

        <Separator className="opacity-30" />

        {/* Email Digest — long-form 48h narrative. Primary > Track > News by design;
            Junk excluded. Lazy-stale: refreshes at most every 2h, only if new mail
            arrived since last gen. Placed after category cards (which give snapshot
            counts) and before the Ask AI box (which opens free-form exploration). */}
        <BlurFade delay={0.35}>
          <section
            className={
              "glass-card rounded-xl overflow-hidden relative " +
              "before:content-[''] before:absolute before:inset-0 before:opacity-0 before:pointer-events-none before:transition-opacity before:duration-300 " +
              "before:bg-[radial-gradient(400px_200px_at_var(--mx,50%)_var(--my,0%),rgba(255,255,255,0.10),transparent_60%)] " +
              "hover:before:opacity-100"
            }
            onMouseMove={(ev) => {
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              (ev.currentTarget as HTMLElement).style.setProperty("--mx", (ev.clientX - r.left) + "px");
              (ev.currentTarget as HTMLElement).style.setProperty("--my", (ev.clientY - r.top) + "px");
            }}
          >
            <header
              className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none
                         border-b border-white/[0.06] hover:bg-white/[.02] transition-colors"
              onClick={() => setDigestOpen((v) => !v)}
            >
              <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0
                              bg-[linear-gradient(135deg,rgba(122,183,255,0.25),rgba(196,181,253,0.18))]
                              border border-[rgba(122,183,255,0.20)]">
                <CalendarClock className="h-3 w-3 text-[#bcd7ff]" strokeWidth={2.2} />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-[13px] font-semibold text-foreground/90 leading-none">
                  Email digest
                </h2>
                <p className="mt-1 flex flex-wrap gap-x-3 text-[10px] font-mono text-muted-foreground/60 leading-none">
                  {digest ? (
                    <>
                      <span>{digest.email_count} new</span>
                      <span>{digest.review_count ?? 0} to review</span>
                      <span>Generated {formatRelative(digest.generated_at)}</span>
                      {!demo && <span>Next update {formatNextEmailDigestRefresh(digest.generated_at)}</span>}
                    </>
                  ) : (
                    <span>{digestRefreshing ? "Generating…" : "No digest yet"}</span>
                  )}
                </p>
              </div>
              {digestRefreshing && (
                <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[var(--accent-blue)]/80">
                  <Loader2 className="h-3 w-3 animate-spin" /> Generating…
                </span>
              )}
              <Hint label="Regenerate now">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); regenerateDigest(); }}
                  disabled={digestRefreshing}
                  className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md
                             text-muted-foreground/60 hover:text-foreground hover:bg-white/[.06]
                             disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  aria-label="Regenerate digest"
                >
                  <RotateCw className="h-3 w-3" strokeWidth={2} />
                </button>
              </Hint>
              {digestOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />}
            </header>

            {digestOpen && digestError && (
              <div className="px-4 py-3 border-b border-red-400/20 bg-red-400/[.04]">
                <p className="text-xs text-red-300/90 leading-snug">
                  <span className="text-[11px] font-medium text-red-300/80">Generation failed</span>
                  <br />
                  {digestError.message}
                </p>
                <button
                  type="button"
                  onClick={regenerateDigest}
                  disabled={digestRefreshing}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-mono text-red-300 hover:text-red-200 disabled:opacity-40"
                >
                  <RotateCw className="h-3 w-3" /> Retry
                </button>
              </div>
            )}
            {digestOpen && digest && (
              <div className="px-4 pb-4 pt-3 space-y-4">
                <DigestSection label="Primary" color="#7ab7ff" text={digest.primary} />
                <DigestSection label="Track"   color="#6ee7b7" text={digest.track} />
                <DigestSection label="News"    color="#c4b5fd" text={digest.news} />
                <DigestSection label="Review"  color="#fcd34d" text={digest.review || "(No activity)"} />
              </div>
            )}
            {digestOpen && !digest && !digestError && digestRefreshing && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground/70">
                <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                Generating…
              </div>
            )}
          </section>
        </BlurFade>

        <Separator className="opacity-30" />

        {/* Quick actions — compact row */}
        {!demo && (
          <>
            <BlurFade delay={0.4}>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => askJob.run("digest", [], { timeoutSec: 180 })}>
                  <CalendarClock className="h-3 w-3" /> Deadlines
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => askJob.run("inquiry", ["Please check which of my recently sent emails have not yet received a reply."], { timeoutSec: ASK_TIMEOUT_SEC })}>
                  <Bell className="h-3 w-3" /> Follow-ups
                </Button>
              </div>
            </BlurFade>

            <Separator className="opacity-30" />
          </>
        )}

        {/* Ask AI — sparkle icon + gradient focus ring (HANDOFF §4.3) */}
        <BlurFade delay={0.45}>
          <div>
            <div className="relative p-3.5 rounded-2xl overflow-hidden border border-[rgba(255,255,255,0.08)] backdrop-blur-xl
                            bg-gradient-to-br from-[rgba(122,183,255,0.08)] to-[rgba(196,181,253,0.06)]
                            focus-within:before:opacity-100
                            before:content-[''] before:absolute before:-inset-px before:rounded-2xl before:p-px before:pointer-events-none before:opacity-0 before:transition-opacity before:duration-300
                            before:bg-[linear-gradient(135deg,rgba(122,183,255,0.35),transparent_40%,rgba(196,181,253,0.35))]
                            before:[mask:linear-gradient(#000_0_0)_content-box,linear-gradient(#000_0_0)] before:[mask-composite:exclude]">
              <div className="flex items-center gap-2">
                <Sparkles
                  className="w-5 h-5 text-[#c4b5fd] shrink-0"
                  style={{ animation: "sparkle 3s ease-in-out infinite" }}
                />
                <Input
                  placeholder="Ask anything about your inbox…"
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleAsk();
                  }
                }}
                  disabled={askJob.isRunning}
                  className={`flex-1 border-0 bg-transparent focus-visible:ring-0 placeholder:text-[var(--fg-muted)] ${isMobile ? "text-base h-11" : "text-[14.5px] h-10"}`}
                />
                <button
                  onClick={() => handleAsk()}
                  disabled={askJob.isRunning || !askInput.trim()}
                  className={`shrink-0 flex items-center justify-center rounded-[10px]
                              bg-gradient-to-br from-[rgba(122,183,255,0.25)] to-[rgba(196,181,253,0.2)]
                              border border-[rgba(122,183,255,0.3)]
                              hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(122,183,255,0.25)]
                              disabled:opacity-30 disabled:pointer-events-none transition-all
                              ${isMobile ? "h-11 w-11" : "h-10 w-10"}`}
                >
                  {askJob.isRunning ? <Loader2 className="h-4 w-4 animate-spin text-[#bcd7ff]" /> : <Send className="h-4 w-4 text-[#bcd7ff]" />}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => handleAsk(s)} disabled={askJob.isRunning}
                  className={`glass rounded-full text-muted-foreground disabled:opacity-30 ${isMobile ? "px-3 py-2 text-sm" : "px-3 py-1.5 text-xs"}`}>
                  {s}
                </button>
              ))}
            </div>
            {askJob.isRunning && (
              <div className="mt-3 flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="text-xs">Thinking…</span>
              </div>
            )}
            {askResult && (
              <div className="glass rounded-xl p-4 mt-3">
                <pre className="text-sm whitespace-pre-wrap leading-relaxed">{askResult}</pre>
              </div>
            )}
            {askError && (
              <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {askError}
                </div>
              </div>
            )}
          </div>
        </BlurFade>
      </div>

      {/* Right-click menu on category cards — portal out of glass-panel's backdrop-filter containing block */}
      {cardCtx && typeof document !== "undefined" && createPortal(
        <div
          ref={cardMenuRef}
          className="fixed z-50 rounded-xl shadow-2xl animate-in fade-in-0 zoom-in-95 duration-100 overflow-hidden min-w-[200px]"
          style={{
            top: cardCtx.y,
            left: cardCtx.x,
            background: "rgba(20, 20, 20, 0.72)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <button
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-white/5 transition-colors"
            onClick={() => {
              onMarkCategoriesRead?.([cardCtx.groupKey]);
              setCardCtx(null);
            }}
          >
            <Bell className="h-4 w-4 opacity-70" />
            Mark all as read
          </button>
        </div>,
        document.body
      )}

      {/* Category detail modal — portaled to document.body so the
          fixed-position layer escapes the surrounding ScrollArea. The
          outer ScrollArea's Viewport applies transform internally for
          scrollbar offsets, which creates a containing block: an inline
          `position: fixed` modal would be sized/clipped against that
          Viewport rather than the actual viewport, breaking touch +
          wheel scroll inside the modal. Portal sidesteps that. */}
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
        {openCategory && (() => {
          const cat = sortedCategories.find((c) => c.id === openCategory);
          const catEmails = groups[openCategory] || [];
          const Icon = cat ? getCategoryIcon(cat.icon) : Bell;
          return (
            <>
              {/* Backdrop */}
              <motion.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
                onClick={() => setOpenCategory(null)}
              />
              {/* Modal */}
              <motion.div
                key="modal"
                initial={isMobile ? { opacity: 0, y: "100%" } : { opacity: 0, scale: 0.95, y: 10 }}
                animate={isMobile ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1, y: 0 }}
                exit={isMobile ? { opacity: 0, y: "100%" } : { opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className={`fixed z-50 ${isMobile ? "inset-0" : "inset-0 flex items-center justify-center p-8"}`}
                onClick={() => setOpenCategory(null)}
              >
                <div
                  className={`flex flex-col overflow-hidden ${isMobile ? "h-full bg-background" : "w-full max-w-lg max-h-[80vh] rounded-xl border border-border bg-card shadow-2xl"}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Header */}
                  <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold flex-1">{cat?.name || openCategory}</h2>
                    <Badge variant="secondary" className="text-[10px]">{catEmails.length}</Badge>
                    <button onClick={() => setOpenCategory(null)} className="ml-2 text-muted-foreground hover:text-foreground transition-colors">
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Email list — native div with overflow-y-auto + min-h-0
                      instead of Base UI ScrollArea. The latter never scrolled
                      reliably here even after Portal + flex-1 min-h-0 fixes;
                      its Viewport's internal transform conflicts with our
                      flex sizing chain. Native overflow is bulletproof. */}
                  <div
                    className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
                    style={{ WebkitOverflowScrolling: "touch" }}
                  >
                    <div className="divide-y divide-border">
                      {catEmails.map((e) => (
                        <button
                          key={e.id}
                          onClick={() => { setSelected(e.id); setOpenCategory(null); }}
                          onContextMenu={(ev) => handlePopupEmailContextMenu(ev, e)}
                          className="w-full flex items-start gap-3 px-5 py-3 text-left rounded-lg hover:bg-accent transition-colors duration-150"
                        >
                          <div className="mt-1.5 shrink-0">
                            {e.isUnread ? (
                              <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                            ) : (
                              <div className="h-1.5 w-1.5" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-sm truncate ${e.isUnread ? "font-semibold" : "text-muted-foreground"}`}>
                                {e.from}
                              </span>
                              <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{e.date}</span>
                            </div>
                            <p className="text-sm mt-0.5 truncate">{e.subject}</p>
                            {e.snippet && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{cleanSnippet(e.snippet)}</p>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          );
        })()}
        </AnimatePresence>,
        document.body
      )}

      {popupEmailCtx && (
        <EmailContextMenu
          thread={popupEmailCtx.thread}
          x={popupEmailCtx.x}
          y={popupEmailCtx.y}
          onCategoryChange={onCategoryChange}
          onToggleRead={onToggleRead}
          onClose={() => setPopupEmailCtx(null)}
        />
      )}
    </ScrollArea>
  );
}
