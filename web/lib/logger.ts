/**
 * Structured logger — debug-friendly, queryable.
 *
 * Why: console.log scattered across lib/* makes debugging hard. We can grep
 * logs/next.log but can't filter by component / level / time window or
 * correlate across subprocess spawns. SQLite-backed structured logs let
 * us run plain SQL for incident triage:
 *
 *   -- last hour of email-digest activity
 *   SELECT ts, level, message, ctx FROM logs
 *   WHERE component='email-digest' AND ts > unixepoch() - 3600
 *   ORDER BY ts DESC;
 *
 *   -- everything correlated with one prefetch run
 *   SELECT * FROM logs WHERE trace_id='p_1717..._a3f' ORDER BY ts;
 *
 *   -- breaker state changes in last 24h
 *   SELECT ts, message FROM logs
 *   WHERE component='breaker' AND ts > unixepoch() - 86400;
 *
 * Design choices:
 *   - Dual write: stdout AND SQLite. Keeps `tail -f logs/next.log` working
 *     for the systemd / cloudwatch-style ops mental model, while adding a
 *     queryable historical store.
 *   - Async batch buffer: high-frequency `info` (per-email classify
 *     verdicts, breaker ticks) shouldn't block the event loop on each
 *     INSERT. Flush every 1s OR on 100-row buffer.
 *   - Levels: debug logs never persist (stdout only) — keep DB lean.
 *   - 7-day retention enforced at startup in db.ts.
 *
 * NOT included (deliberate scope):
 *   - Remote shipping (CloudWatch / Loki) — single-machine ops, file +
 *     SQLite is enough.
 *   - Distributed tracing — overkill for this codebase.
 *   - Sentry-style error grouping — `level='error'` with stack trace in
 *     ctx is sufficient.
 */
import db from "./db";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const ENV_LEVEL = (process.env.EMAILDIGEST_LOG_LEVEL || "info").toLowerCase() as LogLevel;
const MIN_LEVEL = LEVEL_ORDER[ENV_LEVEL] ?? 1;

interface BufferedRow {
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
  ctx: string | null;
  trace_id: string | null;
}

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH_SIZE = 100;
const buffer: BufferedRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive for the timer alone.
  if (typeof flushTimer === "object" && "unref" in flushTimer) {
    (flushTimer as { unref: () => void }).unref();
  }
}

type InsertParams = [number, LogLevel, string, string, string | null, string | null];
let insertMany: ((rows: BufferedRow[]) => void) | null = null;

function getInsertMany() {
  if (insertMany) return insertMany;
  const insertStmt = db.prepare<InsertParams>(
    "INSERT INTO logs (ts, level, component, message, ctx, trace_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertMany = db.transaction((rows: BufferedRow[]) => {
    for (const r of rows) {
      insertStmt.run(r.ts, r.level, r.component, r.message, r.ctx, r.trace_id);
    }
  });
  return insertMany;
}

function flushBuffer(): void {
  if (buffer.length === 0) return;
  const rows = buffer.splice(0, buffer.length);
  try {
    getInsertMany()(rows);
  } catch (e) {
    // If the DB write fails, drop the rows — we already printed to stdout
    // so observability isn't lost. Don't crash the caller for a log failure.
    console.error("[logger] flush failed, dropped", rows.length, "rows:", e);
  }
}

/** Serialize ctx safely. Errors get .stack + .message. Functions stripped.
 *  Circular refs caught and replaced with "[Circular]". */
function serializeCtx(ctx: object | undefined): string | null {
  if (!ctx) return null;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(ctx, (_k, v) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      if (typeof v === "function") return undefined;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return null;
  }
}

function fmtConsole(level: LogLevel, component: string, message: string, ctx?: object): string {
  const head = `[${component}] ${message}`;
  if (!ctx) return head;
  const ctxJson = serializeCtx(ctx);
  if (!ctxJson || ctxJson === "{}" || ctxJson === "null") return head;
  return `${head} ${ctxJson}`;
}

