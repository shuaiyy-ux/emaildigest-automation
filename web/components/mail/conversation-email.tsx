"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { Email, EmailCategory } from "@/lib/types";
import { Letter } from "react-letter";
import { stripLLMContamination } from "@/lib/sanitize";
import { parseEmailBody, cleanSnippet } from "@/lib/email-body";
import { formatEmailDate } from "@/lib/email-date";
import { EmailBodyView } from "./email-body-view";
import { AttachmentsList } from "./attachments-list";
import { CategoryPicker } from "./category-picker";
import { cn } from "@/lib/utils";

/**
 * One collapsible email card inside a conversation stack. Lazy-fetches the
 * full body the first time it's expanded. The newest email sits at the top
 * of the stack (index 0) and is rendered with `defaultExpanded` so the user
 * sees the latest content immediately; older messages below collapse to a
 * single-line snippet preview.
 */
export function ConversationEmail({
  email,
  defaultExpanded = false,
  isLatest = false,
  onEmailUpdated,
}: {
  email: Email;
  defaultExpanded?: boolean;
  isLatest?: boolean;
  onEmailUpdated?: (id: string, patch: Partial<Email>) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [full, setFull] = useState<Email | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchedId = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (fetchedId.current === email.id) return;
    fetchedId.current = email.id;
    fetch(`/api/emails/${email.id}`)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data) => setFull(data))
      .catch((e) => setError(e.message));
  }, [expanded, email.id]);

  const display = full || email;
  const initials = (display.from || "?").split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const loading = expanded && !full && !error;
  const previewText = cleanSnippet(display.snippet || "").slice(0, 160);

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden bg-card/40",
        isLatest ? "border-[rgba(122,183,255,0.25)]" : "border-border/40",
        email.isUnread && !expanded && "ring-1 ring-[rgba(122,183,255,0.25)]"
      )}
    >
      {/* Header row — always visible, clickable to toggle expansion */}
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white/[.02] transition-colors"
        onClick={() => setExpanded((x) => !x)}
      >
        <span className="mt-1 shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{display.from}</span>
            {display.fromEmail && (
              <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">
                &lt;{display.fromEmail}&gt;
              </span>
            )}
            {email.isUnread && (
              <span className="h-[6px] w-[6px] rounded-full bg-[#7ab7ff] shadow-[0_0_6px_#7ab7ff]" />
            )}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatEmailDate(display.receivedAt ?? email.receivedAt ?? 0, display.date)}
            </span>
          </div>
          {!expanded && (
            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
              {previewText}
            </p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/40 p-4">
          {display.category && (
            <div className="mb-3">
              <CategoryPicker
                emailId={display.id}
                currentCategory={display.category as EmailCategory}
                fromEmail={full?.fromEmail}
                subject={display.subject}
                onChanged={(newCat) => {
                  setFull((prev) => prev ? { ...prev, category: newCat } : prev);
                  onEmailUpdated?.(display.id, { category: newCat });
                }}
              />
            </div>
          )}

          {error ? (
            <p className="text-sm text-destructive py-2">{error}</p>
          ) : loading ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : (full?.bodyHtml || full?.body) ? (
            (() => {
              if (full?.bodyHtml) {
                return (
                  <div
                    className={[
                      "rounded-lg bg-card text-card-foreground p-4",
                      "[color-scheme:light] dark:[color-scheme:dark]",
                      "[&_img]:max-w-full [&_*]:max-w-full",
                      "[&_*]:!bg-transparent [&_*]:!text-inherit",
                      "[&_a]:!text-primary [&_a]:underline",
                      "[&_table]:border-collapse [&_table]:w-full",
                      "[&_td]:!border [&_td]:!border-foreground/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
                      "[&_th]:!border [&_th]:!border-foreground/60 [&_th]:px-3 [&_th]:py-2 [&_th]:align-top [&_th]:font-semibold",
                    ].join(" ")}
                  >
                    <Letter html={full.bodyHtml} />
                  </div>
                );
              }
              const cleaned = stripLLMContamination(full?.body || "");
              if (!cleaned) return <p className="text-sm text-muted-foreground italic">{cleanSnippet(display.snippet || "")}</p>;
              const parsed = parseEmailBody(cleaned);
              return <EmailBodyView parsed={parsed} />;
            })()
          ) : (
            <p className="text-sm text-muted-foreground italic">{cleanSnippet(display.snippet || "")}</p>
          )}

          <AttachmentsList emailId={display.id} />
        </div>
      )}
    </div>
  );
}
