"use client";

import { useEffect, useState } from "react";
import { X, Loader2, Mail } from "lucide-react";
import { Letter } from "react-letter";
import { stripLLMContamination } from "@/lib/sanitize";
import { parseEmailBody, cleanSnippet } from "@/lib/email-body";
import { EmailBodyView } from "@/components/mail/email-body-view";
import { CompanyNameNote } from "@/components/demo/demo-marks";

interface EmailFull {
  subject: string;
  from: string;
  fromEmail: string;
  body: string;
  bodyHtml: string;
  snippet: string;
  date: string;
  isJob: boolean;
}

export function EmailSidePanel({ emailId, onClose }: { emailId: string; onClose: () => void }) {
  const [email, setEmail] = useState<EmailFull | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/emails/${emailId}`)
      .then((r) => r.json())
      .then((d) => {
        const em = d?.email ?? d;
        if (em && em.id) {
          setEmail({
            subject: em.subject || "",
            from: em.from || em.from_name || "",
            fromEmail: em.fromEmail || em.from_email || "",
            body: em.body || "",
            bodyHtml: em.bodyHtml || em.body_html || "",
            snippet: em.snippet || "",
            date: em.date || "",
            isJob: !!em.isJob,
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [emailId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const renderBody = () => {
    if (!email) return null;
    const htmlTags = /<(p|div|span|br|a|b|i|em|strong|ul|ol|li|h[1-6]|table|tr|td|th|img|blockquote|pre|code)\b/i;
    if (email.bodyHtml && htmlTags.test(email.bodyHtml)) {
      return (
        <div
          className={[
            "prose prose-sm max-w-none",
            "bg-white/[.02] rounded-md p-3",
            "[&_*]:!text-foreground [&_*]:!bg-transparent",
            "[&_a]:!text-[#7ab7ff] [&_a]:underline",
            "[&_table]:border-collapse [&_table]:w-full",
            "[&_td]:!border [&_td]:!border-foreground/30 [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top",
            "[&_th]:!border [&_th]:!border-foreground/30 [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top [&_th]:font-semibold",
          ].join(" ")}
        >
          <Letter html={email.bodyHtml} />
        </div>
      );
    }
    const cleaned = stripLLMContamination(email.body || "");
    if (!cleaned) {
      return <p className="text-xs text-muted-foreground italic">{cleanSnippet(email.snippet)}</p>;
    }
    const parsed = parseEmailBody(cleaned);
    return (
      <div className="text-sm">
        <EmailBodyView parsed={parsed} />
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex justify-end pointer-events-none">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm pointer-events-auto" onClick={onClose} />
      <div
        className="relative w-full max-w-[520px] h-full glass-panel m-2 sm:m-4 flex flex-col pointer-events-auto overflow-hidden"
        style={{ animation: "rise .3s var(--ease-out) both" }}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] shrink-0">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold truncate flex-1">
            {loading ? "Loading…" : email?.subject || "No subject"}
          </h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-white/[.06]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-auto flex-1 p-4 space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : email ? (
            <>
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>{email.from}</span>
                {email.fromEmail && <span className="opacity-60">{email.fromEmail}</span>}
                {email.date && <span className="opacity-60">{email.date}</span>}
              </div>
              {email.isJob && <CompanyNameNote />}
              {renderBody()}
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic">Email not found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
