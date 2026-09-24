/**
 * Claude CLI stream-json → Vercel AI SDK v5 UIMessageStream (SSE).
 *
 * v5 protocol: lines of form `data: {json}\n\n` where json is a typed part.
 * Client (`useChat` from @ai-sdk/react) natively understands these part types.
 *
 * Supported part types (subset we emit):
 *   start / start-step / finish-step / finish
 *   text-start / text-delta / text-end
 *   tool-input-available     (when Claude invokes a tool)
 *   tool-output-available    (when tool returns)
 *   data-session             (custom; carries Claude CLI session id for URL ?sid= persistence)
 *   [DONE] terminator
 */
import { createInterface } from "readline";
import { randomUUID } from "crypto";
import { saveConversationTurn } from "../db";
import { spawnClaude, checkInitPolicy, usageFromResult } from "../claude-cli";
import { EMPTY_USAGE, type ClaudeUsage } from "../demo-usage";
import { log } from "../logger";

const alog = log.child("ask");
const MODEL = process.env.EMAILDIGEST_CHAT_MODEL || "sonnet";

export interface ChatOpts {
  prompt: string;
  systemPromptPath: string;
  sessionId?: string;
  /** Visitor id (X-Demo-User); conversations are stored per user. */
  user: string;
  signal?: AbortSignal;
}

