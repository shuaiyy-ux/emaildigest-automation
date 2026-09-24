"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Command, JobStatus, StatusResponse } from "../types";

interface JobState {
  jobId: string | null;
  status: JobStatus | "idle";
  result: string | null;
  error: string | null;
  elapsed: number;
  remaining: number | null;
}

interface RunOptions {
  /** Soft countdown target (seconds). Used only for UI display via `remaining`. */
  timeoutSec?: number;
}

export function useJob() {
  const [state, setState] = useState<JobState>({
    jobId: null,
    status: "idle",
    result: null,
    error: null,
    elapsed: 0,
    remaining: null,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutSecRef = useRef<number | null>(null);

  const clearPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const run = useCallback(
    async (command: Command, args: string[] = [], opts: RunOptions = {}) => {
      clearPolling();
      timeoutSecRef.current = opts.timeoutSec ?? null;
      setState({
        jobId: null,
        status: "running",
        result: null,
        error: null,
        elapsed: 0,
        remaining: opts.timeoutSec ?? null,
      });

      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, args }),
        });

        if (!res.ok) {
          const err = await res.json();
          setState((s) => ({
            ...s,
            status: "error",
            error: err.error || "Request failed",
          }));
          return;
        }

        const { jobId } = await res.json();
        setState((s) => ({ ...s, jobId }));

        intervalRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/status/${jobId}`);
            const data: StatusResponse = await pollRes.json();
            const t = timeoutSecRef.current;
            const remaining = t !== null ? Math.max(0, t - data.elapsed) : null;

            setState((s) => ({
              ...s,
              status: data.status,
              elapsed: data.elapsed,
              remaining,
              result: data.result || null,
              error: data.error || null,
            }));

            if (data.status !== "running") {
              clearPolling();
            }
          } catch (e) {
            console.error("[useJob] poll error:", e);
          }
        }, 2000);
      } catch (e) {
        console.error("[useJob] run error:", e);
        setState((s) => ({
          ...s,
          status: "error",
          error: "Network connection failed",
        }));
      }
    },
    [clearPolling]
  );

  useEffect(() => {
    return clearPolling;
  }, [clearPolling]);

  return {
    ...state,
    isRunning: state.status === "running",
    isIdle: state.status === "idle",
    run,
  };
}

/* ── Standalone poller for callers that already have a jobId ─────────────── */

export interface PollOptions {
  /** Hard cutoff (seconds). Returns "timeout" when exceeded. */
  timeoutSec?: number;
  /** Poll interval (ms). Default 2000. */
  intervalMs?: number;
  /** Called on each poll with current elapsed/remaining. */
  onTick?: (state: { elapsed: number; remaining: number | null }) => void;
  /** Cancellation signal. */
  signal?: AbortSignal;
}

export interface PollResult {
  status: "done" | "error" | "timeout" | "cancelled";
  result: string | null;
  error: string | null;
  elapsed: number;
}

export async function pollJob(jobId: string, opts: PollOptions = {}): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? 2000;
  const startMs = Date.now();
  const deadlineMs = opts.timeoutSec ? startMs + opts.timeoutSec * 1000 : null;

  while (true) {
    if (opts.signal?.aborted) {
      return { status: "cancelled", result: null, error: null, elapsed: Math.floor((Date.now() - startMs) / 1000) };
    }
    if (deadlineMs !== null && Date.now() > deadlineMs) {
      return { status: "timeout", result: null, error: "Timed out", elapsed: opts.timeoutSec! };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await fetch(`/api/status/${jobId}`, opts.signal ? { signal: opts.signal } : undefined);
      const data: StatusResponse = await res.json();
      const remaining = opts.timeoutSec ? Math.max(0, opts.timeoutSec - data.elapsed) : null;
      opts.onTick?.({ elapsed: data.elapsed, remaining });
      if (data.status === "done") {
        return { status: "done", result: data.result || null, error: null, elapsed: data.elapsed };
      }
      if (data.status === "error") {
        return { status: "error", result: null, error: data.error || "Job failed", elapsed: data.elapsed };
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        return { status: "cancelled", result: null, error: null, elapsed: Math.floor((Date.now() - startMs) / 1000) };
      }
      console.error("[pollJob] poll error:", e);
    }
  }
}

/** Format remaining seconds as "Nm NNs" or "NNs". */
export function formatCountdown(secs: number | null): string {
  if (secs === null || secs < 0) return "";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
