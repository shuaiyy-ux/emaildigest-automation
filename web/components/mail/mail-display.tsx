"use client";

import { useEffect, useRef, useState } from "react";
import { Reply, Forward, Loader2, ArrowLeft } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Hint } from "@/components/ui/hint";
import type { Email, EmailCategory, DraftType } from "@/lib/types";
import { Letter } from "react-letter";
import { stripLLMContamination } from "@/lib/sanitize";
import { parseEmailBody, cleanSnippet } from "@/lib/email-body";
import { formatEmailDate } from "@/lib/email-date";
import { AttachmentsList } from "./attachments-list";
import { useIsMobile } from "@/lib/hooks/useMobile";
import { CategoryPicker } from "./category-picker";
import { GoldLabelPicker } from "./gold-label-picker";
import { EmailBodyView } from "./email-body-view";
import { DraftEditor } from "./draft-editor";
import { ConversationEmail } from "./conversation-email";
import { CompanyNameNote } from "@/components/demo/demo-marks";

export function MailDisplay({
  mail,
  threadEmails,
  onBack,
  onEmailUpdated,
}: {
  mail: Email | null;
  /** Full thread (newest → oldest). If length > 1, renders a conversation stack
   *  with the newest message on top (index 0) and older messages below. */
  threadEmails?: Email[];
  onBack?: () => void;
  onEmailUpdated?: (id: string, patch: Partial<Email>) => void;
}) {
  const isMobile = useIsMobile();
  const [full, setFull] = useState<Email | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState<DraftType | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  // Composer height (desktop, inline). Min 240, max window height - 240 to
  // keep the email visible. Preserved across composer open/close in the
  // same session; resets on component mount.
  const [composerHeight, setComposerHeight] = useState<number>(420);
  const fetchingRef = useRef<string | null>(null);

  const startComposerResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composerHeight;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const vpMax = Math.max(320, window.innerHeight - 240);
      const next = Math.min(vpMax, Math.max(240, startH - dy));
      setComposerHeight(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!mail) return;
    setFull(null);
    setError(null);
    setComposing(null);
    fetchingRef.current = mail.id;
    fetch(`/api/emails/${mail.id}`)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data) => { if (fetchingRef.current === mail.id) setFull(data); })
      .catch((e) => { if (fetchingRef.current === mail.id) setError(e.message); });
  }, [mail, retryCount]);

  // Derive: loading if mail selected but full doesn't match yet
  const loading = !!mail && full?.id !== mail.id && !error;

  if (!mail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center text-muted-foreground">
          <p className="text-lg">No email selected</p>
          <p className="text-sm mt-1">Choose an email from the list to read</p>
        </div>
      </div>
    );
  }

  const display = full || mail;
  const initials = display.from.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const isThreaded = Array.isArray(threadEmails) && threadEmails.length > 1;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className={`flex items-center ${isMobile ? "p-2 gap-1" : "p-2"}`}>
        <div className="flex items-center gap-1">
          {onBack && (
            <>
              <Button variant="ghost" size={isMobile ? "default" : "sm"} className={isMobile ? "h-10 gap-1.5 text-sm" : "h-8 gap-1 text-xs"} onClick={onBack}>
                <ArrowLeft className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} /> Back
              </Button>
              {!isMobile && <Separator orientation="vertical" className="mx-1 h-6" />}
            </>
          )}
          {!isMobile && process.env.NEXT_PUBLIC_DEV_TOOLS === "1" && (
            <Hint label="Mark as gold label for eval"><GoldLabelPicker emailId={mail.id} /></Hint>
          )}
        </div>
        {/* Desktop: Reply/Forward in toolbar. Mobile: moved to bottom bar */}
        {!isMobile && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setComposing("reply")}
              disabled={composing !== null}
            >
              <Reply className="h-3.5 w-3.5" /> Reply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setComposing("forward")}
              disabled={composing !== null}
            >
              <Forward className="h-3.5 w-3.5" /> Forward
            </Button>
          </div>
        )}
      </div>

      <Separator />

      {/* Thread subject banner (threaded view only) */}
      {isThreaded && (
        <div className={`${isMobile ? "px-3 py-2" : "px-4 py-3"}`}>
          <div className="text-sm font-semibold">{display.subject}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {threadEmails!.length} messages
          </div>
        </div>
      )}
      {isThreaded && <Separator />}

      {/* Header (single-email view only) */}
      {!isThreaded && (
      <div className={`${isMobile ? "p-3 space-y-2" : "flex items-start p-4 gap-4"}`}>
        {!isMobile && (
          <Avatar className="h-10 w-10">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        )}
        <div className="flex-1 min-w-0">
          {isMobile ? (
            <>
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-sm block truncate">{display.from}</span>
                  {full?.fromEmail && (
                    <span className="text-xs text-muted-foreground block truncate">{full.fromEmail}</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{formatEmailDate(display.receivedAt ?? mail.receivedAt ?? 0, display.date)}</span>
              </div>
              <div className="text-sm font-medium mt-1">{display.subject}</div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-sm">{display.from}</span>
                  {full?.fromEmail && (
                    <span className="text-xs text-muted-foreground ml-2">&lt;{full.fromEmail}&gt;</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{formatEmailDate(display.receivedAt ?? mail.receivedAt ?? 0, display.date)}</span>
              </div>
              <div className="text-sm font-medium mt-0.5">{display.subject}</div>
            </>
          )}
          {display.category && (
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
          )}
          {display.ttlHint && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
              title="Temporarily promoted to Priority because this email contains a time-sensitive claim"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {display.ttlHint}
            </span>
          )}
        </div>
      </div>
      )}

      {!isThreaded && <Separator />}

      {full?.id === mail.id && full.isJob && (
        <CompanyNameNote className={isMobile ? "mx-3 mt-3" : "mx-4 mt-3"} />
      )}

      {/* Body */}
      {isThreaded ? (
        <ScrollArea className={`flex-1 min-h-0 ${isMobile ? "p-3" : "p-4"}`}>
          <div className="flex flex-col gap-2">
            {threadEmails!.map((e, idx) => (
              <ConversationEmail
                key={e.id}
                email={e}
                defaultExpanded={idx === 0}
                isLatest={idx === 0}
                onEmailUpdated={onEmailUpdated}
              />
            ))}
          </div>
        </ScrollArea>
      ) : (
      <ScrollArea className={`flex-1 min-h-0 ${isMobile ? "p-3" : "p-4"}`}>
        {error ? (
          <div className="text-center py-8">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="sm" onClick={() => setRetryCount((c) => c + 1)} className="mt-2">Retry</Button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (full?.bodyHtml || full?.body) ? (
          (() => {
            // Prefer the HTML MIME part when present — it preserves the sender's
            // original layout, images, and links. When the email is text-only
            // (bodyHtml === ''), fall through to the text-rendering path; this
            // is not a fallback from a broken state but a reflection of the
            // actual MIME source (some automated emails ship text/plain only).
            if (full?.bodyHtml) {
              // react-letter renders through its own permissive sanitizer
              // (lettersanitizer), which keeps `bgcolor` and inline `style`
              // on <table>/<td>/<th>. Marketing and enterprise emails rely
              // on those for white backgrounds → in dark mode they punch
              // ugly white rectangles into the dark card.
              //
              // We can't configure lettersanitizer's allowlist, so we override
              // its output in CSS: every descendant bg forced transparent,
              // text forced to inherit (so our `text-card-foreground` cascades
              // down regardless of inline `color:#000`). Images and
              // intentional button-shaped links lose their shape cosmetically,
              // but text stays readable. Worth it for consistent theming.
              return (
                <div
                  className={[
                    "rounded-lg bg-card text-card-foreground p-4",
                    "[color-scheme:light] dark:[color-scheme:dark]",
                    "[&_img]:max-w-full [&_*]:max-w-full",
                    // Background + text: force transparent/inherit so the email's
                    // own light-mode inline styles (white cells, black text) don't
                    // punch through our dark card.
                    "[&_*]:!bg-transparent [&_*]:!text-inherit",
                    // Links remain theme-primary so they're visible and clickable.
                    "[&_a]:!text-primary [&_a]:underline",
                    // Tables: the white-cell hack above erased visual row dividers.
                    // Inject a subtle theme-colored border on every td/th + modest
                    // padding so structured tables (interview itineraries etc.)
                    // stay legible in dark mode.
                    "[&_table]:border-collapse [&_table]:w-full",
                    // `!` important on border-color is load-bearing: emails like
                    // interview itineraries have inline
                    // `<td style="border-color:black">` which wins over plain
                    // class-based rules. That painted borders black on our dark
                    // card = invisible. Tailwind `!` emits `!important` which
                    // beats the inline style.
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
      </ScrollArea>
      )}

      {/* Mobile: bottom action bar for Reply/Forward */}
      {isMobile && !composing && (
        <div className="flex items-center gap-2 p-3 border-t border-border bg-background shrink-0 safe-area-pb">
          <Button
            variant="outline"
            className="flex-1 h-11 gap-2 text-sm"
            onClick={() => setComposing("reply")}
          >
            <Reply className="h-4 w-4" /> Reply
          </Button>
          <Button
            variant="ghost"
            className="flex-1 h-11 gap-2 text-sm"
            onClick={() => setComposing("forward")}
          >
            <Forward className="h-4 w-4" /> Forward
          </Button>
        </div>
      )}

      {/* Compose area: full-screen overlay on mobile (avoids fighting ScrollArea for space),
          inline at bottom on desktop. Desktop inline gets a resize handle so
          the user can allocate more room to the composer vs the email body. */}
      {composing && (
        isMobile ? (
          <div className="fixed inset-0 z-50 bg-background flex flex-col">
            <DraftEditor
              emailId={display.id}
              type={composing}
              onClose={() => setComposing(null)}
              onSent={() => setComposing(null)}
            />
          </div>
        ) : (
          <>
            {/* Drag handle: 6px hit area above the DraftEditor's own
                border-t. Small pill indicator centered + hover highlight
                makes it discoverable without a heavy visual. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              onMouseDown={startComposerResize}
              className="group shrink-0 h-1.5 cursor-row-resize relative hover:bg-primary/15 transition-colors"
              title="Drag to resize composer"
            >
              <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 w-10 h-1 rounded-full bg-foreground/25 group-hover:bg-primary transition-colors" />
            </div>
            <div style={{ height: composerHeight }} className="shrink-0 flex flex-col min-h-0">
              <DraftEditor
                emailId={display.id}
                type={composing}
                onClose={() => setComposing(null)}
                onSent={() => setComposing(null)}
              />
            </div>
          </>
        )
      )}
    </div>
  );
}
