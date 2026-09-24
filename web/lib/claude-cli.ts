/**
 * The only place the web app starts the `claude` CLI.
 *
 * Every spawn is locked down the same way (see buildClaudeArgs):
 *   --tools ""                  no built-in tools (no Bash, Read, Write, WebFetch, Task…)
 *   --strict-mcp-config         only MCP servers passed via --mcp-config; nothing from
 *                               user/project config and no claude.ai account connectors
 *   --mcp-config <json>         only for Ask AI: the local read-only emaildigest-db server
 *   --allowedTools <names>      only for Ask AI: the three emaildigest-db tool names
 *   --setting-sources ""        ignore user / project / local settings (hooks, plugins, permissions)
 *   --disable-slash-commands    no skills
 *   --permission-mode dontAsk   anything not pre-allowed is denied, never prompted
 *   cwd = CLAUDE_WORKDIR        an empty dedicated directory (no CLAUDE.md, no repo files)
 *   env = allowlist             no app secrets (SMTP password, auth token, VAPID keys)
 *   prompt on stdin             user text can never be parsed as a CLI flag
 *
 * On top of the flags, the `system/init` event is checked against the expected
 * tool list; any extra tool or MCP server kills the run before the model acts.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createInterface } from "readline";
import { breakerOpen, recordSuccess, recordFailure, BreakerOpenError } from "./circuit-breaker";
import { flagAuthFailureIfMatch, clearAuthFailure } from "./auth-status";
import { recordUsage, type ClaudeUsage } from "./demo-usage";
import { log } from "./logger";

const clog = log.child("claude-cli");

// Runtime paths from env, with a fallback.
function runtimePath(envKey: string, fallback: () => string): string {
  return path.resolve(process.env[envKey] || fallback());
}

/** Empty directory used as cwd for every spawn. Stable path so Ask AI --resume works. */
export const CLAUDE_WORKDIR = runtimePath("EMAILDIGEST_CLAUDE_CWD", () => path.join(os.tmpdir(), "emaildigest-claude-cwd"));

/** Data directory (data.db); the MCP server reads it from its env. */
const EMAILDIGEST_DIR = runtimePath("EMAILDIGEST_DIR", () => path.join(process.cwd(), ".."));

/** Built MCP server, next to the web app's code (the data dir may live elsewhere). */
const MCP_SERVER_JS = runtimePath("EMAILDIGEST_MCP_SERVER", () => path.join(process.cwd(), "..", "mcp-server", "dist", "server.js"));

export const MCP_SERVER_NAME = "emaildigest-db";
export const MCP_TOOL_NAMES = ["search_emails", "read_full_email", "get_application"].map(
  (t) => `mcp__${MCP_SERVER_NAME}__${t}`,
);

/** Per-call spend ceiling passed to the CLI (print mode only). */
const MAX_BUDGET_USD = process.env.EMAILDIGEST_MAX_BUDGET_USD || "1.00";

/** Environment variables the CLI (and the MCP server it starts) may see. */
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "TERM",
  // CLI login and config location (subscription OAuth token on servers, or an API key)
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME",
  // outbound proxy / CA settings, if the host needs them
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
];

function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  // Belt and braces next to --strict-mcp-config: never load claude.ai connectors.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/**
 * Create the working directory if needed and refuse to run if anything is in
 * it: an unexpected CLAUDE.md or settings file there would change behavior.
 */
export function ensureClaudeWorkdir(): string {
  fs.mkdirSync(CLAUDE_WORKDIR, { recursive: true, mode: 0o700 });
  const entries = fs.readdirSync(CLAUDE_WORKDIR);
  if (entries.length > 0) {
    throw new Error(`claude working directory is not empty: ${CLAUDE_WORKDIR}`);
  }
  return CLAUDE_WORKDIR;
}

function mcpConfigJson(): string {
  const port = process.env.PORT || "3000";
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [MCP_SERVER_JS],
        env: {
          EMAILDIGEST_DIR,
          EMAILDIGEST_INTERNAL_URL: process.env.EMAILDIGEST_INTERNAL_URL || `http://127.0.0.1:${port}`,
        },
      },
    },
  });
}

