import fs from "fs/promises";
import path from "path";
import { getEmailAttachment } from "@/lib/db";
import { isDemoMode } from "@/lib/demo";

const EMAILDIGEST_DIR = path.resolve(process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."));
// Types a browser would execute or render as a page from this origin.
const ACTIVE_TYPES = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml)/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const { id, attachmentId } = await params;
  const att = getEmailAttachment(parseInt(attachmentId, 10));
  if (!att || att.email_id !== id) {
    return new Response("Not found", { status: 404 });
  }
  // DEMO_MODE: only files under the data directory, whatever path the DB row holds.
  if (isDemoMode() && !path.resolve(att.path).startsWith(EMAILDIGEST_DIR + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  let content: Buffer;
  try {
    content = await fs.readFile(att.path);
  } catch {
    return new Response("Attachment file missing", { status: 404 });
  }
  const blob = new Uint8Array(content);
  const type = att.mime_type || "application/octet-stream";
  const active = ACTIVE_TYPES.test(type);
  return new Response(blob, {
    headers: {
      "Content-Type": type,
      // HTML / SVG / XML attachments download instead of rendering on this origin.
      "Content-Disposition": `${active ? "attachment" : "inline"}; filename="${encodeURIComponent(att.filename)}"`,
      ...(active ? { "Content-Security-Policy": "sandbox" } : {}),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
