/**
 * One-shot ops tool: backfill list_unsubscribe / list_id / auto_submitted /
 * precedence on historical emails by re-fetching from IMAP.
 *
 * Strategy: bulk-fetch all messages in UCI-Mail label in one IMAP call, then
 * match by X-GM-MSGID (returned by imapflow as `emailId`, converted to hex
 * matches our DB id). Saves 593 round-trips vs per-id lookup.
 *
 * Usage:
 *   cd web && npx tsx scripts/backfill-imap-headers.ts
 *   # snapshot DB:
 *   EMAILDIGEST_DIR=/tmp/prod-snapshot npx tsx scripts/backfill-imap-headers.ts
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import db from "../lib/db";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const LABEL = "UCI-Mail";

async function connect(): Promise<ImapFlow> {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD env not set");
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }, logger: false,
  });
  await client.connect();
  return client;
}

function headerValueFromParsed(parsed: { headers: Map<string, unknown> }, key: string): string {
  const v = parsed.headers.get(key);
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first.trim() : "";
  }
  return "";
}

async function main() {
  // Build map of target ids → 1 (for fast lookup during bulk fetch).
  const rows = db.prepare(`
    SELECT id FROM emails
    WHERE list_unsubscribe = '' AND list_id = '' AND auto_submitted = '' AND precedence = ''
      AND received_at > unixepoch() - 365 * 86400
  `).all() as { id: string }[];

  const targetIds = new Set(rows.map((r) => r.id));
  console.log(`Backfill target: ${targetIds.size} emails`);
  if (targetIds.size === 0) return;

  const client = await connect();
  await client.mailboxOpen(LABEL, { readOnly: true });

  // Search for messages received in last 365 days. UID list will include
  // everything we care about (and more we don't, but cheap to filter).
  const since = new Date(Date.now() - 365 * 86400 * 1000);
  const uids = await client.search({ since }, { uid: true }) as number[];
  console.log(`IMAP search returned ${uids.length} UIDs in last 365 days`);

  const updateStmt = db.prepare(`
    UPDATE emails SET list_unsubscribe = ?, list_id = ?, auto_submitted = ?, precedence = ?
    WHERE id = ?
  `);

  let scanned = 0, updated = 0, errored = 0;
  const startedAt = Date.now();
  const fetchQuery = { uid: true, source: true, emailId: true } as Parameters<typeof client.fetch>[1];

  for await (const msg of client.fetch(uids, fetchQuery, { uid: true })) {
    scanned++;
    try {
      const hexId = msg.emailId ? BigInt(msg.emailId).toString(16) : "";
      if (!hexId || !targetIds.has(hexId)) continue;

      const parsed = await simpleParser(msg.source as Buffer);
      const lu = headerValueFromParsed(parsed, "list-unsubscribe");
      const li = headerValueFromParsed(parsed, "list-id");
      const au = headerValueFromParsed(parsed, "auto-submitted");
      const pr = headerValueFromParsed(parsed, "precedence");

      updateStmt.run(lu, li, au, pr, hexId);
      updated++;
      if (updated % 50 === 0) {
        console.log(`[backfill] ${updated}/${targetIds.size} updated (scanned ${scanned}, ${Math.round((Date.now() - startedAt) / 1000)}s)`);
      }
    } catch (e) {
      errored++;
      if (errored < 5) console.warn(`[backfill] err:`, String(e).slice(0, 100));
    }
  }

  await client.logout();

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nDone: scanned ${scanned} IMAP messages, updated ${updated}/${targetIds.size} target ids, ${errored} errors, ${elapsed}s`);

  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN list_unsubscribe != '' THEN 1 ELSE 0 END) AS lu,
      SUM(CASE WHEN list_id != '' THEN 1 ELSE 0 END) AS li,
      SUM(CASE WHEN auto_submitted != '' AND auto_submitted != 'no' THEN 1 ELSE 0 END) AS au,
      SUM(CASE WHEN precedence IN ('bulk','list','junk') THEN 1 ELSE 0 END) AS pr,
      COUNT(*) AS total
    FROM emails
  `).get();
  console.log("Post-backfill totals:", stats);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
