"use client";

import { useState } from "react";
import { ExternalLink, ChevronDown, ChevronRight, FileSignature, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ParsedEmailBody, InlinePart } from "@/lib/email-body";

export function EmailBodyView({ parsed }: { parsed: ParsedEmailBody }) {
  const [sigOpen, setSigOpen] = useState(false);
  const [discOpen, setDiscOpen] = useState(false);

  return (
    <div className="text-sm leading-relaxed space-y-4">
      {/* CTAs — prominent above body */}
      {parsed.ctas.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {parsed.ctas.map((cta) => (
            <a
              key={cta.url}
              href={cta.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors px-3 py-1.5 text-xs font-medium"
            >
              <ExternalLink className="h-3 w-3" />
              {cta.label}
            </a>
          ))}
        </div>
      )}

      {/* Paragraphs */}
      {parsed.paragraphs.length > 0 ? (
        parsed.paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            {p.parts.map((part, j) => renderInline(part, `${i}-${j}`))}
          </p>
        ))
      ) : (
        <p className="text-muted-foreground italic">No content</p>
      )}

      {/* Signature — collapsed by default */}
      {parsed.signature && (
        <div className="border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setSigOpen(!sigOpen)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {sigOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <FileSignature className="h-3 w-3" />
            Signature
          </button>
          {sigOpen && (
            <pre className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed border-l-2 border-border pl-3">
              {parsed.signature}
            </pre>
          )}
        </div>
      )}

      {/* Legal disclaimer — collapsed by default */}
      {parsed.disclaimer && (
        <div className={parsed.signature ? "" : "border-t border-border pt-3"}>
          <button
            type="button"
            onClick={() => setDiscOpen(!discOpen)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            {discOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Shield className="h-3 w-3" />
            Legal disclaimer
          </button>
          {discOpen && (
            <pre className="mt-2 text-[11px] text-muted-foreground/70 whitespace-pre-wrap font-sans leading-relaxed border-l-2 border-border/50 pl-3 max-h-40 overflow-y-auto">
              {parsed.disclaimer}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function renderInline(part: InlinePart, key: string) {
  if (part.type === "text") return <span key={key}>{part.content}</span>;
  return (
    <a
      key={key}
      href={part.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline break-all"
      title={part.href}
    >
      {part.label}
    </a>
  );
}
