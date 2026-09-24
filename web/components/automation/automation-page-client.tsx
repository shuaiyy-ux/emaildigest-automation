"use client";

/**
 * /automation — how the pipeline runs, built from this mailbox's DB timestamps.
 *
 *   Pipeline   IMAP IDLE → local SetFit classifier (θ 0.80) → LLM fallback
 *              → event extraction → draft
 *   Replay     one day of this mailbox, email by email, animated at an accelerated
 *              clock; built from DB timestamps only (no model calls)
 *   Figures    production measurements quoted from the repo docs, plus live
 *              counts from this database
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Pause, Play, RotateCcw, Workflow } from "lucide-react";
import { useDemo } from "@/components/demo/demo-context";
import { DemoWatermark } from "@/components/demo/demo-marks";
import { cn } from "@/lib/utils";

type ClassifierKind = "local" | "llm" | "user" | "none" | "other";

interface Overview {
  tz: string;
  snapshot: boolean;
  demo: boolean;
  range: { first: number | null; last: number | null };
  days: Array<{ day: string; emails: number }>;
  counts: {
    emails: number;
    local: number;
    llm: number;
    user: number;
    unclassified: number;
    other: number;
    events: number;
    emailsWithEvents: number;
    drafts: number;
    jobEmails: number;
  };
}

interface ReplayItem {
  id: string;
  receivedAt: number;
  subject: string;
  from: string;
  classifier: ClassifierKind;
  classifiedAt: number | null;
  event: { at: number; title: string; count: number } | null;
  draft: { at: number; type: string } | null;
  job: { at: number; stage: string } | null;
}

interface ReplayDay {
  day: string;
  tz: string;
  dayStart: number;
  dayEnd: number;
  items: ReplayItem[];
}

// Classification routes. Hues validated for the dark surface (dataviz
// validator: lightness band, CVD separation, contrast all pass).
const ROUTE: Record<ClassifierKind, { label: string; color: string }> = {
  local: { label: "Local model", color: "#12a877" },
  llm: { label: "LLM fallback", color: "#3b82f6" },
  user: { label: "User", color: "#c27d0e" },
  other: { label: "Other", color: "#8a8a94" },
  none: { label: "Not classified", color: "#55555e" },
};
// Same surface as .glass-card, without its hover lift (these are large panels).
const PANEL = "border border-white/[0.08] bg-[var(--glass-bg)] backdrop-blur-[20px]";

const ROUTE_ORDER: ClassifierKind[] = ["local", "llm", "user", "other", "none"];

const SPEEDS = [
  { value: 1440, label: "1 day in 60 s" },
  { value: 4320, label: "1 day in 20 s" },
  { value: 288, label: "1 day in 5 min" },
];

const SOURCES = [
  "docs/analysis/2026-04-27-token-usage.md",
  "docs/changelog/2026-05-04-setfit-4way-classify.md",
];

// Production measurements, quoted from the docs above (index into SOURCES).
const FIGURES: Array<{ label: string; value: string; note: string; source: number }> = [
  { label: "Model calls per day", value: "464 → 131–155", note: "Apr 22 vs Apr 25–26", source: 0 },
  { label: "Tokens per day", value: "69.5M → 22.4–28.3M", note: "same days", source: 0 },
  { label: "Local classifier, held-out accuracy", value: "97.1%", note: "34 of 35 emails", source: 1 },
  { label: "Local classifier, training accuracy", value: "97.8%", note: "354 emails", source: 1 },
  { label: "Local classifier, encode time", value: "21 ms", note: "per email, M1 CPU", source: 1 },
  { label: "Model calls per day with the local classifier", value: "~30 → ~11", note: "projection", source: 1 },
];

function formatDay(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000));
}

function formatClock(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts * 1000));
}

function formatDayOption(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/** "+42s", "+3m", "+2h", "+4d". */
function formatDelta(sec: number): string {
  if (sec < 60) return `+${Math.max(0, Math.round(sec))}s`;
  if (sec < 3600) return `+${Math.round(sec / 60)}m`;
  if (sec < 86400) return `+${Math.round(sec / 3600)}h`;
  return `+${Math.round(sec / 86400)}d`;
}

