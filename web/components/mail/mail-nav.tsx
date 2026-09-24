"use client";

import Link from "next/link";
import { type LucideIcon, Inbox, PenLine, MessageCircle, Briefcase, PenSquare, Settings, Send, User, CalendarDays, Bell, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMail } from "./use-mail";

interface NavItem {
  title: string;
  icon: LucideIcon;
  view: "inbox" | "jobs" | "drafts" | "sent" | "ask";
  href?: string;
}

const items: NavItem[] = [
  { title: "Inbox", icon: Inbox, view: "inbox" },
  { title: "Jobs", icon: Briefcase, view: "jobs", href: "/jobs" },
  { title: "Drafts", icon: PenLine, view: "drafts" },
  { title: "Sent", icon: Send, view: "sent" },
  { title: "Ask AI", icon: MessageCircle, view: "ask", href: "/ask" },
];

// Glass UI nav item styles (HANDOFF §4.1).
// base + inactive + active combine; active gets glow left-bar via ::before.
const navBase = "nav-item relative h-9 px-3 rounded-[10px] flex items-center gap-2.5 text-[13.5px] w-full text-left transition-colors duration-200";
const navInactive = "text-[var(--fg-dim)] hover:text-[var(--fg)] hover:bg-white/[.04]";
const navActive =
  "text-[var(--fg)] font-medium bg-gradient-to-br from-[rgba(122,183,255,0.16)] to-[rgba(196,181,253,0.10)] " +
  "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_4px_14px_rgba(122,183,255,0.12)] " +
  "before:content-[''] before:absolute before:-left-[11px] before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:rounded " +
  "before:bg-gradient-to-b before:from-[#7ab7ff] before:to-[#c4b5fd] before:shadow-[0_0_12px_#7ab7ff]";

export function MailNav({ isCollapsed, onCompose }: { isCollapsed: boolean; onCompose?: () => void }) {
  const { view, setView } = useMail();

  if (isCollapsed) {
    // Collapsed mode preserved for completeness; current UI never collapses.
    return (
      <nav className="grid gap-1 px-2">
        {onCompose && (
          <Hint label="Compose new email" side="right">
            <button
              onClick={onCompose}
              className="h-9 w-9 rounded-lg flex items-center justify-center text-foreground/90 hover:text-foreground transition-colors glass"
            >
              <PenSquare className="h-4 w-4" />
            </button>
          </Hint>
        )}
        {items.map((item) => (
          item.href ? (
            <Link key={item.view} href={item.href} title={item.title} className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-9 w-9")}>
              <item.icon className="h-4 w-4" />
            </Link>
          ) : (
            <button key={item.view} onClick={() => setView(item.view)} title={item.title} className={cn(buttonVariants({ variant: view === item.view ? "default" : "ghost", size: "icon" }), "h-9 w-9")}>
              <item.icon className="h-4 w-4" />
            </button>
          )
        ))}
        <Link href="/automation" title="Automation" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-9 w-9")}>
          <Workflow className="h-4 w-4" />
        </Link>
        <Link href="/settings/notifications" title="Notifications" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-9 w-9")}>
          <Bell className="h-4 w-4" />
        </Link>
        <Link href="/settings/categories" title="Categories" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-9 w-9")}>
          <Settings className="h-4 w-4" />
        </Link>
      </nav>
    );
  }

  // Expanded glass mode (HANDOFF §4.1)
  return (
    <nav className="flex flex-col gap-1 px-1.5">
      {onCompose && (
        <button
          onClick={onCompose}
          className={
            "relative overflow-hidden h-10 px-3.5 rounded-[12px] flex items-center gap-2.5 text-sm font-semibold text-[#0b0b10] mb-2 mx-1 " +
            "bg-gradient-to-br from-[#e7e5e4] to-white " +
            "shadow-[0_6px_20px_rgba(255,255,255,0.10),inset_0_1px_0_rgba(255,255,255,0.7),inset_0_-1px_0_rgba(0,0,0,0.08)] " +
            "hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(255,255,255,0.18),inset_0_1px_0_rgba(255,255,255,0.8)] " +
            "transition-all duration-200 ease-[cubic-bezier(.16,1,.3,1)] " +
            "before:content-[''] before:absolute before:inset-0 before:-translate-x-[120%] before:bg-[linear-gradient(120deg,transparent_30%,rgba(255,255,255,.7)_50%,transparent_70%)] " +
            "hover:before:translate-x-[120%] before:transition-transform before:duration-700"
          }
        >
          <PenSquare className="h-4 w-4" /> Compose
        </button>
      )}

      {items.map((item) => {
        const isActive = !item.href && view === item.view;
        const className = cn(navBase, isActive ? navActive : navInactive);
        if (item.href) {
          return (
            <Link key={item.view} href={item.href} className={className}>
              <item.icon className="h-4 w-4 opacity-80" />
              <span>{item.title}</span>
            </Link>
          );
        }
        return (
          <button key={item.view} onClick={() => setView(item.view)} className={className}>
            <item.icon className="h-4 w-4 opacity-80" />
            <span>{item.title}</span>
          </button>
        );
      })}

      {/* Section label (HANDOFF §4.1) */}
      <div className="px-3.5 pt-3.5 pb-1.5 text-[11px] text-[var(--fg-muted)]">
        AI
      </div>

      <Link href="/calendar" className={cn(navBase, navInactive)}>
        <CalendarDays className="h-4 w-4 opacity-80" />
        <span>Calendar</span>
      </Link>

      <Link href="/automation" className={cn(navBase, navInactive)}>
        <Workflow className="h-4 w-4 opacity-80" />
        <span>Automation</span>
      </Link>

      <div className="px-3.5 pt-3.5 pb-1.5 text-[11px] text-[var(--fg-muted)]">
        Settings
      </div>

      <Link href="/settings/profile" className={cn(navBase, navInactive)}>
        <User className="h-4 w-4 opacity-80" />
        <span>Profile</span>
      </Link>

      <Link href="/settings/notifications" className={cn(navBase, navInactive)}>
        <Bell className="h-4 w-4 opacity-80" />
        <span>Notifications</span>
      </Link>

      <Link href="/settings/categories" className={cn(navBase, navInactive)}>
        <Settings className="h-4 w-4 opacity-80" />
        <span>Categories</span>
      </Link>
    </nav>
  );
}
