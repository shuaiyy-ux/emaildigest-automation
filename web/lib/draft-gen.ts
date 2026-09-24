/**
 * Draft generation — one tool-less `claude -p` run via lib/claude-cli.ts.
 *
 * Draft generation is pure text output: no tools, no MCP, no Gmail. The
 * hardened runner gives it an empty cwd (no CLAUDE.md autoload, which used to
 * cost ~5s), no settings, no built-in tools and the prompt on stdin.
 *
 * Preserves:
 * - Job-store pattern (createJob/updateJob) so existing pollJob consumers work
 * - Claude CLI auth via the host's Claude login (reused automatically)
 * - Model choice via EMAILDIGEST_DRAFT_MODEL env var (default: sonnet)
 */
import { createJob, updateJob } from "./jobs";
import { runClaude } from "./claude-cli";
import type { Job } from "./types";

const DRAFT_MODEL = process.env.EMAILDIGEST_DRAFT_MODEL || "sonnet";
const DRAFT_TIMEOUT_MS = 125_000;

/**
 * Start a draft-generation run and return a Job that polls to completion.
 * Uses the "draftgen" command label so jobs.ts tracks it separately from
 * other jobs (avoids isCommandRunning collisions).
 *
 * `user`: visitor id; the job's status is only visible to that visitor.
 * `signal`: optional AbortSignal that SIGTERM-kills the spawn when the
 * caller gives up.
 */
export function generateDraft(prompt: string, opts?: { signal?: AbortSignal; user?: string }): Job {
  // "draftgen" is a virtual command for job-store bookkeeping; not a real shell command.
  const job = createJob("draftgen" as never, opts?.user);

  runClaude({
    label: "draft-gen",
    prompt,
    model: DRAFT_MODEL,
    timeoutMs: DRAFT_TIMEOUT_MS,
    signal: opts?.signal,
    breaker: "off",
  })
    .then(({ text, usage }) => {
      updateJob(job.id, { status: "done", result: text, usage, finishedAt: Date.now() });
    })
    .catch((e: Error & { usage?: Job["usage"] }) => {
      const error = e.message === "aborted" ? "cancelled" : e.message;
      updateJob(job.id, { status: "error", error, usage: e.usage, finishedAt: Date.now() });
    });

  return job;
}