export function AutomationPageClient() {
  const demo = useDemo();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayDay | null>(null);

  useEffect(() => {
    fetch("/api/automation")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((o: Overview) => {
        setOverview(o);
        const busiest = [...o.days].sort((a, b) => b.emails - a.emails || a.day.localeCompare(b.day))[0];
        setDay(busiest?.day ?? null);
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    fetch(`/api/automation?day=${day}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ReplayDay) => { if (!cancelled) setReplay(d); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [day]);

  const tz = overview?.tz ?? "America/Los_Angeles";
  const rangeText = overview?.range.first && overview.range.last
    ? `${formatDay(overview.range.first, tz)} to ${formatDay(overview.range.last, tz)}`
    : null;

  return (
    <div
      className="flex flex-col text-foreground glass-panel m-4"
      style={{
        animation: "rise .64s var(--ease-out) both",
        height: "calc(100vh - 32px - var(--demo-banner-h, 0px) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
        marginTop: "calc(1rem + env(safe-area-inset-top, 0px))",
        marginBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <Link href="/" className="rounded-md p-1 hover:bg-white/[.05]" aria-label="Back to inbox">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div
          className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0
                     bg-[linear-gradient(135deg,#6ee7b7,#7ab7ff_50%,#c4b5fd)]
                     shadow-[0_4px_14px_rgba(110,231,183,.25),inset_0_1px_0_rgba(255,255,255,.4)]"
        >
          <Workflow className="h-3.5 w-3.5 text-[#0b0b10]" strokeWidth={2.5} />
        </div>
        <h1 className="text-lg font-semibold">Automation</h1>
        {rangeText && (
          <p className="ml-auto text-xs text-[var(--fg-dim)]">
            {demo ? `Built from real April and May 2026 mail. Anonymized, with dates shifted to ${rangeText}` : `Data ${rangeText}`}
          </p>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        {loadError ? (
          <p className="p-6 text-sm text-rose-300">Loading pipeline data failed. {loadError}</p>
        ) : !overview ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <PipelineDiagram demo={demo} className="lg:col-span-2" />
            <ReplayPanel
              key={day ?? ""}
              days={overview.days}
              day={day}
              onDay={setDay}
              replay={replay && replay.day === day ? replay : null}
            />
            <FiguresPanel overview={overview} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Pipeline diagram ─────────────────────────────────────────────── */

const STEPS: Array<{ name: string; facts: string[]; offInDemo?: boolean }> = [
  { name: "IMAP IDLE", facts: ["Gmail pushes new mail", "starts the prefetch"], offInDemo: true },
  { name: "Local classifier", facts: ["SetFit on MiniLM, 4 categories", "accepts top-1 ≥ 0.80"] },
  { name: "LLM fallback", facts: ["Claude Sonnet, batched", "only emails below 0.80"] },
  { name: "Event extraction", facts: ["Claude Haiku", "one batched call per scan"] },
  { name: "Draft", facts: ["Claude Sonnet, on request", "send needs confirmation"] },
];

function PipelineDiagram({ demo, className }: { demo: boolean; className?: string }) {
  return (
    <section className={cn("relative rounded-xl p-4 " + PANEL, className)} aria-label="Pipeline">
      <h2 className="text-sm font-semibold">Pipeline</h2>
      {/* ≥ 0.80 skips the LLM: arc from the classifier (col 2) to event extraction (col 4). */}
      <div className="relative mt-3 hidden lg:block h-7" aria-hidden>
        <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          <path d="M30 20 C 32 2, 68 2, 70 20" fill="none" stroke="#12a877" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded bg-[#0d1512] px-1.5 text-[11px] font-medium text-[#6ee7b7]">
          top-1 ≥ 0.80
        </span>
      </div>
      <ol className="mt-2 grid gap-2 lg:mt-0 lg:grid-cols-5 lg:gap-0">
        {STEPS.map((step, i) => (
          <li key={step.name} className="flex flex-col lg:flex-row lg:items-stretch">
            <div className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{step.name}</span>
                {demo && step.offInDemo && (
                  <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--fg-dim)]">off in demo</span>
                )}
              </div>
              {step.facts.map((f) => (
                <p key={f} className="mt-0.5 text-xs text-[var(--fg-dim)]">{f}</p>
              ))}
            </div>
            {i < STEPS.length - 1 && (
              <div className="relative flex items-center justify-center py-1 lg:w-8 lg:py-0" aria-hidden>
                <svg viewBox="0 0 24 24" className="h-4 w-4 rotate-90 text-[var(--fg-muted)] lg:rotate-0">
                  <path d="M4 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {i === 1 && (
                  <span className="ml-1 whitespace-nowrap text-[11px] font-medium text-[#93b8f5] lg:absolute lg:left-1/2 lg:top-full lg:ml-0 lg:mt-1 lg:-translate-x-1/2">
                    top-1 &lt; 0.80
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ── Replay ───────────────────────────────────────────────────────── */

function ReplayPanel({ days, day, onDay, replay }: {
  days: Overview["days"];
  day: string | null;
  onDay: (d: string) => void;
  replay: ReplayDay | null;
}) {
  const dayLen = replay ? replay.dayEnd - replay.dayStart : 86400;
  // Clock = seconds since local midnight. Starts at the end: the full day is
  // shown until Play. The parent remounts this panel per day (key), which
  // resets the clock.
  const [clock, setClockState] = useState(dayLen);
  const clockRef = useRef(dayLen);
  const setClock = useCallback((v: number) => { clockRef.current = v; setClockState(v); }, []);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[0].value);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const next = Math.min(dayLen, clockRef.current + ((t - last) / 1000) * speed);
      last = t;
      setClock(next);
      if (next >= dayLen) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, dayLen, setClock]);

  const ended = clock >= dayLen;
  const now = replay ? replay.dayStart + clock : 0;
  const visible = useMemo(
    () => (replay ? replay.items.filter((it) => ended || it.receivedAt <= now) : []),
    [replay, ended, now],
  );

  // Keep the newest arrival in view while playing.
  useEffect(() => {
    if (playing && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [playing, visible.length]);

  const togglePlay = useCallback(() => {
    if (playing) { setPlaying(false); return; }
    if (clockRef.current >= dayLen) setClock(0);
    setPlaying(true);
  }, [playing, dayLen, setClock]);

  const perRoute = useMemo(() => {
    const counts: Record<ClassifierKind, number> = { local: 0, llm: 0, user: 0, other: 0, none: 0 };
    for (const it of replay?.items ?? []) counts[it.classifier]++;
    return counts;
  }, [replay]);

  return (
    <section className={"relative flex flex-col rounded-xl p-4 " + PANEL} aria-label="Replay of one day">
      <DemoWatermark />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold">Replay</h2>
        <label className="sr-only" htmlFor="replay-day">Day</label>
        <select
          id="replay-day"
          value={day ?? ""}
          onChange={(e) => onDay(e.target.value)}
          className="h-8 rounded-md border border-white/[0.1] bg-[#111217] px-2 text-xs"
        >
          {days.map((d) => (
            <option key={d.day} value={d.day}>
              {formatDayOption(d.day)}, {d.emails} {d.emails === 1 ? "email" : "emails"}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="replay-speed">Speed</label>
        <select
          id="replay-speed"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="h-8 rounded-md border border-white/[0.1] bg-[#111217] px-2 text-xs"
        >
          {SPEEDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button
          onClick={togglePlay}
          disabled={!replay}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/[0.08] px-3 text-xs font-medium hover:bg-white/[0.12] disabled:opacity-40"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => { setPlaying(false); setClock(0); }}
          disabled={!replay}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-[var(--fg-dim)] hover:bg-white/[0.06] disabled:opacity-40"
          aria-label="Restart"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      {!replay ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="font-mono text-2xl tabular-nums">
              {ended ? "24:00" : formatClock(now, replay.tz)}
            </span>
            <span className="text-xs text-[var(--fg-dim)]">
              {visible.length} of {replay.items.length} received
            </span>
          </div>

          <DayTrack replay={replay} clock={clock} ended={ended} />

          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--fg-dim)]" aria-label="Legend">
            {ROUTE_ORDER.filter((k) => perRoute[k] > 0 || k === "local" || k === "llm").map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: ROUTE[k].color }} />
                <span>{ROUTE[k].label}</span>
                <span className="tabular-nums text-foreground/80">{perRoute[k]}</span>
              </li>
            ))}
          </ul>

          <div ref={listRef} className="mt-3 max-h-[30rem] min-h-[12rem] overflow-y-auto rounded-lg border border-white/[0.06]">
            {replay.items.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No emails were received on this day.</p>
            ) : visible.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No email yet at {formatClock(now, replay.tz)}.</p>
            ) : (
              <ol className="divide-y divide-white/[0.05]">
                {visible.map((it) => (
                  <ReplayRow key={it.id} item={it} now={now} ended={ended} tz={replay.tz} />
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function DayTrack({ replay, clock, ended }: { replay: ReplayDay; clock: number; ended: boolean }) {
  const dayLen = replay.dayEnd - replay.dayStart;
  const [hover, setHover] = useState<ReplayItem | null>(null);
  const pct = (sec: number) => `${Math.min(100, Math.max(0, (sec / dayLen) * 100))}%`;
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  return (
    <div className="mt-3">
      <div className="relative h-9 rounded-md bg-white/[0.03]" onMouseLeave={() => setHover(null)}>
        {ticks.slice(1, -1).map((h) => (
          <span key={h} className="absolute inset-y-0 w-px bg-white/[0.06]" style={{ left: pct(h * 3600) }} />
        ))}
        {replay.items.map((it) => {
          const x = it.receivedAt - replay.dayStart;
          const arrived = ended || x <= clock;
          const color = ROUTE[it.classifier].color;
          return (
            <button
              key={it.id}
              type="button"
              className="absolute top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: pct(x) }}
              onMouseEnter={() => setHover(it)}
              onFocus={() => setHover(it)}
              onBlur={() => setHover(null)}
              aria-label={`${formatClock(it.receivedAt, replay.tz)} ${ROUTE[it.classifier].label}: ${it.subject}`}
            >
              <span
                className="block h-2.5 w-2.5 rounded-full"
                style={arrived
                  ? { background: color, boxShadow: "0 0 0 2px #0e0f14" }
                  : { border: `1.5px solid ${color}`, opacity: 0.45 }}
              />
            </button>
          );
        })}
        {!ended && (
          <span className="pointer-events-none absolute inset-y-[-4px] w-0.5 rounded bg-white/80" style={{ left: pct(clock) }} />
        )}
        {hover && (
          <div
            className="pointer-events-none absolute bottom-full z-20 mb-2 w-64 -translate-x-1/2 rounded-md border border-white/[0.1] bg-[#15161c] px-2.5 py-1.5 text-xs shadow-xl"
            style={{ left: `clamp(8rem, ${pct(hover.receivedAt - replay.dayStart)}, calc(100% - 8rem))` }}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono tabular-nums">{formatClock(hover.receivedAt, replay.tz)}</span>
              <span className="text-[var(--fg-dim)]">{ROUTE[hover.classifier].label}</span>
            </div>
            <div className="mt-0.5 truncate">{hover.subject || "No subject"}</div>
          </div>
        )}
      </div>
      <div className="relative mt-1 h-4 text-[10px] tabular-nums text-[var(--fg-muted)]">
        {ticks.map((h) => (
          <span
            key={h}
            className={cn("absolute", h === 0 ? "" : h === 24 ? "-translate-x-full" : "-translate-x-1/2")}
            style={{ left: pct(h * 3600) }}
          >
            {String(h).padStart(2, "0")}:00
          </span>
        ))}
      </div>
    </div>
  );
}

function StageChip({ label, at, receivedAt, now, ended, dot }: {
  label: string;
  at: number | null;
  receivedAt: number;
  now: number;
  ended: boolean;
  dot?: string;
}) {
  const done = at === null || ended || at <= now;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px]",
        done ? "border-white/[0.1] bg-white/[0.04] text-foreground/90" : "border-dashed border-white/[0.12] text-[var(--fg-muted)]",
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot, opacity: done ? 1 : 0.4 }} />}
      <span>{label}</span>
      {at !== null && <span className="tabular-nums text-[var(--fg-dim)]">{formatDelta(at - receivedAt)}</span>}
    </span>
  );
}

function ReplayRow({ item, now, ended, tz }: { item: ReplayItem; now: number; ended: boolean; tz: string }) {
  const route = ROUTE[item.classifier];
  return (
    <li className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 px-3 py-2">
      <span className="pt-0.5 font-mono text-xs tabular-nums text-[var(--fg-dim)]">{formatClock(item.receivedAt, tz)}</span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 max-w-[40%] truncate text-xs text-[var(--fg-dim)]">{item.from}</span>
          <span className="truncate text-[13px]">{item.subject || "No subject"}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StageChip
            label={route.label}
            dot={route.color}
            at={item.classifier === "none" ? null : item.classifiedAt}
            receivedAt={item.receivedAt}
            now={now}
            ended={ended}
          />
          {item.event && (
            <StageChip
              label={item.event.count > 1 ? `${item.event.count} events` : `Event: ${item.event.title}`}
              at={item.event.at}
              receivedAt={item.receivedAt}
              now={now}
              ended={ended}
            />
          )}
          {item.job && (
            <StageChip label={`Job tracker: ${item.job.stage.replace(/_/g, " ")}`} at={item.job.at} receivedAt={item.receivedAt} now={now} ended={ended} />
          )}
          {item.draft && (
            <StageChip label={`Draft: ${item.draft.type}`} at={item.draft.at} receivedAt={item.receivedAt} now={now} ended={ended} />
          )}
        </div>
      </div>
    </li>
  );
}

/* ── Figures ──────────────────────────────────────────────────────── */

function FiguresPanel({ overview }: { overview: Overview }) {
  const c = overview.counts;
  const routes: Array<{ kind: ClassifierKind; n: number }> = [
    { kind: "local", n: c.local },
    { kind: "llm", n: c.llm },
    { kind: "user", n: c.user },
    { kind: "other", n: c.other },
    { kind: "none", n: c.unclassified },
  ];
  const total = Math.max(1, c.emails);

  return (
    <aside className="flex flex-col gap-4">
      <section className={"relative rounded-xl p-4 " + PANEL} aria-label="Production figures">
        <h2 className="text-sm font-semibold">Production figures</h2>
        <dl className="mt-3 space-y-3">
          {FIGURES.map((f) => (
            <div key={f.label}>
              <dt className="text-xs text-[var(--fg-dim)]">{f.label}</dt>
              <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                <span className="text-base font-semibold tabular-nums">{f.value}</span>
                <span className="text-xs text-[var(--fg-muted)]">{f.note}</span>
                <sup className="text-[10px] text-[var(--fg-muted)]">[{f.source + 1}]</sup>
              </dd>
            </div>
          ))}
        </dl>
        <ol className="mt-4 space-y-0.5 border-t border-white/[0.06] pt-2 text-[10px] text-[var(--fg-muted)]">
          {SOURCES.map((s, i) => (
            <li key={s}><span className="tabular-nums">[{i + 1}]</span> <code className="font-mono">{s}</code></li>
          ))}
        </ol>
      </section>

      <section className={"relative rounded-xl p-4 " + PANEL} aria-label="This database">
        <DemoWatermark className="top-3 right-3" />
        <h2 className="text-sm font-semibold">This database</h2>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{c.emails}</span>
          <span className="text-xs text-[var(--fg-dim)]">emails</span>
        </div>
        <div className="mt-2 flex h-2 w-full gap-[2px] overflow-hidden rounded-full" role="img"
             aria-label={routes.map((r) => `${ROUTE[r.kind].label} ${r.n}`).join(", ")}>
          {routes.filter((r) => r.n > 0).map((r) => (
            <span key={r.kind} style={{ width: `${(r.n / total) * 100}%`, background: ROUTE[r.kind].color }} />
          ))}
        </div>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
          {routes.filter((r) => r.n > 0 || r.kind === "local" || r.kind === "llm").map((r) => (
            <div key={r.kind} className="contents">
              <dt className="inline-flex items-center gap-1.5 text-[var(--fg-dim)]">
                <span className="h-2 w-2 rounded-full" style={{ background: ROUTE[r.kind].color }} />
                {ROUTE[r.kind].label}
              </dt>
              <dd className="text-right tabular-nums">{r.n}</dd>
            </div>
          ))}
          <dt className="mt-2 text-[var(--fg-dim)]">Events extracted</dt>
          <dd className="mt-2 text-right tabular-nums">{c.events}</dd>
          <dt className="text-[var(--fg-dim)]">Emails with events</dt>
          <dd className="text-right tabular-nums">{c.emailsWithEvents}</dd>
          <dt className="text-[var(--fg-dim)]">Job tracker emails</dt>
          <dd className="text-right tabular-nums">{c.jobEmails}</dd>
          <dt className="text-[var(--fg-dim)]">Drafts</dt>
          <dd className="text-right tabular-nums">{c.drafts}</dd>
        </dl>
      </section>
    </aside>
  );
}
