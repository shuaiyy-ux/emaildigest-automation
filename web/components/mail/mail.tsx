"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Loader2, MailCheck, LayoutDashboard, Inbox, PenLine, MessageCircle, AlertCircle, Sparkles, Briefcase, CalendarDays, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MailDisplay } from "./mail-display";
import { MailList } from "./mail-list";
import { MailNav } from "./mail-nav";
import { AIPanel } from "./ai-panel";
import { DraftList } from "./draft-list";
import { SentList } from "./sent-list";
import { DraftEditor } from "./draft-editor";
import { useMail, useCategories } from "./use-mail";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { isOther, isPriority } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import { useDemo } from "@/components/demo/demo-context";
import { DemoWatermark } from "@/components/demo/demo-marks";
import { readJson, aiErrorMessage } from "@/lib/demo-client";
import { changeCategory, type Email, type EmailCategory, type Draft } from "@/lib/types";
import {
  type Thread,
  groupByThread,
  threadIsPriority,
  threadIsOther,
  threadIsJunk,
  threadMatchesCategory,
  threadMatchesSearch,
} from "@/lib/thread-helpers";

type InboxTab = "priority" | "other" | "all";

/* ── Mobile bottom tab bar ──────────────────────────────── */

type MobileTab = "dashboard" | "inbox" | "jobs" | "calendar" | "drafts" | "ask";

const MOBILE_TABS: { id: MobileTab; label: string; icon: typeof Inbox; href?: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "jobs", label: "Jobs", icon: Briefcase, href: "/jobs" },
  { id: "calendar", label: "Calendar", icon: CalendarDays, href: "/calendar" },
  { id: "drafts", label: "Drafts", icon: PenLine },
  { id: "ask", label: "Ask AI", icon: MessageCircle, href: "/ask" },
];

