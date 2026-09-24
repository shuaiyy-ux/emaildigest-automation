/**
 * Browser-side helpers for the public demo.
 *
 * The demo gateway answers an AI request with HTTP 429
 * `{"error":"quota_exceeded","message":"Limit reached. Available again in about N hours."}`
 * when the shared quota is used up. Every AI action shows that `message`
 * verbatim next to the action and leaves the rest of the page usable.
 */

export const QUOTA_EXCEEDED = "quota_exceeded";

export interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
}

/** Parse a JSON body without throwing (429 / proxy errors may not be JSON). */
export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T & ApiErrorBody> {
  try {
    return (await res.json()) as T & ApiErrorBody;
  } catch {
    return {} as T & ApiErrorBody;
  }
}

/** Text to show for a failed AI request: the gateway's quota message verbatim, else the API error. */
export function aiErrorMessage(res: Response, data: ApiErrorBody, fallback: string): string {
  if (res.status === 429 && typeof data.message === "string" && data.message) return data.message;
  if (data.error === "demo_disabled" && typeof data.message === "string") return data.message;
  if (typeof data.error === "string" && data.error) return data.error;
  return fallback;
}

/**
 * fetch() for the Ask AI chat transport. Drops the `demo_usage` SSE event
 * (it is for the gateway, not the UI message stream) and turns a non-2xx JSON
 * reply into an Error whose message is the text to show.
 */
export async function chatFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const data = await readJson(res);
    throw new ChatRequestError(aiErrorMessage(res, data, `Request failed (${res.status})`), res.status, data.error);
  }
  if (!res.body) return res;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const filtered = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, idx + 2);
          buffer = buffer.slice(idx + 2);
          if (!isDemoUsageEvent(event)) controller.enqueue(encoder.encode(event));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer && !isDemoUsageEvent(buffer)) controller.enqueue(encoder.encode(buffer));
      },
    }),
  );
  return new Response(filtered, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function isDemoUsageEvent(event: string): boolean {
  const line = event.trim();
  if (!line.startsWith("data: {")) return false;
  try {
    return (JSON.parse(line.slice(6)) as { type?: unknown }).type === "demo_usage";
  } catch {
    return false;
  }
}

export class ChatRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: unknown) {
    super(message);
  }
}