function sse(json: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(json)}\n\n`);
}

/**
 * Return a ReadableStream whose chunks are valid AI SDK v5 UI-message-stream
 * SSE lines. Call site wraps with Response + UI_MESSAGE_STREAM_HEADERS.
 *
 * Just before `[DONE]` the stream carries one `{"type":"demo_usage", ...}`
 * line for the demo gateway (model, token usage, cost, tools used and the
 * full answer text). The frontend transport drops it.
 */
export function streamChat(opts: ChatOpts): ReadableStream<Uint8Array> {
  // Hardened spawn (lib/claude-cli.ts): no built-in tools, only the local
  // emaildigest-db MCP server, empty cwd, prompt on stdin.
  const proc = spawnClaude(
    {
      model: MODEL,
      mcp: true,
      partialMessages: true,
      appendSystemPromptFile: opts.systemPromptPath,
      resumeSessionId: opts.sessionId,
    },
    opts.prompt,
  );

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const rl = createInterface({ input: proc.stdout! });
      const messageId = randomUUID();
      let sessionEmitted = false;
      let capturedSid: string | null = null;
      let initModel: string | null = null;
      let currentTextId: string | null = null;
      let emittedLen = 0;
      const knownToolCalls = new Set<string>();
      const toolsUsed = new Set<string>();
      let finishEmitted = false;
      let policyError: string | null = null;
      // Full answer text as shown to the user (all text blocks, in order).
      let answer = "";
      let resultEvt: Record<string, unknown> | null = null;

      // Emit v5 start envelope immediately
      controller.enqueue(sse({ type: "start", messageId }));
      controller.enqueue(sse({ type: "start-step" }));

      const usageLine = (): Uint8Array => {
        const usage: ClaudeUsage = resultEvt
          ? usageFromResult(resultEvt, initModel ?? MODEL, toolsUsed)
          : { ...EMPTY_USAGE, model: initModel, tools_used: Array.from(toolsUsed) };
        const finalAnswer = answer || (typeof resultEvt?.result === "string" ? resultEvt.result : "");
        return sse({ type: "demo_usage", ...usage, answer: finalAnswer });
      };

      const finish = () => {
        if (finishEmitted) return;
        finishEmitted = true;
        controller.enqueue(sse({ type: "finish-step" }));
        controller.enqueue(sse({ type: "finish" }));
        controller.enqueue(usageLine());
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      };

      // Stop button / browser disconnect / F5: kill the spawn so we don't
      // burn Claude tokens for a client that's gone. Best-effort emit a
      // cancel marker before close in case the controller is still alive
      // (it usually isn't on AbortSignal — but a Stop button click in the
      // SAME tab keeps the connection alive long enough for the client to
      // receive this and show the "interrupted" banner).
      let cancelled = false;
      opts.signal?.addEventListener("abort", () => {
        cancelled = true;
        proc.kill("SIGTERM");
        try {
          controller.enqueue(sse({ type: "error", errorText: "interrupted" }));
        } catch {}
        try { controller.close(); } catch {}
      });

      rl.on("line", (line) => {
        if (!line.trim() || policyError) return;
        let evt: Record<string, unknown>;
        try { evt = JSON.parse(line); } catch { return; }

        // Init: enforce the tool policy before the model can act, then capture
        // the session id → custom data-session part (frontend persists ?sid=).
        if (evt.type === "system" && evt.subtype === "init") {
          initModel = typeof evt.model === "string" ? evt.model : null;
          alog.info("claude init", {
            tools: evt.tools,
            mcp_servers: evt.mcp_servers,
            permissionMode: evt.permissionMode,
            cwd: evt.cwd,
          });
          policyError = checkInitPolicy(evt, true);
          if (policyError) {
            alog.error("init rejected", { policyError });
            try { proc.kill("SIGKILL"); } catch {}
            controller.enqueue(sse({ type: "error", errorText: "Ask AI is unavailable right now (mail search check failed)." }));
            return;
          }
          if (typeof evt.session_id === "string" && !sessionEmitted) {
            sessionEmitted = true;
            capturedSid = evt.session_id;
            controller.enqueue(sse({
              type: "data-session",
              id: "session",
              data: { sid: evt.session_id },
            }));
          }
          return;
        }

        if (evt.type === "assistant") {
          const msg = (evt as { message?: { content?: Array<Record<string, unknown>> } }).message;
          const parts = msg?.content || [];

          // Accumulate text from all text blocks in this snapshot (Claude CLI
          // emits full-snapshot assistant messages each tick, not char deltas)
          let fullText = "";
          for (const p of parts) {
            if (p.type === "text" && typeof p.text === "string") fullText += p.text;
          }
          if (fullText.length > emittedLen) {
            if (!currentTextId) {
              currentTextId = randomUUID();
              controller.enqueue(sse({ type: "text-start", id: currentTextId }));
              if (answer) answer += "\n\n";
            }
            const delta = fullText.slice(emittedLen);
            emittedLen = fullText.length;
            answer += delta;
            controller.enqueue(sse({ type: "text-delta", id: currentTextId, delta }));
          }

          // Tool invocations (Claude calling MCP tools)
          for (const p of parts) {
            if (p.type === "tool_use" && typeof p.id === "string" && typeof p.name === "string") {
              if (!knownToolCalls.has(p.id as string)) {
                knownToolCalls.add(p.id as string);
                toolsUsed.add(p.name as string);
                // Close any open text block before tool call
                if (currentTextId) {
                  controller.enqueue(sse({ type: "text-end", id: currentTextId }));
                  currentTextId = null;
                  emittedLen = 0;
                }
                controller.enqueue(sse({
                  type: "tool-input-available",
                  toolCallId: p.id,
                  toolName: p.name,
                  input: p.input || {},
                }));
              }
            }
          }
          return;
        }

        // Claude emits user messages with tool_result contents after each tool run
        if (evt.type === "user") {
          const msg = (evt as { message?: { content?: Array<Record<string, unknown>> } }).message;
          const parts = msg?.content || [];
          for (const p of parts) {
            if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
              const contentArr = Array.isArray(p.content) ? p.content : [];
              let text = "";
              for (const c of contentArr as Array<Record<string, unknown>>) {
                if (c.type === "text" && typeof c.text === "string") text += c.text;
              }
              let output: unknown = text;
              try { output = JSON.parse(text); } catch { /* keep as text */ }
              controller.enqueue(sse({
                type: "tool-output-available",
                toolCallId: p.tool_use_id,
                output,
              }));
            }
          }
          return;
        }

        if (evt.type === "result") {
          resultEvt = evt;
          if (currentTextId) {
            controller.enqueue(sse({ type: "text-end", id: currentTextId }));
            currentTextId = null;
          }
          if (evt.is_error === true) {
            controller.enqueue(sse({ type: "error", errorText: "Ask AI failed to finish this answer." }));
          }
          finish();
          return;
        }

        if (evt.type === "error") {
          controller.enqueue(sse({
            type: "error",
            errorText: JSON.stringify(evt).slice(0, 500),
          }));
        }
      });

      proc.stderr!.on("data", (b) => {
        const text = b.toString("utf-8");
        if (text.trim()) console.error("[chat stderr]", text.trim().slice(0, 200));
      });

      proc.on("close", (code) => {
        if (cancelled) {
          // Already enqueued the interrupted marker + closed the controller.
          // Don't write to a closed controller, and don't persist to history.
          return;
        }
        if (!finishEmitted) {
          if (currentTextId) {
            controller.enqueue(sse({ type: "text-end", id: currentTextId }));
          }
          if (code !== 0 && code !== null && !policyError) {
            controller.enqueue(sse({ type: "error", errorText: `claude exit ${code}` }));
          }
          finish();
        }
        // Persist the turn to this visitor's history (DB, not the CLI's
        // session files). Only successful runs — failed sessions stay out of
        // the list.
        if (capturedSid && code === 0 && !policyError && resultEvt?.is_error !== true) {
          try { saveConversationTurn({ sid: capturedSid, user: opts.user, prompt: opts.prompt, answer }); }
          catch (e) { console.error("[chat] saveConversationTurn failed:", e); }
        }
        try { controller.close(); } catch {}
      });

      proc.on("error", (e) => {
        controller.enqueue(sse({ type: "error", errorText: `spawn: ${e.message}` }));
        finish();
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      proc.kill("SIGTERM");
    },
  });
}