function MobileTabBar({ active, onTab }: { active: MobileTab; onTab: (t: MobileTab) => void }) {
  // Outer wraps the visual h-14 row in pb-safe so the home indicator on iOS
  // standalone PWA doesn't eat the icons. Putting pb-safe on the same element
  // as h-14 would clip (border-box).
  return (
    <nav className="border-t border-border bg-background shrink-0 pb-safe">
      <div className="flex items-center justify-around h-14">
        {MOBILE_TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.href) {
                  window.location.href = tab.href;
                  return;
                }
                onTab(tab.id);
              }}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors ${
                isActive ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <tab.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ── Main Mail component ────────────────────────────────── */

export function Mail() {
  const demo = useDemo();
  const { selected, setSelected, view, setView } = useMail();
  const { categories } = useCategories();
  // Filter pills key on the short id ("primary"); show the category's own name.
  const categoryDisplayName = (short: string) =>
    categories.find((c) => c.id === `cat_${short}`)?.name ?? short.charAt(0).toUpperCase() + short.slice(1);
  const isMobile = useIsMobile();
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<EmailCategory | "all">("all");
  const [selectedDraft, setSelectedDraft] = useState<Draft | null>(null);
  const [draftRefresh, setDraftRefresh] = useState(0);
  const [mobileTab, setMobileTab] = useState<MobileTab>("dashboard");
  const [showUnclassifiedOnly, setShowUnclassifiedOnly] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [claudeAuth, setClaudeAuth] = useState<{ status: string; error: string | null; checkedAt: number } | null>(null);
  const [authBannerDismissed, setAuthBannerDismissed] = useState(false);
  const [imapHealth, setImapHealth] = useState<{ status: string; error: string | null; checkedAt: number } | null>(null);
  const [imapBannerDismissed, setImapBannerDismissed] = useState(false);

  // Persist mobile tab in URL (?tab=...) so reload + share-link survive.
  // Also accept ?email=<id> to auto-select an email (used by Job tracker → email jumps).
  // Uses native history APIs to avoid Suspense requirements of useSearchParams.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "ask") {
      window.location.href = "/ask";
      return;
    }
    if (t === "dashboard" || t === "inbox" || t === "drafts") {
      setMobileTab(t);
      if (t === "inbox") setView("inbox");
      else if (t === "drafts") setView("drafts");
    }
    const emailParam = params.get("email");
    if (emailParam) setSelected(emailParam);
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get("tab");
      if (p === "dashboard" || p === "inbox" || p === "drafts") setMobileTab(p);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // setView/setSelected are stable from Jotai; intentionally only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [composing, setComposing] = useState(false);
  const [inboxTab, setInboxTab] = useState<InboxTab>("priority");

  // Category filter is scoped to the tab it was picked in — switching tabs
  // resets it so "news" pill from Other doesn't hide every Priority email.
  const changeInboxTab = (t: string) => {
    setInboxTab(t as InboxTab);
    setCatFilter("all");
  };

  const activeDraft = (view === "drafts" || view === "sent") ? selectedDraft : null;
  const refreshDrafts = () => { setSelectedDraft(null); setComposing(false); setDraftRefresh((c) => c + 1); };

  // Apply a category change to every email in a thread (Gmail-style: labelling
  // a conversation relabels every message in it). recordCorrection fires once
  // per email for training signal.
  const handleCategoryChange = async (thread: Thread, newCategory: EmailCategory) => {
    const ids = new Set(thread.emails.map((e) => e.id));
    setEmails((prev) => prev.map((e) => ids.has(e.id) ? { ...e, category: newCategory, classifier: "user" } : e));
    for (const email of thread.emails) {
      const oldCategory = email.category || "notification";
      try {
        await changeCategory(email.id, newCategory, oldCategory, email.fromEmail, email.subject);
      } catch (err) { console.error("[mail] category change error:", err); }
    }
  };

  const handleToggleRead = async (ids: string[], isUnread: boolean) => {
    const idSet = new Set(ids);
    setEmails((prev) => prev.map((e) => idSet.has(e.id) ? { ...e, isUnread } : e));
    for (const id of ids) {
      try {
        await fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "setRead", id, isUnread }) });
      } catch (err) { console.error("[mail] toggle read error:", err); }
    }
  };

  // Auto-mark-read on open. Once per email per session (ref dedupe) so a
  // user who explicitly toggles unread via the right-click menu after
  // opening can keep it unread — re-selecting won't re-mark.
  // Dep on `emails` handles the cold-load case: page mounts with a selected
  // id (e.g. from atom persistence) before /api/emails resolves; the effect
  // re-runs after the email shows up in state.
  const autoMarkedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selected || autoMarkedRef.current.has(selected)) return;
    const sel = emails.find((e) => e.id === selected);
    if (!sel) return;
    autoMarkedRef.current.add(selected);
    if (sel.isUnread) handleToggleRead([selected], false);
  }, [selected, emails]);

  // Inputs are category_ids (e.g. "cat_track"). Optimistic local patch matches
  // on e.categoryId for consistency with the backend's category_id filter
  // (legacy rows where e.category is a stale short-name still get patched).
  const handleMarkCategoriesRead = async (categoryIds: string[]) => {
    const idSet = new Set(categoryIds);
    setEmails((prev) => prev.map((e) => (e.isUnread && e.categoryId && idSet.has(e.categoryId)) ? { ...e, isUnread: false } : e));
    try {
      await fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markCategoriesRead", categoryIds }) });
    } catch (e) { console.error("[mail] mark categories read error:", e); }
  };

  useEffect(() => {
    const pull = () => fetch("/api/emails")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.emails)) setEmails(data.emails);
        if (data.claudeAuth) setClaudeAuth(data.claudeAuth);
        if (data.imapHealth) setImapHealth(data.imapHealth);
      })
      .catch((e) => console.error("[mail] fetchEmails error:", e));

    pull().finally(() => setLoading(false));

    // Auto-refresh every 60s so new emails pushed in by IMAP IDLE appear
    // without a manual reload. Server-side prefetch has reentrance lock.
    const iv = setInterval(() => {
      fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }) }).catch(() => {});
      pull();
    }, 60_000);
    return () => clearInterval(iv);
  }, []);

  const filtered = emails.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return e.from.toLowerCase().includes(q) || e.subject.toLowerCase().includes(q) || (e.snippet || "").toLowerCase().includes(q);
  });

  const unreadCount = emails.filter((e) => e.isUnread).length;
  const selectedMail = emails.find((e) => e.id === selected) || null;
  const selectedThreadEmails = selectedMail?.threadId
    ? emails
        .filter((e) => e.threadId === selectedMail.threadId)
        .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0))
    : selectedMail
      ? [selectedMail]
      : [];

  // Priority/Other/All counts use unread-only as the actionable signal even though
  // the lists themselves show read+unread. Priority = cat_primary + active TTL.
  const priorityUnread = emails.filter((e) => e.isUnread && isPriority(e)).length;
  const otherUnread = emails.filter((e) => e.isUnread && isOther(e)).length;
  const allUnread = priorityUnread + otherUnread;
  const unclassifiedCount = emails.filter((e) => !e.categoryId).length;

  // Wait for an in-flight reclassify (started by us or another tab) to drain,
  // then refresh /api/emails. Used both by the 409 path (parallel click) and
  // the mount-effect that detects a running reclassify on page load.
  const waitForReclassify = useCallback(async (toastId: string | number) => {
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await fetch("/api/emails?reclassifyStatus=1");
        const d = await r.json();
        if (!d.isRunning) break;
      } catch {
        // Network blip — keep polling. Fresh-window self-heal will eventually
        // unstick a truly dead lock.
      }
    }
    const fresh = await fetch("/api/emails").then((r) => r.json());
    if (Array.isArray(fresh.emails)) setEmails(fresh.emails);
    toast.success("Classification finished", { id: toastId });
  }, []);

  const handleAutoReclassify = async () => {
    setReclassifying(true);
    const t = toast.loading(`Classifying ${unclassifiedCount} emails…`);
    try {
      const res = await fetch("/api/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reclassifyUnclassified" }),
      });
      // 409 = a fresh reclassify is already running (sibling tab / quick
      // double-click). Wait for it to drain instead of double-spawning.
      if (res.status === 409) {
        toast.message("Reclassify already running, waiting for it to finish…", { id: t });
        await waitForReclassify(t);
        return;
      }
      const data = await readJson<{ classified?: number; unknown?: number }>(res);
      if (res.status === 429) {
        // Demo gateway quota: show its message as-is.
        toast.error(aiErrorMessage(res, data, "Limit reached."), { id: t });
        return;
      }
      if (!res.ok) {
        throw new Error(aiErrorMessage(res, data, `HTTP ${res.status}`));
      }
      const fresh = await fetch("/api/emails").then((r) => r.json());
      if (Array.isArray(fresh.emails)) setEmails(fresh.emails);
      if (typeof data.classified === "number" && data.classified > 0) {
        toast.success(`Classified ${data.classified}${data.unknown ? ` (${data.unknown} unrecognized)` : ""}`, { id: t });
      } else if (data.message) {
        toast.info(String(data.message), { id: t });
      } else {
        toast.warning("Classification finished but no results were written. Check server logs.", { id: t });
      }
    } catch (e) {
      console.error("[mail] auto-reclassify error:", e);
      toast.error(`Auto-classification failed: ${(e as Error).message}`, {
        id: t,
        description: "Usually caused by Claude CLI authentication failure. Check server status.",
      });
    } finally {
      setReclassifying(false);
    }
  };

  // Mount-time hydrate: if another tab kicked off a reclassify before this
  // one mounted (or the same tab F5'd mid-run), surface the running state
  // and wait for it instead of letting the user click and 409.
  useEffect(() => {
    fetch("/api/emails?reclassifyStatus=1")
      .then((r) => r.json())
      .then((d) => {
        if (d.isRunning) {
          setReclassifying(true);
          const t = toast.loading("Reclassify in progress in another tab…");
          waitForReclassify(t).finally(() => setReclassifying(false));
        }
      })
      .catch(() => {});
  }, [waitForReclassify]);

  /* ── Shared sub-components ──────────────────────────── */

  const mailListHeader = (
    <>
      <div className="flex items-center px-4 py-2 shrink-0">
        <h1 className="text-xl font-bold">{view === "jobs" ? "Job emails" : "Inbox"}</h1>
        {/* Sync status (HANDOFF §4.2). The live badge follows the IMAP IDLE
            health the server reports; DEMO_MODE has no IMAP, the mailbox is a
            static sample, so the badge says that instead. */}
        {demo ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--fg-muted)]" />
            Static demo mailbox
          </span>
        ) : imapHealth?.status === "ok" ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <span
              className="w-1.5 h-1.5 rounded-full bg-[#6ee7b7] shadow-[0_0_10px_#6ee7b7]"
              style={{ animation: "pulse 2s ease-in-out infinite" }}
            />
            Live sync
          </span>
        ) : imapHealth?.status === "transient_failed" ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Reconnecting
          </span>
        ) : null}
      </div>
      <Separator />
      {claudeAuth && claudeAuth.status !== "ok" && claudeAuth.status !== "unknown" && !authBannerDismissed && (
        <div className="mx-3 mt-2 shrink-0 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-rose-200">Claude CLI authentication failed</div>
              <div className="text-rose-300/80 truncate">
                Classification, digest, drafts, Ask AI and push notifications are paused.
                {claudeAuth.error && <span className="ml-1 opacity-70">{claudeAuth.error}</span>}
              </div>
            </div>
            <button
              onClick={() => setAuthBannerDismissed(true)}
              className="shrink-0 opacity-60 hover:opacity-100"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {imapHealth && imapHealth.status === "auth_failed" && !imapBannerDismissed && (
        <div className="mx-3 mt-2 shrink-0 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-rose-200">Gmail sign-in failed</div>
              <div className="text-rose-300/80 truncate">
                New mail stops arriving until GMAIL_APP_PASSWORD is updated and the app restarts.
                {imapHealth.error && <span className="ml-1 opacity-70">{imapHealth.error}</span>}
              </div>
            </div>
            <button
              onClick={() => setImapBannerDismissed(true)}
              className="shrink-0 opacity-60 hover:opacity-100"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {view !== "jobs" && unclassifiedCount > 0 && (
        <div className="mx-3 mt-2 shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <span className="text-foreground/90">
              {unclassifiedCount} emails unclassified
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={reclassifying}
                onClick={handleAutoReclassify}
              >
                {reclassifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                Auto-reclassify
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowUnclassifiedOnly((v) => !v)}
              >
                {showUnclassifiedOnly ? "Clear filter" : "Select manually"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {view !== "jobs" && (
        <div className="px-3 pt-2 shrink-0">
          <Tabs value={inboxTab} onValueChange={changeInboxTab}>
            <TabsList className="w-full">
              <TabsTrigger value="priority" className="flex-1">
                <span>Priority</span>
                {priorityUnread > 0 && <span className="tabular-nums opacity-60">{priorityUnread}</span>}
              </TabsTrigger>
              <TabsTrigger value="other" className="flex-1">
                <span>Other</span>
                {otherUnread > 0 && <span className="tabular-nums opacity-60">{otherUnread}</span>}
              </TabsTrigger>
              <TabsTrigger value="all" className="flex-1">
                <span>All</span>
                {allUnread > 0 && <span className="tabular-nums opacity-60">{allUnread}</span>}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}
      <div className="p-3 shrink-0 space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search emails…" className="pl-8 h-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {unreadCount > 0 && (
            <Hint label="Mark News and Junk as read">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => {
                  fetch("/api/emails", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "markUnimportantRead" }),
                  })
                    .then((r) => r.json())
                    .then((data) => {
                      if (data.marked > 0) {
                        const unimportant = new Set(["news", "junk"]);
                        setEmails((prev) => prev.map((e) =>
                          e.isUnread && unimportant.has(e.category || "") ? { ...e, isUnread: false } : e
                        ));
                      }
                    })
                    .catch((e) => console.error("[mail] markUnimportantRead error:", e));
                }}
              >
                <MailCheck className="h-4 w-4" />
              </Button>
            </Hint>
          )}
        </div>
        {/* Category filter pills — scoped to the current tab's emails, count = UNREAD only */}
        {view !== "jobs" && (() => {
          const tabPool = emails.filter((e) => {
            if (e.categoryId === "cat_junk" || e.category === "junk" || e.category === "spam") return false;
            if (inboxTab === "priority") return isPriority(e);
            if (inboxTab === "other") return !isPriority(e);
            return true;
          });
          // Group by short-name derived from category_id (authoritative) with
          // fallback to legacy `category` — then count only unread.
          const cats = tabPool.reduce((acc, e) => {
            const rawId = e.categoryId;
            const shortFromId = rawId && rawId.startsWith("cat_") ? rawId.slice(4) : null;
            const c = shortFromId || e.category || "notification";
            if (!acc[c]) acc[c] = 0;
            if (e.isUnread) acc[c]++;
            return acc;
          }, {} as Record<string, number>);
          const entries = Object.entries(cats).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
          if (entries.length <= 1) return null;
          return (
            <div className="flex gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <button
                onClick={() => setCatFilter("all")}
                className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  catFilter === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>Unread</span>
                <span className="tabular-nums opacity-70">{tabPool.filter((e) => e.isUnread).length}</span>
              </button>
              {entries.map(([cat, count]) => (
                <button
                  key={cat}
                  onClick={() => setCatFilter(cat as EmailCategory)}
                  className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    catFilter === cat ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span>{categoryDisplayName(cat)}</span>
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              ))}
            </div>
          );
        })()}
      </div>
    </>
  );

  const mailListContent = loading && emails.length === 0 ? (
    <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">Loading…</span>
    </div>
  ) : (() => {
    // Thread grouping: aggregate by thread_id first, then filter at the thread
    // level using "any email matches" — Gmail's semantic (a conversation shows
    // up in every tab/label that any message in it matches).
    let threads: Thread[] = groupByThread(emails);
    let emptyTitle: string;
    let emptyHint: string;
    if (showUnclassifiedOnly) {
      threads = threads.filter((t) => t.emails.some((e) => !e.categoryId));
      emptyTitle = "No unclassified emails left";
      emptyHint = "Clear the filter to return to the inbox";
    } else if (view === "jobs") {
      threads = threads.filter((t) => threadMatchesCategory(t, "job"));
      emptyTitle = "No job-related emails yet";
      emptyHint = "New interview invitations or recruiting updates will appear here";
    } else if (inboxTab === "priority") {
      threads = threads.filter((t) => threadIsPriority(t));
      emptyTitle = "Priority is empty";
      emptyHint = "Personal messages, verification codes, and near-term deadlines will appear here";
    } else if (inboxTab === "other") {
      threads = threads.filter((t) => threadIsOther(t) && !threadIsJunk(t));
      emptyTitle = "Other is empty";
      emptyHint = "Track and News category emails will appear here";
    } else {
      threads = threads.filter((t) => !threadIsJunk(t));
      emptyTitle = "Inbox is empty";
      emptyHint = demo ? "The demo mailbox is static, so no new mail arrives" : "New mail syncs here automatically";
    }
    if (catFilter !== "all") {
      threads = threads.filter((t) => threadMatchesCategory(t, catFilter));
      if (threads.length === 0) {
        emptyTitle = `No emails in "${catFilter}" category`;
        emptyHint = "Clear the filter to see all emails";
      }
    }
    if (search) {
      threads = threads.filter((t) => threadMatchesSearch(t, search));
      if (threads.length === 0) {
        emptyTitle = "No matching emails";
        emptyHint = `No emails match "${search}"`;
      }
    }
    return (
      <MailList
        items={threads}
        onCategoryChange={handleCategoryChange}
        onToggleRead={handleToggleRead}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
      />
    );
  })();

  const handleMobileTab = (tab: MobileTab) => {
    setMobileTab(tab);
    // Sync the global view state for components that depend on it
    if (tab === "inbox") setView("inbox");
    else if (tab === "drafts") setView("drafts");
    // ask tab navigates via href in MobileTabBar; never lands here.
    // Clear selections when switching tabs
    setSelected(null);
    setSelectedDraft(null);
    // Persist to URL
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("tab", tab);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
    }
  };

  /* ── Mobile layout ──────────────────────────────────── */

  if (isMobile) {
    return (
      <div className="flex h-full flex-col pt-safe">
        {/* Main content area */}
        <div className="relative flex-1 overflow-hidden">
          {mobileTab === "dashboard" && (
            <>
              <AIPanel emails={emails} onCompose={() => setComposing(true)} onMarkCategoriesRead={handleMarkCategoriesRead} onCategoryChange={handleCategoryChange} onToggleRead={handleToggleRead} />
              <DemoWatermark />
            </>
          )}

          {mobileTab === "inbox" && (
            <div className="flex h-full flex-col">
              {mailListHeader}
              <div className="flex-1 overflow-hidden">
                {mailListContent}
              </div>
            </div>
          )}

          {mobileTab === "drafts" && (
            <div className="flex h-full flex-col">
              <div className="flex items-center px-4 py-2 shrink-0">
                <h1 className="text-xl font-bold">Drafts</h1>
              </div>
              <Separator />
              <div className="flex-1 overflow-hidden">
                <DraftList selected={null} onSelect={(d) => setSelectedDraft(d)} refreshKey={draftRefresh} />
              </div>
            </div>
          )}

          {/* ask tab navigates to /ask page; no inline render here */}
        </div>

        {/* Bottom tab bar */}
        <MobileTabBar active={mobileTab} onTab={handleMobileTab} />

        {/* Full-screen overlays for email/draft detail.
            pt-safe pushes the toolbar (Back button) below the iOS notch in
            standalone PWA mode; bg-background extends edge-to-edge for the
            full-bleed look. */}
        {selectedMail && (
          <div className="fixed inset-0 z-50 bg-background pt-safe">
            <MailDisplay
              mail={selectedMail}
              threadEmails={selectedThreadEmails}
              onBack={() => setSelected(null)}
              onEmailUpdated={(id, patch) => setEmails((prev) => prev.map((e) => e.id === id ? { ...e, ...patch } : e))}
            />
          </div>
        )}

        {selectedDraft && (
          <div className="fixed inset-0 z-50 bg-background flex flex-col pt-safe">
            <DraftEditor
              key={selectedDraft.id}
              initialDraft={selectedDraft}
              onClose={refreshDrafts}
              onSent={refreshDrafts}
            />
          </div>
        )}

        {composing && (
          <div className="fixed inset-0 z-50 bg-background flex flex-col pt-safe">
            <DraftEditor
              key="compose-new"
              compose
              onClose={() => setComposing(false)}
              onSent={refreshDrafts}
            />
          </div>
        )}
      </div>
    );
  }

  /* ── Desktop layout (unchanged) ─────────────────────── */

  return (
    <div className="h-full p-4 grid grid-cols-[220px_400px_1fr] gap-3.5">
      {/* Sidebar */}
      <aside
        className="glass-panel flex flex-col overflow-hidden"
        style={{ animation: "rise .64s var(--ease-out) both" }}
      >
        <div className="flex h-[56px] items-center px-4 shrink-0">
          <div className="flex items-center gap-3">
            {/* Tri-color gradient logo with conic glow halo (HANDOFF §4.1) */}
            <div
              className="relative w-8 h-8 rounded-[10px] flex items-center justify-center font-bold text-[11px] text-[#0b0b10] shrink-0
                         bg-[linear-gradient(135deg,#7ab7ff,#c4b5fd_50%,#6ee7b7)]
                         shadow-[0_6px_20px_rgba(122,183,255,.35),inset_0_1px_0_rgba(255,255,255,.4)]
                         after:content-[''] after:absolute after:-inset-0.5 after:rounded-[12px] after:-z-10
                         after:bg-[conic-gradient(from_0deg,#7ab7ff,#c4b5fd,#6ee7b7,#7ab7ff)] after:blur-[10px] after:opacity-50"
            >
              ED
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight truncate">EmailDigest</h2>
              <p className="text-[10px] text-muted-foreground truncate">owner<span>@</span>example.edu</p>
            </div>
          </div>
        </div>
        <div className="hairline mx-3" />
        <div className="py-2">
          <MailNav isCollapsed={false} onCompose={() => setComposing(true)} />
        </div>
      </aside>

      {/* Mail list */}
      <section
        className="glass-panel flex flex-col overflow-hidden"
        style={{ animation: "rise .64s 80ms var(--ease-out) both" }}
      >
        {(view === "inbox" || view === "jobs") ? (
          <>
            {mailListHeader}
            <div className="flex-1 overflow-hidden">
              {mailListContent}
            </div>
          </>
        ) : view === "drafts" ? (
          <>
            <div className="flex items-center px-4 py-2 shrink-0">
              <h1 className="text-xl font-bold">Drafts</h1>
            </div>
            <Separator />
            <div className="flex-1 overflow-hidden">
              <DraftList selected={activeDraft?.id || null} onSelect={(d) => setSelectedDraft(d)} refreshKey={draftRefresh} />
            </div>
          </>
        ) : view === "sent" ? (
          <>
            <div className="flex items-center px-4 py-2 shrink-0">
              <h1 className="text-xl font-bold">Sent</h1>
            </div>
            <Separator />
            <div className="flex-1 overflow-hidden">
              <SentList selected={activeDraft?.id || null} onSelect={(d) => setSelectedDraft(d)} refreshKey={draftRefresh} />
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-muted-foreground">
              <p className="text-lg font-medium capitalize">{view}</p>
              <p className="text-sm">Coming soon</p>
            </div>
          </div>
        )}
      </section>

      {/* Right panel: AI dashboard, email display, or draft editor */}
      <section
        className="glass-panel flex flex-col overflow-hidden"
        style={{ animation: "rise .64s 160ms var(--ease-out) both" }}
      >
        {composing ? (
          <div className="flex h-full flex-col">
            <DraftEditor
              key="compose-new"
              compose
              onClose={() => setComposing(false)}
              onSent={refreshDrafts}
            />
          </div>
        ) : activeDraft ? (
          <div className="flex h-full flex-col">
            <DraftEditor
              key={activeDraft.id}
              initialDraft={activeDraft}
              onClose={refreshDrafts}
              onSent={refreshDrafts}
            />
          </div>
        ) : selectedMail ? (
          <MailDisplay
            mail={selectedMail}
            threadEmails={selectedThreadEmails}
            onBack={() => setSelected(null)}
            onEmailUpdated={(id, patch) => setEmails((prev) => prev.map((e) => e.id === id ? { ...e, ...patch } : e))}
          />
        ) : (
          <>
            <AIPanel emails={emails} onCompose={() => setComposing(true)} onMarkCategoriesRead={handleMarkCategoriesRead} onCategoryChange={handleCategoryChange} onToggleRead={handleToggleRead} />
            <DemoWatermark />
          </>
        )}
      </section>
    </div>
  );
}
