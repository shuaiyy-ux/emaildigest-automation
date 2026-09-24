"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, Clock, CloudUpload, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Draft } from "@/lib/types";
import { useDemo } from "@/components/demo/demo-context";

function timeAgo(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// DEMO_MODE: sends and Gmail saves are simulated server-side, so the badge says so.
function statusBadge(status: string, demo: boolean) {
  if (status === "sent") return { label: demo ? "Simulated" : "Sent", icon: Check, variant: "default" as const };
  if (status === "pushed") return { label: demo ? "Simulated" : "Gmail draft", icon: CloudUpload, variant: "secondary" as const };
  if (status === "scheduled") return { label: "Scheduled", icon: Clock, variant: "secondary" as const };
  return { label: status, icon: Send, variant: "secondary" as const };
}

export function SentList({ selected, onSelect, refreshKey }: { selected: string | null; onSelect: (draft: Draft) => void; refreshKey?: number }) {
  const demo = useDemo();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/drafts?status=sent")
      .then((res) => res.json())
      .then((data) => { if (data.drafts) setDrafts(data.drafts); })
      .catch((e) => console.error("[sent-list] error:", e))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
        <Send className="h-8 w-8 opacity-30" />
        <p className="text-sm">No sent mail</p>
        <p className="text-xs">Emails you send or save to Gmail appear here</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1 p-3">
        {drafts.map((d) => {
          const sb = statusBadge(d.status, demo);
          const Icon = sb.icon;
          const when = d.sentAt ?? d.updatedAt;
          return (
            <button
              key={d.id}
              onClick={() => onSelect(d)}
              className={`relative flex flex-col items-start gap-1.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
                selected === d.id ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              <div className="flex w-full items-center gap-2">
                <Badge variant={sb.variant} className="text-[9px] h-4 px-1.5 shrink-0 gap-1">
                  <Icon className="h-2.5 w-2.5" /> {sb.label}
                </Badge>
                <span className="text-[13px] truncate flex-1">
                  {d.to || "No recipient"}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
                  {timeAgo(when)}
                </span>
              </div>
              <span className="text-xs font-medium leading-snug line-clamp-1">
                {d.subject || "No subject"}
              </span>
              <span className="line-clamp-1 text-xs text-muted-foreground leading-relaxed">
                {d.body.split("\n")[0].slice(0, 80) || "Empty"}
              </span>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
