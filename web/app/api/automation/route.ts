/**
 * GET /api/automation            → overview: date range, emails per day, live counts
 * GET /api/automation?day=Y-M-D  → replay data for one day (timestamps only)
 *
 * Read-only; never calls a model. See lib/automation.ts.
 */
import { getAutomationOverview, getReplayDay } from "@/lib/automation";
import { isDemoMode } from "@/lib/demo";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const day = new URL(request.url).searchParams.get("day");
  if (day) {
    const replay = getReplayDay(day);
    if (!replay) return Response.json({ error: "invalid day" }, { status: 400 });
    return Response.json(replay);
  }
  return Response.json({ ...getAutomationOverview(), demo: isDemoMode() });
}