interface LogContext {
  component?: string;
  trace_id?: string;
}

function emit(level: LogLevel, component: string, message: string, ctx: object | undefined, traceId: string | null) {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;

  // Always print to stdout/stderr — preserves `tail -f logs/next.log`
  // visibility regardless of DB state.
  const text = fmtConsole(level, component, message, ctx);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);

  // debug logs do NOT persist — cuts SQLite churn for high-frequency
  // exploratory traces. Set EMAILDIGEST_LOG_LEVEL=debug if you want them.
  if (level === "debug") return;

  buffer.push({
    ts: Math.floor(Date.now() / 1000),
    level,
    component,
    message,
    ctx: serializeCtx(ctx),
    trace_id: traceId,
  });
  ensureTimer();
  if (buffer.length >= FLUSH_BATCH_SIZE) flushBuffer();
}

interface Logger {
  debug(component: string, message: string, ctx?: object): void;
  info(component: string, message: string, ctx?: object): void;
  warn(component: string, message: string, ctx?: object): void;
  error(component: string, message: string, ctx?: object): void;
  child(component: string): BoundLogger;
  trace(traceId: string): TraceLogger;
}

interface BoundLogger {
  debug(message: string, ctx?: object): void;
  info(message: string, ctx?: object): void;
  warn(message: string, ctx?: object): void;
  error(message: string, ctx?: object): void;
  trace(traceId: string): BoundTraceLogger;
}

interface TraceLogger {
  debug(component: string, message: string, ctx?: object): void;
  info(component: string, message: string, ctx?: object): void;
  warn(component: string, message: string, ctx?: object): void;
  error(component: string, message: string, ctx?: object): void;
  child(component: string): BoundTraceLogger;
}

interface BoundTraceLogger {
  debug(message: string, ctx?: object): void;
  info(message: string, ctx?: object): void;
  warn(message: string, ctx?: object): void;
  error(message: string, ctx?: object): void;
}

export const log: Logger = {
  debug: (c, m, x) => emit("debug", c, m, x, null),
  info:  (c, m, x) => emit("info",  c, m, x, null),
  warn:  (c, m, x) => emit("warn",  c, m, x, null),
  error: (c, m, x) => emit("error", c, m, x, null),
  child: (component: string): BoundLogger => ({
    debug: (m, x) => emit("debug", component, m, x, null),
    info:  (m, x) => emit("info",  component, m, x, null),
    warn:  (m, x) => emit("warn",  component, m, x, null),
    error: (m, x) => emit("error", component, m, x, null),
    trace: (traceId: string): BoundTraceLogger => ({
      debug: (m, x) => emit("debug", component, m, x, traceId),
      info:  (m, x) => emit("info",  component, m, x, traceId),
      warn:  (m, x) => emit("warn",  component, m, x, traceId),
      error: (m, x) => emit("error", component, m, x, traceId),
    }),
  }),
  trace: (traceId: string): TraceLogger => ({
    debug: (c, m, x) => emit("debug", c, m, x, traceId),
    info:  (c, m, x) => emit("info",  c, m, x, traceId),
    warn:  (c, m, x) => emit("warn",  c, m, x, traceId),
    error: (c, m, x) => emit("error", c, m, x, traceId),
    child: (component: string): BoundTraceLogger => ({
      debug: (m, x) => emit("debug", component, m, x, traceId),
      info:  (m, x) => emit("info",  component, m, x, traceId),
      warn:  (m, x) => emit("warn",  component, m, x, traceId),
      error: (m, x) => emit("error", component, m, x, traceId),
    }),
  }),
};

/** Generate a short unique-ish trace id for a logical workflow.
 *  Format: <prefix>_<unix>_<rand>. Used by prefetch / extract / API
 *  request handlers to correlate log lines across boundaries. */
export function newTraceId(prefix: string): string {
  return `${prefix}_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Force-flush the buffer. Call before known process exit windows
 *  (manual shutdown, test cleanup). Safe to call any time. */
export function flushLogs(): void {
  flushBuffer();
}
