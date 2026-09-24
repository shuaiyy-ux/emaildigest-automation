import { NextRequest } from "next/server";
import { runCommand } from "@/lib/subprocess";
import { isCommandRunning } from "@/lib/jobs";
import { isDemoMode } from "@/lib/demo";
import type { Command, RunRequest } from "@/lib/types";

const VALID_COMMANDS: Command[] = ["digest", "draft", "classify", "filter", "inquiry"];

// Legacy `./emaildigest` CLI (claude.ai Gmail connector). Never in DEMO_MODE.
export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return Response.json({ error: "demo_disabled" }, { status: 403 });
  }
  let body: RunRequest;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!VALID_COMMANDS.includes(body.command)) {
    return Response.json(
      { error: `Invalid command: ${body.command}` },
      { status: 400 }
    );
  }

  const args = body.args || [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    return Response.json({ error: "args must be a string array" }, { status: 400 });
  }

  if (isCommandRunning(body.command)) {
    return Response.json(
      { error: `${body.command} is already running` },
      { status: 409 }
    );
  }

  const job = runCommand(body.command, args, { readonly: true });

  return Response.json({
    jobId: job.id,
    status: job.status,
  });
}
