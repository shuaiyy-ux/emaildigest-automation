/**
 * Reactive Claude CLI auth-failure detection.
 *
 * No periodic probe (deleted 2026-04-29). Every direct-spawn LLM path
 * (subprocess.ts, event-extractor, daily-digest, draft-gen) calls
 * `flagAuthFailureIfMatch` on non-zero exit. If stderr/stdout contains
 * an auth-error keyword, app_state.claude_auth_status flips to "failed"
 * → UI shows the red banner.
 *
 * The next *successful* call (any path) calls `clearAuthFailure` to flip
 * back to "ok".
 *
 * Trade-off vs. the old 30-min probe: if no LLM activity happens for hours
 * AND auth silently expires, the UI shows stale "ok" until the next call.
 * Acceptable because (a) PROD is busy enough that real calls fire frequently,
 * (b) "ok" with no calls happening means the user isn't doing anything that
 * would be impacted, and (c) the next call surfaces the error immediately.
 */
import { setAppState, getAppState } from "./db";
import { log } from "./logger";

const AUTH_FAILURE_RE = /\b(unauthor(ized|ised)|authentic|login required|session (has )?expired|invalid api key|not logged in|please (re)?login|token (invalid|expired))\b/i;

export function flagAuthFailureIfMatch(stderr: string, stdout: string, code: number | null): void {
  if (code === 0) return;
  const blob = `${stderr}\n${stdout}`;
  if (!AUTH_FAILURE_RE.test(blob)) return;
  try {
    const before = getAppState("claude_auth_status");
    setAppState("claude_auth_status", "failed");
    setAppState("claude_auth_error", blob.slice(0, 200).trim());
    setAppState("claude_auth_checked_at", String(Math.floor(Date.now() / 1000)));
    if (before !== "failed") {
      log.warn("auth", "Claude CLI auth failure detected — banner up", { snippet: blob.slice(0, 200).trim() });
    }
  } catch (e) {
    // Don't let a telemetry write block the caller — it's already failing.
    log.error("auth", "failed to record auth failure", { err: e });
  }
}

export function clearAuthFailure(): void {
  try {
    const before = getAppState("claude_auth_status");
    setAppState("claude_auth_status", "ok");
    setAppState("claude_auth_error", "");
    setAppState("claude_auth_checked_at", String(Math.floor(Date.now() / 1000)));
    if (before === "failed") {
      log.info("auth", "Claude CLI auth recovered");
    }
  } catch (e) {
    log.error("auth", "failed to clear auth failure", { err: e });
  }
}
