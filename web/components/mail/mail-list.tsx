"use client";

import { useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Eye, EyeOff, MoreHorizontal, Inbox } from "lucide-react";
import { type EmailCategory } from "@/lib/types";
import { formatEmailDate } from "@/lib/email-date";
import { cleanSnippet } from "@/lib/email-body";
import { senderInitial, senderColorClass, categoryPillClass, categoryLabel } from "@/lib/email-helpers";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { useMail } from "./use-mail";
import {
  type Thread,
  threadIsUnread,
  compactSenders,
  threadEmailIds,
} from "@/lib/thread-helpers";
import { EmailContextMenu } from "./email-context-menu";

const SWIPE_THRESHOLD = 80;       // px — past this, release triggers action
const SWIPE_COMMIT_THRESHOLD = 180; // px — full swipe commits
const SWIPE_LOCK_ANGLE = 15;      // deg — below this is horizontal

const MENU_WIDTH = 280;
const MENU_HEIGHT = 480;

interface ContextMenuState { thread: Thread; x: number; y: number }

interface ForceClassifyApiResult {
  ok?: boolean;
  error?: string;
  result?: {
    emailId: string;
    applicationId: string;
    stage: string;
    company: string;
    role: string;
    matchedBy: "thread" | "domain" | "fuzzy" | "new";
  };
}

interface MailListProps {
  items: Thread[];
  /** Apply `newCategory` to every email in the given thread. */
  onCategoryChange?: (thread: Thread, newCategory: EmailCategory) => void;
  /** Mark every email in `emailIds` as (un)read. */
  onToggleRead?: (emailIds: string[], isUnread: boolean) => void;
  emptyTitle?: string;
  emptyHint?: string;
}

/* Unified swipeable wrapper — works on touch (mobile).
 * Right swipe = toggle read on the whole thread, left swipe = open context menu. */
