/**
 * GET /api/demo — what the page needs to know about the demo session:
 * whether DEMO_MODE is on, which visitor this is, and the remaining AI quota
 * as reported by the gateway's X-Demo-Quota-* request headers (display only;
 * the gateway enforces it). Outside the demo: { demo: false, ... }.
 */
import { isDemoMode, getDemoUser, getDemoQuota } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json(
    { demo: isDemoMode(), user: getDemoUser(request), quota: getDemoQuota(request) },
    { headers: { "cache-control": "no-store" } },
  );
}
