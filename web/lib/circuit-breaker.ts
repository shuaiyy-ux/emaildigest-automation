/**
 * Circuit breaker for Claude CLI subprocess calls.
 *
 * Why: 04-23 PROD incident — Claude CLI was unavailable for ~13h. Every
 * cron / IDLE / prefetch retry kept spawning claude → instant exit 1, no
 * backoff, no suppression. Result: 1213 stub jsonls + 2328 stack traces
 * from a 13-hour window of essentially zero useful work.
 *
 * What: classic 3-state breaker with exponential open-window backoff.
 *   closed → 3 consecutive failures → open(5m)
 *   open   → window elapsed → half-open
 *   half-open → next call probes → success closes, failure re-opens with
 *               doubled window (cap 30m)
 *   any state → success → closed (reset)
 *
 * Bypass list (callers pass `bypassBreaker: true`):
 *   - instrumentation auth probe (it IS the recovery signal)
 *   - forceClassifyAsJob (user explicit action — must not silently fail)
 *
 * Naturally not gated (direct spawn, doesn't touch subprocess.ts):
 *   - /api/chat (user online)
 *   - draft-gen (user clicking AI Generate)
 *
 * In-memory state only. Restart resets to closed — fine, the next failure
 * just re-trips. We log every state transition so a grep of next.log
 * shows the breaker history.
 */

import { log } from "./logger";

type State = "closed" | "open" | "half-open";

const FAIL_THRESHOLD = 3;
const INITIAL_OPEN_MS = 5 * 60_000;
const MAX_OPEN_MS = 30 * 60_000;

let state: State = "closed";
let consecutiveFails = 0;
let openUntilMs = 0;
let currentBackoffMs = INITIAL_OPEN_MS;

function transition(next: State, reason: string) {
  if (state === next) return;
  log.info("breaker", `${state} → ${next}`, { reason });
  state = next;
}

/**
 * Check whether the next call should short-circuit instead of spawning.
 * Side effect: an `open` state whose window has elapsed flips to
 * `half-open` here, allowing the next call through as a probe.
 */
export function breakerOpen(): boolean {
  if (state === "open") {
    if (Date.now() >= openUntilMs) {
      transition("half-open", "open window elapsed → probe next call");
      return false;  // allow this one through as the probe
    }
    return true;
  }
  return false;  // closed or half-open both let the call proceed
}

/** Caller observed a successful claude exit (code 0). */
export function recordSuccess() {
  if (state !== "closed") {
    transition("closed", "success");
  }
  consecutiveFails = 0;
  currentBackoffMs = INITIAL_OPEN_MS;
}

/** Caller observed a failed claude exit (non-zero / spawn error / timeout). */
export function recordFailure() {
  consecutiveFails++;
  if (state === "half-open") {
    // Probe failed → reopen with doubled backoff
    currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_OPEN_MS);
    openUntilMs = Date.now() + currentBackoffMs;
    transition("open", `probe failed → backoff ${Math.round(currentBackoffMs / 60_000)}m`);
    return;
  }
  if (state === "closed" && consecutiveFails >= FAIL_THRESHOLD) {
    currentBackoffMs = INITIAL_OPEN_MS;
    openUntilMs = Date.now() + currentBackoffMs;
    transition("open", `${consecutiveFails} consecutive failures → backoff ${Math.round(currentBackoffMs / 60_000)}m`);
  }
}

/** Telemetry for /api/status or admin views (not used yet). */
export function getBreakerStatus() {
  return {
    state,
    consecutiveFails,
    openUntilMs,
    currentBackoffMs,
  };
}

/** Test-only: force back to clean state. */
export function _resetForTest() {
  state = "closed";
  consecutiveFails = 0;
  openUntilMs = 0;
  currentBackoffMs = INITIAL_OPEN_MS;
}

/** Custom error so callers can distinguish breaker-block from real failures. */
export class BreakerOpenError extends Error {
  constructor() {
    super("claude breaker open — short-circuited");
    this.name = "BreakerOpenError";
  }
}
