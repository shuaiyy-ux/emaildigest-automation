"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ArrowLeft, Loader2, Send, Sparkles, RotateCw, Mail, Search, Trash2, MessageSquare, Menu, X, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EmailSidePanel } from "@/components/mail/email-side-panel";
import { chatFetch, ChatRequestError } from "@/lib/demo-client";

/** Remaining AI quota as reported by the demo gateway (display only). */
interface DemoInfo {
  demo: boolean;
  user: string;
  quota: { limit: number | null; remaining: number | null; unlimited: boolean } | null;
}

const SUGGESTIONS = [
  "What assignments are due this week?",
  "Summarize recent emails from professors",
  "Which emails are still waiting for a reply?",
  "List recent deadlines sorted by date",
];

// Matches inline citation IDs emitted by the model, e.g. [#19d9c0df]
const CITATION_RE = /\[#([0-9a-f]{6,16})\]/g;

interface ConversationRow {
  sid: string;
  title: string;
  created_at: number;
  updated_at: number;
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function AskPageClient() {
  const params = useSearchParams();
  const [sid, setSid] = useState<string | null>(params.get("sid"));
  const [input, setInput] = useState("");
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationRow[]>([]);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  // Local "user interrupted this generation" flag. Without this, a Stop
  // click silently freezes the streaming text mid-sentence (status flips to
  // "ready" identically whether the run finished or was aborted). The audit
  // called this out as a state-boundary UX gap (§11 — abort path needs a
  // visible terminal state).
  const [interrupted, setInterrupted] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // useChat (AI SDK v5) — sessionId flows through body of every request so
  // Claude CLI's --resume can pick it up.
  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: "/api/chat",
      // Drops the gateway-only `demo_usage` SSE event; surfaces 429 / 4xx
      // JSON bodies as readable errors.
      fetch: chatFetch,
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: { messages, sid: sid ?? undefined, ...body },
      }),
    });
  }, [sid]);

  const { messages, sendMessage, status, stop, setMessages, error, clearError } = useChat({
    transport,
    onData: (part) => {
      // Custom data part carries session id (see lib/ask/stream.ts). When
      // Claude CLI assigns a new session, capture it for URL persistence +
      // subsequent --resume.
      if (part.type === "data-session") {
        const data = (part as { data?: { sid?: string } }).data;
        if (data?.sid && data.sid !== sid) setSid(data.sid);
      }
    },
  });

  const sending = status === "submitted" || status === "streaming";
  // The stream opens with a bare "start" event, so status turns "streaming"
  // before anything is visible. Keep the indicator up until text or a running
  // tool is on screen, and again after a tool finishes while the next text is pending.
  const waiting = (() => {
    if (!sending) return false;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return true;
    const visible = last.parts.filter((p) => p.type === "text" || p.type.startsWith("tool-"));
    const tail = visible[visible.length - 1] as { type: string; text?: string; state?: string } | undefined;
    if (!tail) return true;
    if (tail.type === "text") return !tail.text;
    return tail.state === "output-available" || tail.state === "output-error";
  })();

  // Demo quota line ("N of 50 left in the last 24 hours"); hidden for the
  // owner token, unlimited quotas and outside the demo.
  const [demoInfo, setDemoInfo] = useState<DemoInfo | null>(null);
  const fetchDemoInfo = async () => {
    try {
      const res = await fetch("/api/demo", { cache: "no-store" });
      if (res.ok) setDemoInfo((await res.json()) as DemoInfo);
    } catch { /* display only */ }
  };
  const quota = demoInfo?.demo && demoInfo.user !== "owner" && demoInfo.quota && !demoInfo.quota.unlimited
    && demoInfo.quota.remaining !== null && demoInfo.quota.limit !== null
    ? demoInfo.quota
    : null;

  // Auto-send ?q= once on first mount
  const initialQRef = useRef(params.get("q") || "");
  const initialSent = useRef(false);
  useEffect(() => {
    if (!initialQRef.current || initialSent.current) return;
    initialSent.current = true;
    const q = initialQRef.current;
    sendMessage({ text: q });
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect sid in URL so refresh preserves the session
  useEffect(() => {
    if (!sid) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("sid") !== sid) {
      url.searchParams.set("sid", sid);
      window.history.replaceState({}, "", url.toString());
    }
  }, [sid]);

  // Scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const fetchHistory = async () => {
    try {
      const res = await fetch("/api/chat/history");
      if (!res.ok) return;
      const json = (await res.json()) as { conversations: ConversationRow[] };
      setHistory(json.conversations || []);
    } catch (e) {
      console.error("[ask] fetchHistory", e);
    }
  };

  // Load on mount
  useEffect(() => {
    fetchHistory();
    fetchDemoInfo();
  }, []);

  // Refetch on stream completion (status edge: streaming/submitted → ready)
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current !== "ready" && (status === "ready" || status === "error")) {
      fetchHistory();
      fetchDemoInfo();
    }
    prevStatus.current = status;
  }, [status]);

  // A conversation this visitor does not own (or one that never finished)
  // cannot be resumed: drop the sid so the next question starts fresh.
  useEffect(() => {
    if (error instanceof ChatRequestError && error.code === "unknown_session") {
      setSid(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("sid");
      window.history.replaceState({}, "", url.toString());
    }
  }, [error]);

  const loadConversation = async (targetSid: string) => {
    if (targetSid === sid) {
      setMobileHistoryOpen(false);
      return;
    }
    stop();
    setInterrupted(false);
    setMobileHistoryOpen(false);
    try {
      const res = await fetch(`/api/chat/history/${targetSid}`);
      if (res.status === 404) {
        // Not this visitor's conversation (or already deleted); refresh list
        await fetchHistory();
        return;
      }
      if (!res.ok) {
        console.error("[ask] loadConversation failed:", res.status);
        return;
      }
      const json = (await res.json()) as { messages: UIMessage[] };
      setMessages(json.messages || []);
      setSid(targetSid);
      const url = new URL(window.location.href);
      url.searchParams.set("sid", targetSid);
      url.searchParams.delete("q");
      window.history.replaceState({}, "", url.toString());
    } catch (e) {
      console.error("[ask] loadConversation", e);
    }
  };

  const handleDelete = async (targetSid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Delete this conversation?")) return;
    try {
      const res = await fetch(`/api/chat/history/${targetSid}`, { method: "DELETE" });
      if (!res.ok) {
        console.error("[ask] delete failed:", res.status);
        return;
      }
      setHistory((h) => h.filter((c) => c.sid !== targetSid));
      if (targetSid === sid) {
        newConversation();
      }
    } catch (err) {
      console.error("[ask] delete", err);
    }
  };

  const onSubmit = (text: string) => {
    const q = text.trim();
    if (!q || sending) return;
    setInterrupted(false);
    if (error) clearError();
    sendMessage({ text: q });
    setInput("");
  };

  const handleStop = () => {
    // Aborts the SSE — server's signal listener kills the claude subprocess.
    // We flip a local flag so the user sees an explicit interrupted-state
    // banner instead of the streaming text just freezing in place.
    stop();
    setInterrupted(true);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter = newline (default). Cmd/Ctrl+Enter = send.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit(input);
    }
  };

  const newConversation = () => {
    stop();
    setInterrupted(false);
    setMessages([]);
    setSid(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("sid");
    url.searchParams.delete("q");
    window.history.replaceState({}, "", url.toString());
  };

  return (
    <div className="h-screen flex p-2 sm:p-4 gap-2 sm:gap-3 pt-safe pb-safe">
      {/* Desktop history pane */}
      <aside className="hidden md:flex glass-panel w-60 flex-col overflow-hidden shrink-0">
        <HistoryPane
          history={history}
          activeSid={sid}
          onLoad={loadConversation}
          onDelete={handleDelete}
          onNew={newConversation}
        />
      </aside>

      <div className="glass-panel flex h-full flex-1 flex-col overflow-hidden min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-3 sm:px-4 py-3 shrink-0 border-b border-white/[0.06]">
          <button
            onClick={() => setMobileHistoryOpen(true)}
            className="md:hidden rounded-md p-1 hover:bg-white/[.05]"
            aria-label="Open history"
          >
            <Menu className="h-4 w-4" />
          </button>
          <Link href="/" className="rounded-md p-1 hover:bg-white/[.05]">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0
                       bg-[linear-gradient(135deg,#c4b5fd,#7ab7ff_50%,#6ee7b7)]
                       shadow-[0_6px_20px_rgba(196,181,253,.35),inset_0_1px_0_rgba(255,255,255,.4)]"
          >
            <Sparkles className="h-4 w-4 text-[#0b0b10]" strokeWidth={2.5} />
          </div>
          <h1 className="text-sm font-semibold tracking-tight flex-1">Ask AI</h1>
          <button
            onClick={newConversation}
            disabled={messages.length === 0 && !sending}
            className="inline-flex items-center gap-1 rounded-full bg-white/[.06] hover:bg-white/[.10] disabled:opacity-40 px-3 py-1.5 text-xs font-medium transition"
          >
            <RotateCw className="h-3.5 w-3.5" /> New
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-4">
          {messages.length === 0 && !sending && <EmptyState onSuggest={onSubmit} />}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onSourceClick={(id) => setOpenEmailId(id)} />
          ))}
          {waiting && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          )}
          {error && !sending && (
            <div role="alert" className="flex items-center gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <span className="flex-1">{error.message}</span>
              <button
                onClick={() => clearError()}
                className="shrink-0 rounded p-1 hover:bg-white/[.06]"
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {interrupted && !sending && (
            <div className="flex items-center gap-3 rounded-lg border border-[rgba(244,114,182,0.22)] bg-[rgba(244,114,182,0.06)] px-3 py-2 text-xs text-[#fda4c4]">
              <Square className="h-3 w-3 shrink-0" fill="currentColor" />
              <span className="flex-1">
                Reply stopped before it finished.
              </span>
              <button
                onClick={() => setInterrupted(false)}
                className="shrink-0 rounded p-1 hover:bg-white/[.06]"
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="shrink-0 p-3 sm:p-4 border-t border-white/[0.06]">
          <div
            className="relative p-2.5 rounded-2xl overflow-hidden border border-[rgba(255,255,255,0.08)] backdrop-blur-xl
                       bg-gradient-to-br from-[rgba(122,183,255,0.08)] to-[rgba(196,181,253,0.06)]"
          >
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                disabled={sending}
                placeholder="Ask anything about your inbox…"
                rows={1}
                className="flex-1 resize-none bg-transparent border-0 outline-none text-[15px] placeholder:text-[var(--fg-muted)] py-2 px-3 min-h-[40px] max-h-[120px]"
              />
              {sending ? (
                <button
                  onClick={handleStop}
                  className="shrink-0 flex items-center justify-center rounded-[10px] h-10 w-10
                             bg-gradient-to-br from-[rgba(244,114,182,0.3)] to-[rgba(244,114,182,0.18)]
                             border border-[rgba(244,114,182,0.32)]
                             hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(244,114,182,0.25)]
                             transition-all"
                  title="Stop generation"
                  aria-label="Stop generation"
                >
                  <Square className="h-4 w-4 text-[#fda4c4]" fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={() => onSubmit(input)}
                  disabled={!input.trim()}
                  className="shrink-0 flex items-center justify-center rounded-[10px] h-10 w-10
                             bg-gradient-to-br from-[rgba(122,183,255,0.3)] to-[rgba(196,181,253,0.22)]
                             border border-[rgba(122,183,255,0.3)]
                             hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(122,183,255,0.25)]
                             disabled:opacity-30 disabled:pointer-events-none transition-all"
                >
                  <Send className="h-4 w-4 text-[#bcd7ff]" />
                </button>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap justify-center gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className="hidden sm:inline">⌘/Ctrl + Enter to send</span>
            {quota && (
              <span className="text-foreground/70">
                {quota.remaining} of {quota.limit} left in the last 24 hours
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Mobile history sheet */}
      {mobileHistoryOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 flex pt-safe pb-safe"
          onClick={() => setMobileHistoryOpen(false)}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <aside
            className="relative glass-panel flex w-72 max-w-[80vw] flex-col overflow-hidden m-2"
            onClick={(e) => e.stopPropagation()}
          >
            <HistoryPane
              history={history}
              activeSid={sid}
              onLoad={loadConversation}
              onDelete={handleDelete}
              onNew={() => {
                newConversation();
                setMobileHistoryOpen(false);
              }}
              onClose={() => setMobileHistoryOpen(false)}
            />
          </aside>
        </div>
      )}

      {openEmailId && <EmailSidePanel emailId={openEmailId} onClose={() => setOpenEmailId(null)} />}
    </div>
  );
}

function HistoryPane({
  history,
  activeSid,
  onLoad,
  onDelete,
  onNew,
  onClose,
}: {
  history: ConversationRow[];
  activeSid: string | null;
  onLoad: (sid: string) => void;
  onDelete: (sid: string, e: React.MouseEvent) => void;
  onNew: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-3 shrink-0 border-b border-white/[0.06]">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground flex-1">
          History
        </span>
        {onClose && (
          <button onClick={onClose} className="rounded-md p-1 hover:bg-white/[.05]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <button
        onClick={onNew}
        className="mx-3 mt-3 inline-flex items-center justify-center gap-1.5 rounded-full bg-white/[.06] hover:bg-white/[.10] px-3 py-1.5 text-xs font-medium transition shrink-0"
      >
        <RotateCw className="h-3.5 w-3.5" /> New conversation
      </button>
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {history.length === 0 && (
          <div className="text-[11px] text-muted-foreground text-center py-6 px-3">
            No conversations yet. Send a question to start.
          </div>
        )}
        {history.map((c) => {
          const active = c.sid === activeSid;
          return (
            <div
              key={c.sid}
              onClick={() => onLoad(c.sid)}
              className={`group flex items-start gap-2 rounded-lg px-2.5 py-2 cursor-pointer transition ${
                active ? "bg-white/[.07]" : "hover:bg-white/[.04]"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium truncate">{c.title}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(c.updated_at)}</div>
              </div>
              <button
                onClick={(e) => onDelete(c.sid, e)}
                className="opacity-0 group-hover:opacity-100 hover:text-rose-400 rounded p-1 transition"
                aria-label="Delete conversation"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12">
      <Sparkles
        className="h-10 w-10 text-[#c4b5fd] opacity-60"
        style={{ animation: "sparkle 3s ease-in-out infinite" }}
      />
      <div className="flex flex-wrap gap-2 justify-center max-w-lg">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onSuggest(s)}
            className="glass rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/[.06] transition"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onSourceClick,
}: {
  message: UIMessage;
  onSourceClick: (id: string) => void;
}) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl rounded-br-sm px-4 py-2.5 bg-[rgba(122,183,255,0.15)] border border-[rgba(122,183,255,0.25)] text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  // Assistant: render in order — text chunks as markdown, tool calls as inline status chips
  const rendered: React.ReactNode[] = [];
  let textAccum = "";

  const flushText = (key: string | number) => {
    if (!textAccum) return;
    rendered.push(
      <div
        key={`t-${key}`}
        className="rounded-2xl rounded-bl-sm px-4 py-3 bg-white/[.03] border border-white/[0.06] text-sm prose prose-sm max-w-none
                   prose-invert prose-p:leading-relaxed prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2
                   prose-strong:text-foreground prose-li:my-0.5 prose-ol:pl-7 prose-ul:pl-6 prose-code:text-[13px] prose-code:bg-black/30 prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{textAccum}</ReactMarkdown>
      </div>
    );
    textAccum = "";
  };

  message.parts.forEach((p, idx) => {
    if (p.type === "text") {
      textAccum += (p as { text: string }).text || "";
    } else if (p.type.startsWith("tool-")) {
      flushText(idx);
      rendered.push(<ToolPart key={`tool-${idx}`} part={p} />);
    }
  });
  flushText("end");

  // Collect ALL cited ids across the assistant message for source chip row
  const fullText = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  const citedIds = Array.from(new Set((fullText.match(CITATION_RE) || []).map((m) => m.slice(2, -1))));

  return (
    <div className="flex flex-col gap-2 max-w-[95%] sm:max-w-[85%]">
      {rendered}
      {citedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-2">
          {citedIds.map((id) => (
            <button
              key={id}
              onClick={() => onSourceClick(id)}
              className="inline-flex items-center gap-1 rounded-full bg-white/[.04] hover:bg-white/[.08] border border-white/[0.06] px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition"
              title="Open cited email"
            >
              <Mail className="h-2.5 w-2.5" />
              <span className="font-mono">#{id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reader-facing names for the agent's MCP tools (the raw names are implementation detail). */
const TOOL_LABEL: Record<string, string> = {
  search_emails: "Search emails",
  read_full_email: "Read email",
  get_application: "Job application",
};

function ToolPart({ part }: { part: UIMessage["parts"][number] }) {
  // Tool parts in v5 messages: tool-<toolName> with state 'input-streaming' |
  // 'input-available' | 'output-available' | 'output-error'.
  const anyPart = part as unknown as {
    type: string;
    state?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    errorText?: string;
  };
  // Claude CLI names MCP tools mcp__<server>__<tool>; show the tool name only.
  const toolName = anyPart.type.replace(/^tool-/, "").replace(/^mcp__.+?__/, "");
  const state = anyPart.state || "input-available";

  const icon =
    state === "output-available" ? (
      <Search className="h-3 w-3 text-[#6ee7b7]" />
    ) : (
      <Loader2 className="h-3 w-3 animate-spin text-[#7ab7ff]" />
    );

  let detail = "";
  if (toolName === "search_emails" && anyPart.input?.query) {
    detail = `"${anyPart.input.query}"`;
  } else if (toolName === "read_full_email" && anyPart.input?.id) {
    detail = `#${String(anyPart.input.id).slice(0, 8)}`;
  } else if (toolName === "get_application" && anyPart.input?.id) {
    detail = String(anyPart.input.id).slice(0, 20);
  }

  let hits: number | null = null;
  if (state === "output-available" && toolName === "search_emails") {
    const out = anyPart.output as { hits?: unknown[]; stats?: { hit_count?: number } } | undefined;
    if (out?.stats?.hit_count !== undefined) hits = out.stats.hit_count;
    else if (Array.isArray(out?.hits)) hits = out!.hits.length;
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-white/[.03] border border-white/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground self-start">
      {icon}
      <span>{TOOL_LABEL[toolName] ?? toolName.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</span>
      {detail && <span className="opacity-70">{detail}</span>}
      {hits !== null && <span className="text-[#6ee7b7]">{hits} emails</span>}
      {state === "output-error" && <span className="text-rose-400">Failed</span>}
    </div>
  );
}
