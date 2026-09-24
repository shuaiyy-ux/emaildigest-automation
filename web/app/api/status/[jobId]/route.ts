import { NextRequest } from "next/server";
import { getJob } from "@/lib/jobs";
import { getDemoUser } from "@/lib/demo";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);

  // Jobs started by a visitor are only visible to that visitor.
  if (!job || (job.user && job.user !== getDemoUser(request))) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  return Response.json({
    jobId: job.id,
    status: job.status,
    result: job.status === "done" ? job.result : undefined,
    error: job.status === "error" ? job.error : undefined,
    elapsed: Math.round(
      ((job.finishedAt || Date.now()) - job.startedAt) / 1000
    ),
  });
}
