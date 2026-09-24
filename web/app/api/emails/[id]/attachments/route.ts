import { getEmailAttachments } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = getEmailAttachments(id).map((a) => ({
    id: a.id,
    filename: a.filename,
    size: a.size,
    mimeType: a.mime_type,
    contentId: a.content_id,
    isInline: !!a.content_id,
  }));
  return Response.json({ attachments: rows });
}
