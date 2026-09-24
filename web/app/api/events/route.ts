import { listEventsInRange, listUpcomingEvents, listEmailsNeedingEventExtraction, getAppState, setAppState } from "@/lib/db";
import { extractEventsForBatch } from "@/lib/event-extractor";
import { collectUsage, usageHeader, EMPTY_USAGE } from "@/lib/demo-usage";

export const runtime = "nodejs";
export const maxDuration = 300;

// Same shape as the Haiku timeout in extractEventsForBatch (240s) plus 10s
// grace. Anything older than this window is treated as "scan died mid-flight",
// not "scan still running". See docs/design/state-boundary.md.
const SCAN_FRESHNESS_SEC = 250;

function readScanStatus(): { isRunning: boolean; startedAt: number | null } {
  const raw = getAppState("event_scan_started_at");
  const startedAt = raw ? Number(raw) : 0;
  if (!startedAt) return { isRunning: false, startedAt: null };
  const ageSec = Math.floor(Date.now() / 1000) - startedAt;
  if (ageSec > SCAN_FRESHNESS_SEC) {
    // Stale (process likely died). Drop the lock so the next click can
    // start a fresh scan instead of getting blocked forever.
    setAppState("event_scan_started_at", "");
    return { isRunning: false, startedAt: null };
  }
  return { isRunning: true, startedAt };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // State-boundary GET: client polls this to discover whether a scan is
  // currently running on the backend (e.g. after a page refresh that
  // dropped the original POST connection). Cheap — just an app_state read.
  if (searchParams.get("scanStatus") === "1") {
    return Response.json(readScanStatus());
  }
  const from = Number(searchParams.get("from") || 0);
  const to = Number(searchParams.get("to") || 0);
  if (from > 0 && to > from) {
    return Response.json({ events: listEventsInRange(from, to) });
  }
  // Default: upcoming 50 starting from now
  return Response.json({ events: listUpcomingEvents(Math.floor(Date.now() / 1000), 50) });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  // Manual scan: pull all SQL+regex-gated candidates and run ONE Haiku spawn.
  // Auto-extract on every IMAP IDLE / refresh was removed (was the dominant
  // spawn-count source pre-batch-refactor). Users now trigger via the
  // Calendar page "Scan inbox" button.
  if (body.action === "scanInbox") {
    // Reject if a fresh scan is already running. Without this guard, a
    // page refresh + re-click would burn a second Haiku spawn on the same
    // candidate set. The 409 carries `startedAt` so the frontend can show
    // "scan in progress since ..." and resume polling instead.
    const status = readScanStatus();
    if (status.isRunning) {
      return Response.json(
        { error: "scan_in_progress", startedAt: status.startedAt },
        { status: 409 },
      );
    }

    const limit = typeof body.limit === "number" ? Math.min(body.limit, 100) : 50;
    const emails = listEmailsNeedingEventExtraction(limit);
    if (emails.length === 0) {
      return Response.json({ scanned: 0, inserted: 0, perEmail: [] }, { headers: usageHeader(EMPTY_USAGE) });
    }
    setAppState("event_scan_started_at", String(Math.floor(Date.now() / 1000)));
    try {
      const { result, usage } = await collectUsage(() => extractEventsForBatch(emails, 240_000));
      return Response.json({
        scanned: emails.length,
        inserted: result.inserted,
        perEmail: result.perEmail,
        ...(result.error ? { error: result.error } : {}),
      }, { headers: usageHeader(usage) });
    } finally {
      setAppState("event_scan_started_at", "");
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
