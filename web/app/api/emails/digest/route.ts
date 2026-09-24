/**
 * Email digest — long-form summary of Primary / Track / News over the
 * last 48h. Junk excluded by design.
 *
 *   GET  /api/emails/digest          → { digest, refreshing }
 *   POST /api/emails/digest          → force regeneration, returns fresh digest
 *
 * GET is lazy-scheduled: if the cache is stale (≥ 2h old AND new mail has
 * arrived since), triggers a background regeneration (in-process lock so
 * multiple clients don't stampede) and returns the stale copy immediately.
 * Client should poll every ~10s until `refreshing: false`.
 * DEMO_MODE: GET never starts a regeneration (lib/email-digest.ts).
 *
 * POST carries X-Demo-Usage (model usage of the regeneration) for the demo gateway.
 */
import { ensureEmailDigest, generateEmailDigest, clearEmailDigestError } from "@/lib/email-digest";
import { collectUsage, usageHeader } from "@/lib/demo-usage";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET() {
  const state = ensureEmailDigest();
  return Response.json(state);
}

export async function POST() {
  clearEmailDigestError();
  const { result, usage } = await collectUsage(async () => {
    try {
      const digest = await generateEmailDigest();
      return { ok: true as const, digest };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
  const headers = usageHeader(usage);
  if (!result.ok) return Response.json({ error: result.error }, { status: 500, headers });
  return Response.json({ digest: result.digest, refreshing: false, error: null }, { headers });
}
