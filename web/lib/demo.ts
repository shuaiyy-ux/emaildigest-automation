/**
 * DEMO_MODE — the single server-side switch for the public, token-gated demo.
 *
 * When `DEMO_MODE=1`:
 *   - the demo gateway (a separate process in front of this app) authenticates
 *     visitors, counts AI calls and writes the visitor log; this app skips its
 *     own token middleware and listens on 127.0.0.1 only
 *   - nothing reaches the outside world: no IMAP, no SMTP, no Gmail connector,
 *     no web push, no model download (see instrumentation.ts, lib/smtp.ts,
 *     lib/push.ts, lib/embedder.ts, app/api/drafts, app/api/run)
 *   - conversations, chat history and drafts are scoped per visitor via the
 *     `X-Demo-User` request header the gateway sets
 *
 * This module has no Node-only imports so the edge middleware can use it.
 */

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** Visitor ids the gateway issues are short slugs (owner, v1, v2, v3). */
const DEMO_USER_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Bucket for DEMO_MODE requests that arrive without a usable X-Demo-User. */
export const ANONYMOUS_DEMO_USER = "anonymous";
export const OWNER_DEMO_USER = "owner";

/**
 * Who is asking. Outside DEMO_MODE this is always `owner` (single-user app).
 * In DEMO_MODE the gateway strips any client-supplied X-Demo-User and writes
 * its own; a missing or malformed value falls into a separate bucket so it can
 * never read the owner's conversations or drafts.
 */
export function getDemoUser(req: Request): string {
  if (!isDemoMode()) return OWNER_DEMO_USER;
  const raw = (req.headers.get("x-demo-user") || "").trim();
  return DEMO_USER_RE.test(raw) ? raw : ANONYMOUS_DEMO_USER;
}

export interface DemoQuota {
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
}

/** Display-only: the gateway decides; the app never enforces. */
export function getDemoQuota(req: Request): DemoQuota | null {
  const limitRaw = req.headers.get("x-demo-quota-limit");
  const remainingRaw = req.headers.get("x-demo-quota-remaining");
  if (limitRaw === null && remainingRaw === null) return null;
  const unlimited = limitRaw === "unlimited" || remainingRaw === "unlimited";
  const toNum = (v: string | null) => {
    if (v === null || v === "unlimited") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return { limit: toNum(limitRaw), remaining: toNum(remainingRaw), unlimited };
}

/** JSON body for endpoints that are switched off in DEMO_MODE. */
export function demoDisabledResponse(message: string, status = 403): Response {
  return Response.json({ error: "demo_disabled", message }, { status });
}
