/**
 * Per-request model-usage collection for the demo gateway contract.
 *
 * JSON AI endpoints wrap their work in `collectUsage()`; every `runClaude()`
 * call made inside that async scope records its CLI `result` usage here, and
 * the route turns the aggregate into the `X-Demo-Usage` response header. The
 * gateway reads the header while forwarding; the frontend ignores it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ClaudeUsage {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
  tools_used: string[];
}

export const EMPTY_USAGE: ClaudeUsage = {
  model: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_input_tokens: null,
  cache_creation_input_tokens: null,
  total_cost_usd: null,
  duration_ms: null,
  num_turns: null,
  tools_used: [],
};

const store = new AsyncLocalStorage<ClaudeUsage[]>();

/** Called by lib/claude-cli.ts after each finished CLI run. */
export function recordUsage(usage: ClaudeUsage): void {
  store.getStore()?.push(usage);
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => typeof v === "number");
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

/** Merge several CLI runs of one request into one usage record. */
export function mergeUsage(runs: ClaudeUsage[]): ClaudeUsage {
  if (runs.length === 0) return { ...EMPTY_USAGE, tools_used: [] };
  if (runs.length === 1) return runs[0];
  const models = Array.from(new Set(runs.map((r) => r.model).filter((m): m is string => !!m)));
  return {
    model: models.length > 0 ? models.join(",") : null,
    input_tokens: sum(runs.map((r) => r.input_tokens)),
    output_tokens: sum(runs.map((r) => r.output_tokens)),
    cache_read_input_tokens: sum(runs.map((r) => r.cache_read_input_tokens)),
    cache_creation_input_tokens: sum(runs.map((r) => r.cache_creation_input_tokens)),
    total_cost_usd: sum(runs.map((r) => r.total_cost_usd)),
    duration_ms: sum(runs.map((r) => r.duration_ms)),
    num_turns: sum(runs.map((r) => r.num_turns)),
    tools_used: Array.from(new Set(runs.flatMap((r) => r.tools_used))),
  };
}

/** Run `fn` and return its result together with the usage of every CLI run inside it. */
export async function collectUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: ClaudeUsage }> {
  const runs: ClaudeUsage[] = [];
  const result = await store.run(runs, fn);
  return { result, usage: mergeUsage(runs) };
}

/** Header value per the gateway contract: compact JSON, no `answer` field. */
export function usageHeader(usage: ClaudeUsage): Record<string, string> {
  return { "X-Demo-Usage": JSON.stringify(usage) };
}

/** Re-wrap a Response with the X-Demo-Usage header added. */
export function withUsageHeader(res: Response, usage: ClaudeUsage): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Demo-Usage", JSON.stringify(usage));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