function SwipeableItem({
  children, thread, onSelect, onToggleRead, onOpenMenu, className,
}: {
  children: React.ReactNode;
  thread: Thread;
  onSelect: () => void;
  onToggleRead: (newIsUnread: boolean) => void;
  onOpenMenu: () => void;
  className?: string;
}) {
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [pressIntent, setPressIntent] = useState(false);
  const [pulseFired, setPulseFired] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const direction = useRef<"horizontal" | "vertical" | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didSwipeOrLongPress = useRef(false);

  const clearTimers = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    if (intentTimer.current) { clearTimeout(intentTimer.current); intentTimer.current = null; }
  };

  const reset = (animate = true) => {
    setAnimating(animate);
    setDx(0);
    setPressIntent(false);
  };

  const onDragStart = (clientX: number, clientY: number) => {
    startX.current = clientX;
    startY.current = clientY;
    direction.current = null;
    didSwipeOrLongPress.current = false;
    setAnimating(false);
    intentTimer.current = setTimeout(() => setPressIntent(true), 200);
    longPressTimer.current = setTimeout(() => {
      didSwipeOrLongPress.current = true;
      setPressIntent(false);
      setPulseFired(true);
      setTimeout(() => setPulseFired(false), 200);
      onOpenMenu();
    }, 500);
  };

  const onDragMove = (clientX: number, clientY: number) => {
    const deltaX = clientX - startX.current;
    const deltaY = clientY - startY.current;
    if (!direction.current) {
      const absX = Math.abs(deltaX), absY = Math.abs(deltaY);
      if (absX < 10 && absY < 10) return;
      clearTimers();
      setPressIntent(false);
      const angle = Math.atan2(absY, absX) * (180 / Math.PI);
      direction.current = angle < (90 - SWIPE_LOCK_ANGLE) ? "horizontal" : "vertical";
    }
    if (direction.current === "horizontal") {
      didSwipeOrLongPress.current = true;
      setDx(deltaX);
    }
  };

  const hasUnread = threadIsUnread(thread);

  const onDragEnd = () => {
    clearTimers();
    setPressIntent(false);
    if (direction.current !== "horizontal") return;
    const absDx = Math.abs(dx);
    if (absDx < SWIPE_THRESHOLD) { reset(); return; }
    if (dx > 0) {
      // Has unread → mark all read; all read → mark all unread.
      onToggleRead(!hasUnread);
      setAnimating(true);
      setDx(absDx > SWIPE_COMMIT_THRESHOLD ? window.innerWidth : 0);
      setTimeout(() => { reset(false); }, 200);
    } else {
      onOpenMenu();
      reset();
    }
  };

  const onTouchStart = (e: React.TouchEvent) => onDragStart(e.touches[0].clientX, e.touches[0].clientY);
  const onTouchMove = (e: React.TouchEvent) => onDragMove(e.touches[0].clientX, e.touches[0].clientY);
  const onTouchEnd = onDragEnd;

  const onClick = () => {
    if (didSwipeOrLongPress.current) {
      didSwipeOrLongPress.current = false;
      return;
    }
    onSelect();
  };

  const absDx = Math.abs(dx);
  const showRight = dx > 10;
  const showLeft = dx < -10;
  const past = absDx > SWIPE_THRESHOLD;

  return (
    <div className="relative overflow-hidden rounded-md">
      {showRight && (
        <div className={cn(
          "absolute inset-y-0 left-0 flex items-center gap-2 px-4 text-white transition-colors",
          past ? "bg-blue-600" : "bg-blue-600/50"
        )} style={{ width: Math.max(absDx, 0) }}>
          {hasUnread ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {past && <span className="text-xs font-medium whitespace-nowrap">
            {hasUnread ? "Mark read" : "Mark unread"}
          </span>}
        </div>
      )}
      {showLeft && (
        <div className={cn(
          "absolute inset-y-0 right-0 flex items-center justify-end gap-2 px-4 text-white transition-colors",
          past ? "bg-orange-600" : "bg-orange-600/50"
        )} style={{ width: absDx }}>
          {past && <span className="text-xs font-medium whitespace-nowrap">More</span>}
          <MoreHorizontal className="h-4 w-4" />
        </div>
      )}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={onClick}
        className={cn(
          className,
          "relative glass-card cursor-pointer select-none",
          pressIntent && "ring-2 ring-primary/40 ring-inset",
          pulseFired && "animate-pulse",
        )}
        style={{
          transform: `translateX(${dx}px)`,
          transition: animating ? "transform 200ms ease-out" : pressIntent ? "box-shadow 150ms ease-out" : undefined,
          touchAction: "pan-y",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function MailList({ items, onCategoryChange, onToggleRead, emptyTitle, emptyHint }: MailListProps) {
  const { selected, setSelected } = useMail();
  const isMobile = useIsMobile();
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  const closeMenu = useCallback(() => setCtx(null), []);

  const handleContextMenu = (e: React.MouseEvent, thread: Thread) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 8);
    setCtx({ thread, x, y });
  };

  // Menu items — applied to every email in ctx.thread
  const renderThread = (thread: Thread) => {
    const latest = thread.latest;
    // A thread is "active" if the selected email id is any email in it.
    const isActive = selected !== null && thread.emails.some((e) => e.id === selected);
    const sendersLabel = compactSenders(thread);
    const hasUnread = threadIsUnread(thread);
    const previewSource = latest.body && latest.body.trim().length > (latest.snippet || "").length
      ? latest.body
      : latest.snippet || "";
    const previewText = cleanSnippet(previewSource).slice(0, 280);
    const threadTtlHint = latest.ttlHint;  // latest drives visual; MVP
    const itemInner = (
      <>
        <div className="flex h-7 w-2 shrink-0 items-center justify-center">
          {hasUnread && (
            <span
              className="h-[7px] w-[7px] rounded-full bg-[#7ab7ff] shadow-[0_0_10px_#7ab7ff,0_0_20px_#7ab7ff]"
              style={{ animation: "bouncePulse 2.6s ease-in-out infinite" }}
            />
          )}
        </div>
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_12px_rgba(0,0,0,0.35)]",
            senderColorClass(latest.fromEmail)
          )}
        >
          {senderInitial(latest.from, latest.fromEmail)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "truncate text-[13px]",
                hasUnread ? "font-semibold text-foreground" : "font-normal text-foreground/80"
              )}
            >
              {sendersLabel}
            </span>
            {thread.count > 1 && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                ({thread.count})
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatEmailDate(latest.receivedAt ?? 0, latest.date)}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-medium leading-[14px]",
                categoryPillClass(latest.categoryId, latest.category)
              )}
            >
              {categoryLabel(latest.categoryId, latest.category)}
            </span>
          </div>
          <span
            className={cn(
              "line-clamp-1 text-[14px] leading-snug",
              hasUnread ? "font-semibold text-foreground" : "font-medium text-foreground/75"
            )}
          >
            {latest.subject}
          </span>
          <span className="line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">
            {previewText}
          </span>
          {threadTtlHint && (
            <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-sm bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium leading-[14px] text-amber-600 dark:text-amber-400">
              <span className="h-1 w-1 rounded-full bg-amber-500" />
              {threadTtlHint}
            </span>
          )}
        </div>
      </>
    );

    const itemClass = cn(
      "relative flex flex-row items-start gap-2.5 rounded-xl text-left text-sm w-full border border-transparent",
      "transition-[background-color,transform,border-color] duration-300 ease-[cubic-bezier(.34,1.56,.64,1)]",
      isMobile ? "pl-0 pr-3 py-3" : "pl-1 pr-3 py-2.5",
      isActive
        ? "bg-gradient-to-br from-[rgba(122,183,255,0.10)] to-[rgba(196,181,253,0.06)] border-[rgba(122,183,255,0.20)] " +
          "shadow-[0_8px_24px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)] " +
          "before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded " +
          "before:bg-gradient-to-b before:from-[#7ab7ff] before:to-[#c4b5fd] before:shadow-[0_0_14px_#7ab7ff]"
        : "hover:bg-white/[.035]"
    );

    // Click a thread → select its latest email. MailDisplay will re-expand the
    // conversation from thread_id. Toggling selection de-selects.
    const handleSelect = () => {
      if (isActive) setSelected(null);
      else setSelected(latest.id);
    };

    if (isMobile) {
      return (
        <SwipeableItem
          key={thread.threadId}
          thread={thread}
          className={itemClass}
          onSelect={handleSelect}
          onToggleRead={(newIsUnread) => onToggleRead?.(threadEmailIds(thread), newIsUnread)}
          // x/y unused on mobile (bottom sheet); pass 0/0 to satisfy type
          onOpenMenu={() => setCtx({ thread, x: 0, y: 0 })}
        >
          {itemInner}
        </SwipeableItem>
      );
    }
    return (
      <button
        key={thread.threadId}
        type="button"
        data-active={isActive}
        className={cn("relative transition-colors cursor-pointer", itemClass)}
        onClick={handleSelect}
        onContextMenu={(e) => handleContextMenu(e, thread)}
      >
        {itemInner}
      </button>
    );
  };

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-16">
        <div className="text-center text-muted-foreground max-w-[260px]">
          <Inbox className="h-10 w-10 mx-auto mb-4 opacity-30" strokeWidth={1.5} />
          <p className="text-sm font-medium text-foreground/80">{emptyTitle || "No emails"}</p>
          {emptyHint && <p className="text-xs mt-1.5 leading-relaxed">{emptyHint}</p>}
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className={`flex flex-col gap-1 ${isMobile ? "px-1.5 py-2" : "px-1 py-3"}`}>
        {items.map(renderThread)}
      </div>

      {ctx && (
        <EmailContextMenu
          thread={ctx.thread}
          x={ctx.x}
          y={ctx.y}
          onCategoryChange={onCategoryChange}
          onToggleRead={onToggleRead}
          onClose={closeMenu}
        />
      )}
    </ScrollArea>
  );
}
