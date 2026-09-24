import { spawn } from "child_process";
import path from "path";
import { createJob, updateJob } from "./jobs";
import { breakerOpen, recordSuccess, recordFailure, BreakerOpenError } from "./circuit-breaker";
import { flagAuthFailureIfMatch, clearAuthFailure } from "./auth-status";
import { isDemoMode } from "./demo";
import type { Command, Job } from "./types";

/**
 * Legacy path: the `./emaildigest` shell CLI, which drives the claude.ai
 * Gmail connector (search / read / create draft in the real mailbox). Only
 * `/api/run` and Push to Gmail use it, and only outside DEMO_MODE; both
 * helpers below refuse to spawn when DEMO_MODE=1, and the shell script
 * refuses too. All other model calls go through lib/claude-cli.ts.
 */
export const EMAILDIGEST_DIR = path.resolve(
  process.env.EMAILDIGEST_DIR || path.join(process.cwd(), "..")
);

const DEMO_REFUSAL = "the Gmail connector CLI is disabled in DEMO_MODE";

/**
 * Simple async exec — returns stdout string. For background jobs use runCommand.
 *
 * `bypassBreaker`: skip the circuit-breaker gate (used by the auth probe and
 * forceClassifyAsJob — see lib/circuit-breaker.ts for rationale).
 *
 * `signal`: AbortSignal propagated to the child process. When the caller's
 * request connection drops (user closes tab during a synchronous LLM call),
 * we SIGTERM the spawn so we don't keep burning Claude tokens for a client
 * that's gone. Doc §11 cooperative cancellation.
 */
export function execCommand(
  command: Command,
  args: string[] = [],
  opts?: { readonly?: boolean; bypassBreaker?: boolean; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (isDemoMode()) {
      reject(new Error(DEMO_REFUSAL));
      return;
    }
    if (!opts?.bypassBreaker && breakerOpen()) {
      reject(new BreakerOpenError());
      return;
    }
    if (opts?.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const env = { ...process.env };
    if (opts?.readonly) env.EMAILDIGEST_READONLY = "1";
    const proc = spawn("./emaildigest", [command, ...args], {
      cwd: EMAILDIGEST_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { proc.kill("SIGTERM"); } catch {}
    };
    opts?.signal?.addEventListener("abort", onAbort);
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      opts?.signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        // Caller already gave up; don't credit/debit the breaker either way.
        reject(new Error("aborted"));
        return;
      }
      if (code === 0) {
        recordSuccess();
        clearAuthFailure();
        resolve(stdout);
      } else {
        recordFailure();
        flagAuthFailureIfMatch(stderr, stdout, code);
        reject(new Error(`exit ${code}`));
      }
    });
    proc.on("error", (err) => {
      opts?.signal?.removeEventListener("abort", onAbort);
      recordFailure();
      reject(err);
    });
  });
}

export function runCommand(
  command: Command,
  args: string[] = [],
  opts?: { readonly?: boolean; bypassBreaker?: boolean; signal?: AbortSignal },
): Job {
  const job = createJob(command);

  if (isDemoMode()) {
    updateJob(job.id, { status: "error", error: DEMO_REFUSAL, finishedAt: Date.now() });
    return job;
  }

  if (!opts?.bypassBreaker && breakerOpen()) {
    updateJob(job.id, {
      status: "error",
      error: "claude breaker open — short-circuited",
      finishedAt: Date.now(),
    });
    return job;
  }

  const env = { ...process.env };
  if (opts?.readonly) env.EMAILDIGEST_READONLY = "1";
  const proc = spawn("./emaildigest", [command, ...args], {
    cwd: EMAILDIGEST_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { proc.kill("SIGTERM"); } catch {}
  };
  opts?.signal?.addEventListener("abort", onAbort);

  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on("close", (code) => {
    opts?.signal?.removeEventListener("abort", onAbort);
    if (aborted) {
      // Caller dropped — record cancellation, don't penalize the breaker.
      updateJob(job.id, {
        status: "error",
        result: stdout,
        error: "cancelled",
        finishedAt: Date.now(),
      });
      return;
    }
    if (code === 0) {
      recordSuccess();
      clearAuthFailure();
      updateJob(job.id, {
        status: "done",
        result: stdout,
        finishedAt: Date.now(),
      });
    } else {
      recordFailure();
      flagAuthFailureIfMatch(stderr, stdout, code);
      updateJob(job.id, {
        status: "error",
        result: stdout,
        error: stderr || `exit code ${code}`,
        finishedAt: Date.now(),
      });
    }
  });

  proc.on("error", (err) => {
    opts?.signal?.removeEventListener("abort", onAbort);
    recordFailure();
    updateJob(job.id, {
      status: "error",
      error: err.message,
      finishedAt: Date.now(),
    });
  });

  return job;
}
