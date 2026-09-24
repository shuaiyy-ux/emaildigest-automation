import { randomBytes } from "crypto";
import type { Job, JobStatus, Command } from "./types";

const store = new Map<string, Job>();

function generateId(command: Command): string {
  return `j_${Date.now()}_${command}_${randomBytes(8).toString("hex")}`;
}

export function createJob(command: Command, user?: string): Job {
  const job: Job = {
    id: generateId(command),
    command,
    status: "running",
    result: "",
    startedAt: Date.now(),
    user,
  };
  store.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return store.get(id);
}

export function updateJob(id: string, update: Partial<Job>) {
  const job = store.get(id);
  if (job) {
    Object.assign(job, update);
  }
}

/** Resolve once the job leaves "running" (or after `timeoutMs`). */
export async function waitForJob(id: string, timeoutMs: number): Promise<Job | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = store.get(id);
    if (!job || job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  return store.get(id);
}

export function isCommandRunning(command: Command): boolean {
  for (const job of store.values()) {
    if (job.command === command && job.status === "running") return true;
  }
  return false;
}

// Clean up finished jobs older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [id, job] of store) {
    if (job.status !== "running" && job.startedAt < cutoff) store.delete(id);
  }
}, 600_000);
