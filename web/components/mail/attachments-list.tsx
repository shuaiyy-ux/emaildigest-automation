"use client";

import { useEffect, useState } from "react";
import { Paperclip, Download, Image as ImageIcon, FileText, File } from "lucide-react";

interface AttachmentInfo {
  id: number;
  filename: string;
  size: number;
  mimeType: string;
  contentId: string | null;
  isInline: boolean;
}

function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime === "application/pdf" || mime.includes("document") || mime.includes("text")) return FileText;
  return File;
}

export function AttachmentsList({ emailId }: { emailId: string }) {
  const [list, setList] = useState<AttachmentInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/emails/${emailId}/attachments`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setList(d.attachments || []); })
      .catch(() => { if (!cancelled) setList([]); });
    return () => { cancelled = true; };
  }, [emailId]);

  // Hide inline (cid) attachments — they're rendered inside the HTML body.
  const visible = (list || []).filter((a) => !a.isInline);
  if (!list || visible.length === 0) return null;

  return (
    <div className="border-t border-border pt-3 mt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
        <Paperclip className="h-3 w-3" />
        {visible.length} attachment{visible.length === 1 ? "" : "s"}
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((a) => {
          const Icon = iconFor(a.mimeType);
          return (
            <a
              key={a.id}
              href={`/api/emails/${emailId}/attachments/${a.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors px-3 py-2 text-xs max-w-xs"
              title={`${a.filename} (${humanSize(a.size)})`}
            >
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{a.filename}</div>
                <div className="text-[10px] text-muted-foreground">{humanSize(a.size)}</div>
              </div>
              <Download className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </a>
          );
        })}
      </div>
    </div>
  );
}
