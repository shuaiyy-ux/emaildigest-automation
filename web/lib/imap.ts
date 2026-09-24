import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { setAppState } from "./db";
import { log } from "./logger";

const ilog = log.child("imap");
const idle = log.child("idle");

// Classify an IMAP connection error: is it "credentials are wrong" (user
// intervention required, stop retrying) or "flaky network / transient"
// (keep retrying silently, same as before).
const IMAP_AUTH_ERROR_RE = /\b(auth(entication)?\s+(fail|error|reject)|invalid\s+credent|login\s+(fail|reject)|no\s+password|bad\s+user|535|534|530)\b/i;
function isImapAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${e.name}` : String(e);
  return IMAP_AUTH_ERROR_RE.test(msg);
}

export interface ImapEmail {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  body: string;      // plain-text MIME part (parsed.text) — used for LLM prompts, reply quoting, preview
  bodyHtml: string;  // HTML MIME part (parsed.html) — used for UI rendering; '' when email is text-only
  date: string;
  receivedAt: number;
  isUnread: boolean;
  /** RFC 2369 List-Unsubscribe — presence indicates the message is part of a
   *  mailing list. We store the full value (URLs / mailto:) for forensics
   *  but the classifier only checks for non-empty. */
  listUnsubscribe: string;
  /** RFC 2919 List-Id — unique mailing list identifier (e.g.
   *  `<msa-elections.uci.edu>`). Presence strongly indicates news/junk. */
  listId: string;
  /** RFC 3834 Auto-Submitted — "auto-replied" / "auto-generated" mark machine
   *  origin. Value `no` is treated as absent. */
  autoSubmitted: string;
  /** Precedence (de-facto pre-RFC) — `bulk` / `list` / `junk` mark bulk
   *  delivery. */
  precedence: string;
}

function getCreds() {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD not configured");
  return { user, pass };
}

export function isImapConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function connect(): Promise<ImapFlow> {
  const { user, pass } = getCreds();
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  return client;
}

function toHex(n: bigint | number | string): string {
  return BigInt(n).toString(16);
}

/**
 * Outlook auto-forward rewrites the From header to the forwarder (e.g. owner@example.edu)
 * and embeds the original sender inside the body like:
 *
 *   ________________________________
 *   From: Original Sender <original@x.com>
 *   Sent: Thursday, April 16, 2026 4:43:48 PM ...
 *   To: Shuaiyu <owner@example.edu>
 *   Subject: The real subject
 *
 *   <actual body>
 *
 * This function detects the pattern and recovers the original sender / subject,
 * stripping the wrapper block so only the real content remains.
 */
function unwrapForwarded(
  body: string,
  fromName: string,
  fromEmail: string,
  subject: string,
): { body: string; from: string; fromEmail: string; subject: string } {
  const sepRe = /^_{10,}\s*$/m;
  const sepMatch = body.match(sepRe);
  if (!sepMatch || sepMatch.index === undefined) {
    return { body, from: fromName, fromEmail, subject };
  }

  const afterSep = body.slice(sepMatch.index + sepMatch[0].length).replace(/^\r?\n/, "");
  const lines = afterSep.split(/\r?\n/);
  let fromLine = "";
  let subjectLineIdx = -1;

  for (let i = 0; i < Math.min(25, lines.length); i++) {
    const line = lines[i];
    if (!fromLine && /^From:/i.test(line)) fromLine = line;
    if (/^Subject:/i.test(line)) {
      subjectLineIdx = i;
      break;
    }
  }
  if (!fromLine) return { body, from: fromName, fromEmail, subject };

  // Parse "From: X <x@y>" — take the primary sender, ignoring "On Behalf Of" suffix
  const fromValue = fromLine.replace(/^From:\s*/i, "").trim();
  const onBehalf = fromValue.search(/on\s*behalf\s*of/i);
  const primary = (onBehalf > 0 ? fromValue.slice(0, onBehalf) : fromValue).trim();

  let newName = fromName;
  let newEmail = fromEmail;
  const angle = primary.match(/<([^>]+@[^>\s]+)>/);
  if (angle) {
    newEmail = angle[1].trim();
    const nameRaw = primary.slice(0, primary.indexOf("<")).trim().replace(/^["']|["']$/g, "").trim();
    newName = nameRaw || newEmail;
  } else if (/@/.test(primary)) {
    newEmail = primary.replace(/[<>]/g, "").trim();
    newName = newEmail;
  } else {
    return { body, from: fromName, fromEmail, subject };
  }

  // Strip the wrapper block: from the separator through the first blank line
  // after the Subject: line (falls back to subjectLineIdx+1 if none found)
  let endLine = subjectLineIdx + 1;
  for (let j = subjectLineIdx + 1; j < Math.min(subjectLineIdx + 5, lines.length); j++) {
    if (lines[j].trim() === "") { endLine = j + 1; break; }
  }
  const stripped = lines.slice(endLine).join("\n").replace(/^\s+/, "");
  const newBody = body.slice(0, sepMatch.index).trimEnd();
  const combined = newBody ? `${stripped}\n\n---\n${newBody}` : stripped;

  const newSubject = subject.replace(/^(FW|Fwd|Fw):\s*/i, "").trim() || subject;

  return { body: combined.trim(), from: newName, fromEmail: newEmail, subject: newSubject };
}

function formatPacificDate(d: Date): string {
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    ...(sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "numeric", day: "numeric" }),
  });
  return fmt.format(d);
}

export async function fetchRecent(opts: { label?: string; days?: number; max?: number } = {}): Promise<ImapEmail[]> {
  const label = opts.label ?? "UCI-Mail";
  const days = opts.days ?? 30;
  const max = opts.max ?? 200;

  const client = await connect();
  const out: ImapEmail[] = [];
  try {
    // Gmail exposes each label as a top-level IMAP folder. Opening the label
    // folder directly avoids locale-specific "All Mail" names and gmailraw.
    await client.mailboxOpen(label, { readOnly: true });
    const since = new Date(Date.now() - days * 86400 * 1000);
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) return out;
    const picked = uids.slice(-max); // newest N

    const fetchQuery = { uid: true, source: true, envelope: true, flags: true, emailId: true, threadId: true, internalDate: true } as Parameters<typeof client.fetch>[1];
    for await (const msg of client.fetch(picked, fetchQuery, { uid: true })) {
      try {
        const parsed = await simpleParser(msg.source as Buffer);
        // Gmail exposes X-GM-MSGID / X-GM-THRID via emailId / threadId fields (decimal uint64).
        // Hex-encode to match the Gmail REST API's messageId format, preserving compatibility
        // with rows previously fetched via MCP.
        const id = msg.emailId ? toHex(msg.emailId) : String(msg.uid);
        const threadId = msg.threadId ? toHex(msg.threadId) : "";

        const fromAddr = parsed.from?.value?.[0];
        const rawName = fromAddr?.name?.trim() || fromAddr?.address || "";
        const rawEmail = fromAddr?.address || "";
        const rawSubject = parsed.subject || "";
        const rawBody = (parsed.text || "").trim();
        const rawHtml = (parsed.html || "").trim();
        // unwrapForwarded only operates on the plain-text body (Outlook's forward
        // wrapper pattern is line-based). The HTML version preserves the same
        // wrapper as nested blockquote, rendered readably by react-letter.
        const unwrapped = unwrapForwarded(rawBody, rawName, rawEmail, rawSubject);
        const fromName = unwrapped.from;
        const fromEmail = unwrapped.fromEmail;
        const subject = unwrapped.subject;
        const bodyRaw = unwrapped.body;
        const snippet = bodyRaw.slice(0, 50).replace(/\s+/g, " ").trim();
        const dateRaw = parsed.date || msg.internalDate || new Date();
        const date = dateRaw instanceof Date ? dateRaw : new Date(dateRaw);
        const receivedAt = Math.floor(date.getTime() / 1000);
        const isUnread = !(msg.flags?.has("\\Seen") ?? false);

        // Mailparser exposes headers as a Map<string, string | string[] | AddressObject>.
        // For our purposes we only need first-value-as-string; coalesce arrays
        // and ignore parsed address objects (none of these 4 are addresses).
        const headerValue = (key: string): string => {
          const v = parsed.headers.get(key);
          if (!v) return "";
          if (typeof v === "string") return v.trim();
          if (Array.isArray(v)) {
            const first = v.find((x) => typeof x === "string");
            return typeof first === "string" ? first.trim() : "";
          }
          return "";
        };
        const listUnsubscribe = headerValue("list-unsubscribe");
        const listId = headerValue("list-id");
        const autoSubmitted = headerValue("auto-submitted");
        const precedence = headerValue("precedence");

        out.push({
          id,
          threadId,
          from: fromName,
          fromEmail,
          subject,
          snippet,
          body: bodyRaw,
          bodyHtml: rawHtml,
          date: formatPacificDate(date),
          receivedAt,
          isUnread,
          listUnsubscribe,
          listId,
          autoSubmitted,
          precedence,
        });
      } catch (e) {
        ilog.warn("parse error", { err: e });
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  // newest first
  out.sort((a, b) => b.receivedAt - a.receivedAt);
  return out;
}

let idleClient: ImapFlow | null = null;
let idleStopRequested = false;

// Health-state writers — surface to UI via GET /api/emails.claudeAuth
// (same banner pattern, different key).
function markImapHealthy() {
  try {
    setAppState("imap_status", "ok");
    setAppState("imap_error", "");
    setAppState("imap_checked_at", String(Math.floor(Date.now() / 1000)));
  } catch {/* telemetry only */}
}

function markImapFailed(kind: "auth" | "transient", err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    setAppState("imap_status", kind === "auth" ? "auth_failed" : "transient_failed");
    setAppState("imap_error", msg.slice(0, 200));
    setAppState("imap_checked_at", String(Math.floor(Date.now() / 1000)));
  } catch {/* telemetry only */}
}

export async function startIdleListener(onNew: () => void): Promise<void> {
  if (!isImapConfigured()) {
    idle.info("IMAP not configured, skipping");
    return;
  }
  idleStopRequested = false;
  // Trip the auth-error circuit breaker after 3 consecutive auth-looking
  // failures. 3 allows for transient quirks but stops the infinite loop
  // that fires when the app password is rotated / revoked.
  let consecutiveAuthFailures = 0;
  const AUTH_FAILURE_THRESHOLD = 3;

  const loop = async () => {
    while (!idleStopRequested) {
      try {
        const client = await connect();
        idleClient = client;
        await client.mailboxOpen("UCI-Mail", { readOnly: true });
        consecutiveAuthFailures = 0;
        markImapHealthy();
        idle.info("Listening on UCI-Mail", { user: process.env.GMAIL_USER });

        client.on("exists", (data: { count: number; prevCount: number }) => {
          if (data.count > data.prevCount) {
            idle.info("exists → triggering prefetch", { prev: data.prevCount, now: data.count });
            try { onNew(); } catch (e) { idle.error("onNew error", { err: e }); }
          }
        });

        // Block here until connection drops; imapflow handles IDLE internally
        await new Promise<void>((resolve) => {
          client.on("close", () => resolve());
          client.on("error", (e) => { idle.error("client error", { err: e }); resolve(); });
        });
      } catch (e) {
        if (isImapAuthError(e)) {
          consecutiveAuthFailures++;
          idle.error("auth error", { attempt: consecutiveAuthFailures, threshold: AUTH_FAILURE_THRESHOLD, err: e });
          if (consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
            markImapFailed("auth", e);
            idle.error("auth failure threshold reached — giving up. Update GMAIL_APP_PASSWORD and restart.");
            break;
          }
        } else {
          markImapFailed("transient", e);
          idle.warn("connection error", { err: e });
        }
      }
      idleClient = null;
      if (idleStopRequested) break;
      idle.info("reconnecting in 5s");
      await new Promise((r) => setTimeout(r, 5000));
    }
  };

  loop();
}

export async function stopIdleListener() {
  idleStopRequested = true;
  if (idleClient) {
    await idleClient.logout().catch(() => {});
    idleClient = null;
  }
}
