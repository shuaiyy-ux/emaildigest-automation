import { addAttachment, getAttachmentById, getAttachments, deleteAttachmentByDraft, getOwnDraft } from "@/lib/db";
import { isDemoMode, getDemoUser, demoDisabledResponse } from "@/lib/demo";
import path from "path";
import fs from "fs/promises";

// Allow large file uploads (Gmail allows 25MB). Next.js app router defaults
// don't enforce a body size limit, but we guard explicitly below.
export const runtime = "nodejs";
export const maxDuration = 60;

const EMAILDIGEST_DIR = path.resolve(process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."));
const ATTACHMENTS_ROOT = path.join(EMAILDIGEST_DIR, "attachments");
// 10MB — constrained by Next.js proxy body buffer default. For larger files,
// use Push to Gmail flow and attach directly in Gmail's compose.
const MAX_SIZE = 10 * 1024 * 1024;

function toResponse(a: { id: number; draft_id: string; filename: string; size: number; mime_type: string }) {
  return { id: a.id, draftId: a.draft_id, filename: a.filename, size: a.size, mimeType: a.mime_type };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getOwnDraft(id, getDemoUser(req))) return Response.json({ error: "Draft not found" }, { status: 404 });
  return Response.json({ attachments: getAttachments(id).map(toResponse) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Public demo: visitors cannot store files on the server.
  if (isDemoMode()) return demoDisabledResponse("Attachments are disabled in this demo.");
  if (!getOwnDraft(id, getDemoUser(req))) return Response.json({ error: "Draft not found" }, { status: 404 });

  // Early size check via Content-Length header
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_SIZE + 1024) {
    return Response.json({ error: "File exceeds the 10 MB limit. Save as a Gmail draft to attach larger files." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e) {
    return Response.json({ error: `File exceeds 10MB limit or malformed upload: ${e}` }, { status: 413 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file" }, { status: 400 });
  if (file.size > MAX_SIZE) return Response.json({ error: "File exceeds the 10 MB limit. Save as a Gmail draft to attach larger files." }, { status: 413 });

  const dir = path.join(ATTACHMENTS_ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedPath = path.join(dir, `${Date.now()}_${safeName}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(storedPath, buffer);

  const row = addAttachment(id, file.name, storedPath, file.size, file.type || "application/octet-stream");
  return Response.json({ attachment: toResponse(row) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const url = new URL(req.url);
  const attachmentId = Number(url.searchParams.get("attachmentId"));
  if (!attachmentId) return Response.json({ error: "Missing attachmentId" }, { status: 400 });

  if (!getOwnDraft(draftId, getDemoUser(req))) {
    return Response.json({ error: "Draft not found" }, { status: 404 });
  }

  const deletedRow = deleteAttachmentByDraft(draftId, attachmentId);
  if (!deletedRow) {
    const attachment = getAttachmentById(attachmentId);
    if (!attachment) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }
    return Response.json({ error: "Attachment does not belong to this draft" }, { status: 403 });
  }

  try {
    await fs.unlink(deletedRow.path);
  } catch (err) {
    if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
      console.error(`[attachments DELETE] failed to unlink file ${deletedRow.path}`, err);
    }
  }
  return Response.json({ deleted: true });
}
