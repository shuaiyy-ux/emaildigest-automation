/** Job-search visual helpers — stage → column mapping, colors, labels. */

export type JobColumn =
  | "applied"
  | "acknowledged"
  | "interview_scheduled"
  | "interviewed"
  | "offer"
  | "closed";

export const COLUMN_ORDER: JobColumn[] = [
  "applied",
  "acknowledged",
  "interview_scheduled",
  "interviewed",
  "offer",
  "closed",
];

export const COLUMN_LABEL: Record<JobColumn, string> = {
  applied: "Applied",
  acknowledged: "Acknowledged",
  interview_scheduled: "Interview scheduled",
  interviewed: "Interviewed",
  offer: "Offer",
  closed: "Closed",
};

export const COLUMN_COLOR: Record<JobColumn, string> = {
  applied: "border-sky-500/30 bg-sky-500/5",
  acknowledged: "border-cyan-500/30 bg-cyan-500/5",
  interview_scheduled: "border-violet-500/30 bg-violet-500/5",
  interviewed: "border-fuchsia-500/30 bg-fuchsia-500/5",
  offer: "border-emerald-500/30 bg-emerald-500/5",
  closed: "border-zinc-700/40 bg-zinc-700/5",
};

export const COLUMN_HEADER_COLOR: Record<JobColumn, string> = {
  applied: "text-sky-300",
  acknowledged: "text-cyan-300",
  interview_scheduled: "text-violet-300",
  interviewed: "text-fuchsia-300",
  offer: "text-emerald-300",
  closed: "text-zinc-400",
};

/** Map a granular stage to one of 6 visual columns. */
export function stageToColumn(stage: string): JobColumn {
  switch (stage) {
    case "applied":
    case "forwarded":
    case "other":
      return "applied";
    case "received":
      return "acknowledged";
    case "interview_scheduled":
      return "interview_scheduled";
    case "interviewed":
      return "interviewed";
    case "offer":
      return "offer";
    case "rejected":
    case "withdrawn":
      return "closed";
    default:
      return "applied";
  }
}

export const STAGE_LABEL: Record<string, string> = {
  applied: "Applied",
  received: "Received",
  interview_scheduled: "Interview scheduled",
  interviewed: "Interviewed",
  forwarded: "Forwarded",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  other: "Other",
};

export const ALL_STAGES = [
  "applied",
  "received",
  "interview_scheduled",
  "interviewed",
  "forwarded",
  "offer",
  "rejected",
  "withdrawn",
  "other",
];

export const PRIORITY_COLOR: Record<string, string> = {
  extremely_high: "bg-rose-500",
  high: "bg-amber-500",
  medium: "bg-zinc-500",
  low: "bg-zinc-700",
};

export const PRIORITY_LABEL: Record<string, string> = {
  extremely_high: "Extremely High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const ACTION_LABEL: Record<string, string> = {
  reply: "Reply",
  schedule: "Schedule",
  submit_materials: "Submit materials",
  complete_assessment: "Complete assessment",
  sign_offer: "Sign offer",
  follow_up: "Follow up",
  archive: "Archive",
  ignore: "Ignore",
  escalate: "Escalate",
};

export function formatDeadline(epoch: number | null): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diffMs = epoch * 1000 - now;
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 0) return "Overdue";
  if (diffH < 24) return `in ${diffH}h`;
  if (diffH < 24 * 7) return `in ${Math.floor(diffH / 24)}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Days since a thread last had an email. */
export function daysSinceLastEmail(latestEmailAt: number): number {
  return Math.floor((Date.now() / 1000 - latestEmailAt) / 86400);
}

/** A thread is "silent" if it's still active (applied/received/forwarded/other) but
 * hasn't seen an email in 14+ days — likely needs a follow-up. */
export function isSilentThread(thread: { latestStage: string; latestEmailAt: number }): boolean {
  const activeStages = new Set(["applied", "received", "forwarded", "other"]);
  if (!activeStages.has(thread.latestStage)) return false;
  return daysSinceLastEmail(thread.latestEmailAt) >= 14;
}

export function formatRelative(epoch: number): string {
  const diff = Math.floor((Date.now() / 1000 - epoch) / 60);
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  if (diff < 1440 * 7) return `${Math.floor(diff / 1440)}d ago`;
  return new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
