"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarDays, Loader2, ScanLine, MapPin, Clock, X, Mail } from "lucide-react";
import { Letter } from "react-letter";
import { stripLLMContamination } from "@/lib/sanitize";
import { parseEmailBody, cleanSnippet } from "@/lib/email-body";
import { EmailBodyView } from "@/components/mail/email-body-view";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg } from "@fullcalendar/core";
import { useIsMobile } from "@/lib/hooks/useMobile";
import "../../app/calendar/calendar.css";
import { readJson, aiErrorMessage } from "@/lib/demo-client";

interface ApiEvent {
  id: string;
  email_id: string;
  title: string;
  start_ts: number;
  end_ts: number | null;
  all_day: number;
  location: string;
  source_start: number | null;
  source_end: number | null;
}

export function CalendarPageClient() {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const calendarRef = useRef<FullCalendar>(null);

  const fetchEvents = async () => {
    const from = Math.floor(Date.now() / 1000) - 30 * 86400;
    const to = Math.floor(Date.now() / 1000) + 180 * 86400;
    const r = await fetch(`/api/events?from=${from}&to=${to}`);
    const d = await r.json();
    setEvents(d.events || []);
    setLoading(false);
  };

  // F5-recovery: ask backend if a scan is currently running so we don't lie
  // to the user with a fresh "Scan inbox" button while a 240s Haiku spawn is
  // still in flight. See docs/design/state-boundary.md.
  // The polling mode (interval=2s) is also used by runScan when the POST
  // returns 409 ("scan_in_progress" — another tab/device kicked it off).
  useEffect(() => {
    fetchEvents();
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const pollOnce = async () => {
      try {
        const r = await fetch("/api/events?scanStatus=1");
        const d = await r.json();
        if (cancelled) return;
        if (d.isRunning) {
          if (!scanning) {
            setScanning(true);
            const ageSec = Math.floor(Date.now() / 1000) - (d.startedAt || 0);
            setScanStatus(`Scan in progress (${ageSec}s elapsed)`);
          }
          if (!interval) interval = setInterval(pollOnce, 2000);
        } else if (scanning && interval) {
          // Backend cleared the lock — scan finished elsewhere; refresh events.
          clearInterval(interval); interval = null;
          setScanning(false);
          setScanStatus("Scan finished");
          await fetchEvents();
          setTimeout(() => { if (!cancelled) setScanStatus(""); }, 4000);
        }
      } catch {
        // Network blip — keep polling. The next tick will recover.
      }
    };
    pollOnce();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fcEvents = useMemo(
    () =>
      events.map((e) => ({
        id: e.id,
        title: e.title,
        start: new Date(e.start_ts * 1000),
        end: e.end_ts ? new Date(e.end_ts * 1000) : new Date((e.start_ts + 3600) * 1000),
        allDay: !!e.all_day,
        extendedProps: { location: e.location },
      })),
    [events]
  );

  const onEventClick = (arg: EventClickArg) => {
    setSelectedId(arg.event.id);
  };

  const runScan = async () => {
    let keepStatus = false;
    setScanning(true);
    setScanStatus("");
    try {
      const r = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scanInbox", limit: 50 }),
      });
      // 409 = backend already has a scan in flight (e.g. user clicked, F5'd,
      // and the SetTimeout poll hadn't picked it up yet). Don't double-spawn;
      // let the mount-effect's polling loop handle the running scan.
      if (r.status === 409) {
        setScanStatus("A scan is already running");
        return;
      }
      const d = await readJson<{ scanned?: number; inserted?: number }>(r);
      if (!r.ok) {
        // 429 from the demo gateway: show its message as-is and keep it up.
        setScanStatus(aiErrorMessage(r, d, `Scan failed. HTTP ${r.status}`));
        keepStatus = r.status === 429;
        return;
      }
      if (d.scanned === 0) {
        setScanStatus("No new emails to scan");
      } else if (d.error) {
        setScanStatus(`Scanned ${d.scanned} emails. Extraction failed. ${d.error}`);
      } else {
        setScanStatus(`Scanned ${d.scanned} emails, added ${d.inserted} events`);
      }
      await fetchEvents();
    } catch (e) {
      setScanStatus(`Scan failed. ${String(e)}`);
    } finally {
      setScanning(false);
      if (!keepStatus) setTimeout(() => setScanStatus(""), 4000);
    }
  };

  const selected = selectedId ? events.find((e) => e.id === selectedId) : null;

  return (
    <div className="h-screen flex flex-col p-2 sm:p-4 pt-safe pb-safe">
      <div
        className="glass-panel flex h-full flex-col overflow-hidden"
        style={{ animation: "rise .64s var(--ease-out) both" }}
      >
        <div className="flex items-center gap-3 px-3 sm:px-4 py-3 shrink-0 border-b border-white/[0.06]">
          <Link href="/" className="rounded-md p-1 hover:bg-white/[.05]">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0
                       bg-[linear-gradient(135deg,#7ab7ff,#c4b5fd_50%,#6ee7b7)]
                       shadow-[0_6px_20px_rgba(122,183,255,.35),inset_0_1px_0_rgba(255,255,255,.4)]"
          >
            <CalendarDays className="h-4 w-4 text-[#0b0b10]" />
          </div>
          <h1 className="text-sm font-semibold tracking-tight">Calendar</h1>
          <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
            {events.length} events
          </span>
          <button
            onClick={runScan}
            disabled={scanning}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-white/[.06] hover:bg-white/[.10] disabled:opacity-50 px-3 py-1.5 text-xs font-medium transition"
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanLine className="h-3.5 w-3.5" />
            )}
            {scanning ? "Scanning…" : "Scan inbox"}
          </button>
        </div>

        {scanStatus && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-b border-white/[0.04]">
            {scanStatus}
          </div>
        )}

        <div className="flex-1 overflow-auto fc-wrap">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
            </div>
          ) : (
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
              initialView={isMobile ? "listWeek" : "dayGridMonth"}
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: isMobile
                  ? "listWeek,dayGridMonth"
                  : "dayGridMonth,timeGridWeek,timeGridDay,listWeek",
              }}
              buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day", list: "List" }}
              allDayText="All day"
              events={fcEvents}
              eventClick={onEventClick}
              height="100%"
              nowIndicator
              firstDay={0}
              dayMaxEvents={3}
              noEventsContent={
                <div className="text-center py-12 text-muted-foreground">
                  <CalendarDays className="h-8 w-8 opacity-50 mx-auto mb-2" />
                  <p className="text-sm">No events. Scan inbox to extract events from recent emails.</p>
                </div>
              }
            />
          )}
        </div>
      </div>

      {selected && <EventDetailSheet event={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

const EVENT_TIME_FMT: Intl.DateTimeFormatOptions = {
  weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
};

interface EmailFull {
  subject: string;
  from: string;
  fromEmail: string;
  body: string;
  bodyHtml: string;
  snippet: string;
  date: string;
}

function EventDetailSheet({ event, onClose }: { event: ApiEvent; onClose: () => void }) {
  const [email, setEmail] = useState<EmailFull | null>(null);
  const [loadingEmail, setLoadingEmail] = useState(true);

  useEffect(() => {
    setLoadingEmail(true);
    fetch(`/api/emails/${event.email_id}`)
      .then((r) => r.json())
      .then((d) => {
        const em = d?.email ?? d;
        if (em && em.id) {
          setEmail({
            subject: em.subject || "",
            from: em.from || em.from_name || "",
            fromEmail: em.fromEmail || em.from_email || "",
            body: em.body || "",
            bodyHtml: em.bodyHtml || em.body_html || "",
            snippet: em.snippet || "",
            date: em.date || "",
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoadingEmail(false));
  }, [event.email_id]);

  const startDate = new Date(event.start_ts * 1000);
  const endDate = event.end_ts ? new Date(event.end_ts * 1000) : null;

  const renderBody = () => {
    if (!email) return null;
    const htmlTags = /<(p|div|span|br|a|b|i|em|strong|ul|ol|li|h[1-6]|table|tr|td|th|img|blockquote|pre|code)\b/i;
    if (email.bodyHtml && htmlTags.test(email.bodyHtml)) {
      return (
        <div
          className={[
            "prose prose-sm max-w-none",
            "bg-white/[.02] rounded-md p-3",
            "[&_*]:!text-foreground [&_*]:!bg-transparent",
            "[&_a]:!text-[#7ab7ff] [&_a]:underline",
            "[&_table]:border-collapse [&_table]:w-full",
            "[&_td]:!border [&_td]:!border-foreground/30 [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top",
            "[&_th]:!border [&_th]:!border-foreground/30 [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top [&_th]:font-semibold",
          ].join(" ")}
        >
          <Letter html={email.bodyHtml} />
        </div>
      );
    }
    const cleaned = stripLLMContamination(email.body || "");
    if (!cleaned) {
      return <p className="text-xs text-muted-foreground italic">{cleanSnippet(email.snippet)}</p>;
    }
    const parsed = parseEmailBody(cleaned);
    return (
      <div className="text-sm">
        <EmailBodyView parsed={parsed} />
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end pointer-events-none pt-safe pb-safe">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm pointer-events-auto" onClick={onClose} />
      <div
        className="relative w-full max-w-[520px] h-full glass-panel m-2 sm:m-4 flex flex-col pointer-events-auto overflow-hidden"
        style={{ animation: "rise .3s var(--ease-out) both" }}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] shrink-0">
          <h2 className="text-sm font-semibold truncate flex-1">{event.title}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-white/[.06]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-auto flex-1">
          {/* Event meta */}
          <div className="p-4 space-y-3 text-sm border-b border-white/[0.06]">
            <div className="flex items-start gap-2">
              <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div>{startDate.toLocaleString("en-US", EVENT_TIME_FMT)}</div>
                {endDate && <div className="text-muted-foreground text-xs">Ends {endDate.toLocaleString("en-US", EVENT_TIME_FMT)}</div>}
              </div>
            </div>
            {event.location && (
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div>{event.location}</div>
              </div>
            )}
          </div>

          {/* Source email inline */}
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>Source email</span>
            </div>
            {loadingEmail ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : email ? (
              <>
                <div className="space-y-1">
                  <div className="text-sm font-medium">{email.subject}</div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{email.from}</span>
                    {email.fromEmail && <span className="opacity-60">{email.fromEmail}</span>}
                    {email.date && <span className="opacity-60">{email.date}</span>}
                  </div>
                </div>
                {renderBody()}
              </>
            ) : (
              <p className="text-xs text-muted-foreground italic">Email not found.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