export interface ClaudeArgsOptions {
  model: string;
  /** Mount the local emaildigest-db MCP server and allow exactly its tools. */
  mcp?: boolean;
  /** Replace the CLI's default system prompt. */
  systemPrompt?: string;
  /** Append a file to the default system prompt. */
  appendSystemPromptFile?: string;
  /** Stream partial assistant messages (Ask AI). */
  partialMessages?: boolean;
  /** Continue an earlier Ask AI session (validated UUID). */
  resumeSessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    "--model", o.model,
    "--output-format", "stream-json",
    "--verbose",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--max-budget-usd", MAX_BUDGET_USD,
  ];
  if (o.mcp) {
    args.push("--mcp-config", mcpConfigJson());
    args.push("--allowedTools", MCP_TOOL_NAMES.join(","));
  }
  if (o.partialMessages) args.push("--include-partial-messages");
  if (o.systemPrompt) args.push("--system-prompt", o.systemPrompt);
  if (o.appendSystemPromptFile) args.push("--append-system-prompt-file", o.appendSystemPromptFile);
  if (o.resumeSessionId) {
    if (!UUID_RE.test(o.resumeSessionId)) throw new Error("invalid session id");
    args.push("--resume", o.resumeSessionId);
  }
  return args;
}

/** Start the CLI with the prompt on stdin. Caller consumes stream-json on stdout. */
export function spawnClaude(o: ClaudeArgsOptions, prompt: string): ChildProcess {
  const cwd = ensureClaudeWorkdir();
  // Literal command name (resolved on PATH): a variable here makes the
  // bundler's output tracing pull in the whole project.
  const proc = spawn("claude", buildClaudeArgs(o), {
    cwd,
    env: claudeEnv() as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.on("error", () => { /* child exited before reading stdin; close handler reports */ });
  proc.stdin?.end(prompt);
  return proc;
}

/**
 * Check the `system/init` event. Returns an error string when the session
 * exposes anything beyond the expected tools / MCP servers, else null.
 */
export function checkInitPolicy(evt: Record<string, unknown>, mcp: boolean): string | null {
  const tools = Array.isArray(evt.tools) ? (evt.tools as unknown[]).map(String) : [];
  const allowed = new Set(mcp ? MCP_TOOL_NAMES : []);
  const extraTools = tools.filter((t) => !allowed.has(t));
  const servers = Array.isArray(evt.mcp_servers)
    ? (evt.mcp_servers as Array<{ name?: unknown }>).map((s) => String(s?.name ?? ""))
    : [];
  const extraServers = servers.filter((s) => !(mcp && s === MCP_SERVER_NAME));
  if (extraTools.length > 0 || extraServers.length > 0) {
    return `tool policy violation: tools=${JSON.stringify(extraTools)} mcp_servers=${JSON.stringify(extraServers)}`;
  }
  if (mcp) {
    // Without its mail tools Ask AI would answer from nothing; fail closed.
    const own = (evt.mcp_servers as Array<{ name?: unknown; status?: unknown }> | undefined)
      ?.find((s) => s?.name === MCP_SERVER_NAME);
    if (own?.status !== "connected") return `${MCP_SERVER_NAME} MCP server not connected (status ${String(own?.status ?? "missing")})`;
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Build the gateway usage record from a CLI `result` event. */
export function usageFromResult(
  evt: Record<string, unknown>,
  fallbackModel: string | null,
  toolsUsed: Iterable<string>,
): ClaudeUsage {
  const u = (evt.usage && typeof evt.usage === "object" ? evt.usage : {}) as Record<string, unknown>;
  const modelUsage = evt.modelUsage && typeof evt.modelUsage === "object"
    ? Object.keys(evt.modelUsage as Record<string, unknown>)
    : [];
  return {
    model: modelUsage.length > 0 ? modelUsage.join(",") : fallbackModel,
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    total_cost_usd: num(evt.total_cost_usd),
    duration_ms: num(evt.duration_ms),
    num_turns: num(evt.num_turns),
    tools_used: Array.from(new Set(toolsUsed)),
  };
}

export interface RunClaudeOptions {
  /** Short caller name for logs (e.g. "draft-gen", "event-extract"). */
  label: string;
  prompt: string;
  model: string;
  systemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Circuit breaker handling: "gate" (default) refuses while open and records
   * the outcome; "record" only records; "off" does neither.
   */
  breaker?: "gate" | "record" | "off";
}

export interface RunClaudeResult {
  text: string;
  usage: ClaudeUsage;
}

/**
 * One tool-less, non-interactive CLI run. Resolves with the final assistant
 * text; rejects on timeout, abort, non-zero exit, CLI error result or policy
 * violation. Usage is recorded into the current collectUsage() scope.
 */
export async function runClaude(o: RunClaudeOptions): Promise<RunClaudeResult> {
  const breaker = o.breaker ?? "gate";
  if (breaker === "gate" && breakerOpen()) throw new BreakerOpenError();
  if (o.signal?.aborted) throw new Error("aborted");

  const run = new Promise<RunClaudeResult>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawnClaude({ model: o.model, systemPrompt: o.systemPrompt }, o.prompt);
    } catch (e) {
      reject(e);
      return;
    }
    let stderr = "";
    let resultEvt: Record<string, unknown> | null = null;
    let initModel: string | null = null;
    let policyError: string | null = null;
    let settled = false;
    const toolsUsed = new Set<string>();

    const finish = (err: Error | null, value?: RunClaudeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => {
      try { proc.kill("SIGTERM"); } catch {}
      finish(new Error("aborted"));
    };
    o.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      if (breaker !== "off") recordFailure();
      finish(new Error(`${o.label} timeout after ${o.timeoutMs}ms`));
    }, o.timeoutMs ?? 120_000);

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(line); } catch { return; }
      if (evt.type === "system" && evt.subtype === "init") {
        initModel = typeof evt.model === "string" ? evt.model : null;
        policyError = checkInitPolicy(evt, false);
        if (policyError) {
          clog.error("init rejected", { label: o.label, policyError });
          try { proc.kill("SIGKILL"); } catch {}
        }
        return;
      }
      if (evt.type === "assistant") {
        const content = (evt.message as { content?: Array<Record<string, unknown>> } | undefined)?.content || [];
        for (const p of content) {
          if (p.type === "tool_use" && typeof p.name === "string") toolsUsed.add(p.name);
        }
        return;
      }
      if (evt.type === "result") resultEvt = evt;
    });
    proc.stderr!.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (err) => {
      if (breaker !== "off") recordFailure();
      finish(err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      if (policyError) {
        if (breaker !== "off") recordFailure();
        finish(new Error(policyError));
        return;
      }
      const r = resultEvt as Record<string, unknown> | null;
      const text = typeof r?.result === "string" ? r.result : "";
      if (code === 0 && r && r.is_error !== true) {
        if (breaker !== "off") recordSuccess();
        clearAuthFailure();
        const usage = usageFromResult(r, initModel ?? o.model, toolsUsed);
        finish(null, { text, usage });
        return;
      }
      if (breaker !== "off") recordFailure();
      flagAuthFailureIfMatch(stderr, text, code);
      const detail = (text || stderr).trim().slice(0, 200);
      const err = new Error(`${o.label} exit ${code}${detail ? `: ${detail}` : ""}`) as Error & { usage?: ClaudeUsage };
      // A failed run can still have spent tokens; report them too.
      if (r) err.usage = usageFromResult(r, initModel ?? o.model, toolsUsed);
      finish(err);
    });
  });

  let res: RunClaudeResult;
  try {
    res = await run;
  } catch (e) {
    const usage = (e as { usage?: ClaudeUsage }).usage;
    if (usage) recordUsage(usage);
    throw e;
  }
  // Recorded here (after the await) so it lands in the caller's async scope.
  recordUsage(res.usage);
  return res;
}
