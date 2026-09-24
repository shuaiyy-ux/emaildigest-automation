"use client";

import { useEffect, useState } from "react";
import { Loader2, PenLine, Trash2, AlertTriangle, RotateCw } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Draft } from "@/lib/types";

interface FailedDraft extends Draft {
  sendAttempts?: number;
  lastSendError?: string | null;
  lastSendAttemptAt?: number | null;
}

function timeAgo(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function DraftList({ selected, onSelect, refreshKey }: { selected: string | null; onSelect: (draft: Draft) => void; refreshKey?: number }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [failed, setFailed] = useState<FailedDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const handleDiscard = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDiscarding(id);
    try {
      await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discard", id }),
      });
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      setFailed((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.error("[draft-list] discard error:", err);
    } finally {
      setDiscarding(null);
    }
  };

  const handleRetryFailed = async (id: string) => {
    setRetrying(id);
    try {
      await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retryScheduled", id }),
      });
      setFailed((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.error("[draft-list] retry error:", err);
    } finally {
      setRetrying(null);
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [allRes, failedRes] = await Promise.all([
          fetch("/api/drafts"),
          fetch("/api/drafts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "listFailed" }),
          }),
        ]);
        const allData = await allRes.json();
        const failedData = await failedRes.json();
        if (allData.drafts) setDrafts(allData.drafts);
        if (failedData.drafts) setFailed(failedData.drafts);
      } catch (e) {
        console.error("[draft-list] error:", e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  const failedBanner = failed.length > 0 ? (
    <div className="mx-3 mt-3 rounded-md border border-red-400/30 bg-red-400/[.05] p-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
        <span className="text-xs font-semibold text-red-200">
          {failed.length} scheduled send{failed.length > 1 ? "s" : ""} failed
        </span>
      </div>
      <ul className="space-y-1">
        {failed.map((d) => (
          <li key={d.id} className="flex items-start gap-2 text-[11px] leading-snug">
            <div className="flex-1 min-w-0">
              <div className="flex gap-2 text-red-200/90">
                <span className="truncate">{d.to || "No recipient"}</span>
                <span className="truncate">{d.subject || "No subject"}</span>
              </div>
              <div className="truncate text-red-300/60 font-mono">{d.lastSendError || "Unknown error"}</div>
            </div>
            <button
              onClick={() => handleRetryFailed(d.id)}
              disabled={retrying === d.id}
              className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono text-red-200 hover:text-red-100 disabled:opacity-40"
              title="Reschedule for the next minute"
            >
              {retrying === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
              Retry
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  if (drafts.length === 0) {
    return (
      <>
        {failedBanner}
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
          <PenLine className="h-8 w-8 opacity-30" />
          <p className="text-sm">No drafts</p>
          <p className="text-xs">Reply or forward an email to create one</p>
        </div>
      </>
    );
  }

  return (
    <ScrollArea className="h-full">
      {failedBanner}
      <div className="flex flex-col gap-1 p-3">
        {drafts.map((d) => (
          <button
            key={d.id}
            onClick={() => onSelect(d)}
            className={`relative flex flex-col items-start gap-1.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
              selected === d.id ? "bg-muted" : "hover:bg-muted/50"
            }`}
          >
            <div className="flex w-full items-center gap-2">
              <Badge variant="secondary" className="text-[9px] h-4 px-1.5 shrink-0">
                {d.type === "reply" ? "Reply" : d.type === "forward" ? "Fwd" : "New"}
              </Badge>
              <span className="text-[13px] truncate flex-1">
                {d.to || "No recipient"}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
                {timeAgo(d.updatedAt)}
              </span>
              <Hint label="Delete draft">
                <button
                  onClick={(e) => handleDiscard(e, d.id)}
                  disabled={discarding === d.id}
                  className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                  {discarding === d.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </Hint>
            </div>
            <span className="text-xs font-medium leading-snug line-clamp-1">
              {d.subject || "No subject"}
            </span>
            <span className="line-clamp-1 text-xs text-muted-foreground leading-relaxed">
              {d.body.split("\n")[0].slice(0, 80) || "Empty draft"}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
