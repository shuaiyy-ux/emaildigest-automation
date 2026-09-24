/**
 * EmailDigest single-shot health check.
 *
 * Run me whenever the user says "check / 检查 / status / 状态 / spawn count /
 * 看看" — I cover all the dimensions you'd otherwise rediscover ad-hoc:
 *
 *   [1] Spawns: daily distribution + per-caller cost (since token-check baseline)
 *   [2] SetFit: pass-rate trend by day + head dim safety gate
 *   [3] Recent merges: schema columns + backfill coverage + last-24h ingest health
 *   [4] MCP / errors: stdio server path-resolution + logs table errors
 *
 * Output is plain text, machine-readable enough for diff between runs.
 *
 * Usage:
 *   cd web && npx tsx scripts/health-check.ts
 *   ssh prod 'cd ~/emaildigest/web && npx tsx scripts/health-check.ts'
 *
 * This does NOT mark a new token-check baseline — call
 * `token-check.ts --mark` separately after reporting.
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const EMAILDIGEST_DIR = path.resolve(
  process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."),
);
const DB_PATH = path.join(EMAILDIGEST_DIR, "data.db");

const SONNET_4_6 = { in: 3.0, cr: 0.30, cc: 3.75, out: 15.0 };
const HAIKU_4_5 = { in: 1.0, cr: 0.10, cc: 1.25, out: 5.0 };

function priceFor(m: string) { return m.includes("haiku") ? HAIKU_4_5 : SONNET_4_6; }

function classifyPrompt(p: string): string {
  // Keep in sync with token-check.ts:classifyPrompt
  if (/<task>\s*You will perform 1-[23] INDEPENDENT analytical tasks/i.test(p)) return "merged-prefetch";
  if (/Extract \*\*real, user-facing scheduled events/i.test(p)) return "event-extract";
  if (/TASK: For each email line|push_summary|Inbox lines \(one per email\)/i.test(p)) return "email-digest";
  if (/AI草稿|生成回复|polish.*draft/i.test(p)) return "draft-gen";
  if (/search_emails|read_full_email/i.test(p)) return "ask-ai";
  if (/is_job|determine if.*job|career/i.test(p)) return "jobs-confirm";
  if (/primary.+track.+news.+junk/i.test(p)) return "llm-classify";
  return "unknown";
}

function header(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ───────────────────────── [1] Spawns ─────────────────────────
function section1Spawns(db: Database.Database) {
  header(`[1] Spawns / cost (since token-check baseline)`);
  const row = db.prepare(`SELECT value FROM app_state WHERE key='token_check_baseline_at'`).get() as { value: string } | undefined;
  if (!row) { console.log("No baseline. Run: npx tsx scripts/token-check.ts --mark"); return; }
  const baseline = parseInt(row.value, 10);
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const slug = EMAILDIGEST_DIR.replace(/\//g, "-");
  let tmpResolved = os.tmpdir();
  try { tmpResolved = fs.realpathSync(tmpResolved); } catch {}
  const dirs = [path.join(projectsRoot, slug), path.join(projectsRoot, tmpResolved.replace(/\//g, "-"))].filter(fs.existsSync);

  const files: { path: string; mtime: number }[] = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(d, f);
      const st = fs.statSync(full);
      if (st.mtime.getTime() / 1000 > baseline) files.push({ path: full, mtime: st.mtime.getTime() / 1000 });
    }
  }

  const byCaller = new Map<string, { files: number; cost: number; model: string }>();
  const byDay = new Map<string, number>();
  let totalCost = 0;

  for (const f of files) {
    let prompt = "", model = "?";
    let s = { in: 0, out: 0, cr: 0, cc: 0 };
    try {
      for (const line of fs.readFileSync(f.path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try { o = JSON.parse(line); } catch { continue; }
        if (!prompt && o.type === "user") {
          const c = (o.message as { content?: unknown })?.content;
          if (Array.isArray(c)) {
            for (const part of c as Array<{ type?: string; text?: string }>) {
              if (part?.type === "text" && typeof part.text === "string") { prompt = part.text.slice(0, 400); break; }
            }
          } else if (typeof c === "string") prompt = c.slice(0, 400);
        }
        const msg = o.message as { model?: string; usage?: Record<string, number> } | undefined;
        if (msg?.model) model = msg.model;
        const u = msg?.usage;
        if (u) {
          s.in += u.input_tokens || 0; s.out += u.output_tokens || 0;
          s.cr += u.cache_read_input_tokens || 0; s.cc += u.cache_creation_input_tokens || 0;
        }
      }
    } catch { continue; }

    const p = priceFor(model);
    const fileCost = (s.in / 1e6) * p.in + (s.cr / 1e6) * p.cr + (s.cc / 1e6) * p.cc + (s.out / 1e6) * p.out;
    totalCost += fileCost;

    const caller = classifyPrompt(prompt);
    const key = `${caller}|${model}`;
    const agg = byCaller.get(key) || { files: 0, cost: 0, model };
    agg.files++; agg.cost += fileCost;
    byCaller.set(key, agg);

    const day = new Date(f.mtime * 1000).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  const dur = (Date.now() / 1000 - baseline) / 3600;
  console.log(`Baseline: ${new Date(baseline * 1000).toISOString()}  (${dur.toFixed(1)}h)`);
  console.log(`Total: ${files.length} spawns | $${totalCost.toFixed(2)}`);
  console.log(`Per-caller:`);
  const rows = [...byCaller.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(46)} ${String(v.files).padStart(4)} files  $${v.cost.toFixed(2).padStart(6)}`);

  const days = [...byDay.entries()].sort();
  const last10 = days.slice(-10);
  console.log(`Per-day mtime count (touch≠spawn, rough):`);
  for (const [d, n] of last10) console.log(`  ${d}: ${n}`);
  const avgPerDay = files.length / Math.max(dur / 24, 0.01);
  const budgetOK = avgPerDay < 30 ? "OK" : "OVER";
  console.log(`Avg: ${avgPerDay.toFixed(1)} spawns/day  (target <30)  ${budgetOK}`);
}

// ───────────────────────── [2] SetFit ─────────────────────────
function section2SetFit(db: Database.Database) {
  header(`[2] SetFit pass rate (last 14 days, by classified_at)`);
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', classified_at, 'unixepoch', 'localtime') AS day,
           classifier, COUNT(*) AS n
    FROM emails
    WHERE classified_at > unixepoch() - 14 * 86400
    GROUP BY day, classifier
    ORDER BY day DESC, classifier
  `).all() as { day: string; classifier: string; n: number }[];

  const dayMap = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!dayMap.has(r.day)) dayMap.set(r.day, {});
    dayMap.get(r.day)![r.classifier] = r.n;
  }
  console.log(`day        setfit  llm  user  total  pass-rate`);
  let postSetfit = 0, postTotal = 0;
  for (const [day, m] of dayMap) {
    const s = m.setfit || 0, l = m.llm || 0, u = m.user || 0;
    const tot = s + l + u;
    const pass = s + l > 0 ? ((s / (s + l)) * 100).toFixed(0) + "%" : "—";
    console.log(`${day}    ${String(s).padStart(3)}   ${String(l).padStart(3)}  ${String(u).padStart(3)}   ${String(tot).padStart(4)}   ${pass.padStart(5)}`);
    postSetfit += s; postTotal += s + l;
  }
  const overall = postTotal > 0 ? ((postSetfit / postTotal) * 100).toFixed(1) : "—";
  console.log(`Overall (14d): ${overall}% pass rate (n=${postTotal})`);

  const headRow = db.prepare(`SELECT value FROM app_state WHERE key='setfit_classify_head_runtime'`).get() as { value: string } | undefined;
  const ver = db.prepare(`SELECT value FROM app_state WHERE key='setfit_classify_head_version'`).get() as { value: string } | undefined;
  if (headRow) {
    try {
      const j = JSON.parse(headRow.value);
      const dim0 = j.coef?.length || 0;
      const dim1 = j.coef?.[0]?.length || 0;
      const gateStatus = dim1 === 384 ? "OK (safety gate held)" : dim1 === 394 ? "ACTIVATED (394-d)" : `unexpected (${dim1})`;
      console.log(`Head dim: [${dim0}][${dim1}]  version=${ver?.value || "?"}  ${gateStatus}`);
    } catch { console.log(`Head dim: parse failed`); }
  } else console.log(`Head dim: runtime override absent → using disk head.json`);
}

// ───────────────────────── [3] Feature delivery ─────────────────────────
function section3Features(db: Database.Database) {
  header(`[3] Feature delivery (Gmail L1/L2/L3 + general schema)`);
  const cols = db.prepare(`PRAGMA table_info(emails)`).all() as { name: string }[];
  const want = ["list_unsubscribe", "list_id", "auto_submitted", "precedence", "classify_embedding", "work_embedding"];
  const present = new Set(cols.map((c) => c.name));
  for (const w of want) console.log(`  ${present.has(w) ? "✓" : "✗"}  emails.${w}`);

  if (present.has("list_unsubscribe")) {
    const r = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN list_unsubscribe != '' THEN 1 ELSE 0 END) lu,
      SUM(CASE WHEN list_id != '' THEN 1 ELSE 0 END) li,
      SUM(CASE WHEN auto_submitted NOT IN ('','no') THEN 1 ELSE 0 END) au,
      SUM(CASE WHEN precedence IN ('bulk','list','junk') THEN 1 ELSE 0 END) pr
    FROM emails`).get() as { total: number; lu: number; li: number; au: number; pr: number };
    console.log(`Backfill coverage (all): lu=${r.lu} li=${r.li} au=${r.au} pr=${r.pr} / ${r.total}`);

    const r24 = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN list_unsubscribe != '' THEN 1 ELSE 0 END) lu,
      SUM(CASE WHEN list_id != '' THEN 1 ELSE 0 END) li,
      SUM(CASE WHEN auto_submitted NOT IN ('','no') THEN 1 ELSE 0 END) au,
      SUM(CASE WHEN precedence IN ('bulk','list','junk') THEN 1 ELSE 0 END) pr
    FROM emails WHERE received_at > unixepoch() - 86400`).get() as { total: number; lu: number; li: number; au: number; pr: number };
    console.log(`Last 24h:                lu=${r24.lu} li=${r24.li} au=${r24.au} pr=${r24.pr} / ${r24.total}`);
  }
}

// ───────────────────────── [4] MCP / errors ─────────────────────────
function section4Health(db: Database.Database) {
  header(`[4] MCP server + logs`);
  // Replicate mcp-server/server.ts path resolution
  const serverJs = path.join(EMAILDIGEST_DIR, "mcp-server", "dist", "server.js");
  const exists = fs.existsSync(serverJs);
  console.log(`  ${exists ? "✓" : "✗"}  mcp-server/dist/server.js present`);
  if (exists) {
    // server.ts resolves: dirname(import.meta.url) + ".."  → mcp-server/  (BUG: should be project root)
    const fallback = path.resolve(path.dirname(serverJs), "..");
    const dbFallback = path.join(fallback, "data.db");
    const reachable = fs.existsSync(dbFallback);
    console.log(`  ${reachable ? "✓" : "✗"}  fallback DB_PATH resolves to file: ${dbFallback}`);
    if (!reachable) console.log(`     → Claude Code sessions in this dir lose emaildigest-db MCP tools`);
    console.log(`     (PROD Ask AI unaffected: stream.ts sets EMAILDIGEST_DIR explicitly)`);
  }

  const errs = db.prepare(`SELECT COUNT(*) n FROM logs WHERE level IN ('error','warn') AND ts > unixepoch() - 86400`).get() as { n: number };
  console.log(`  Logs (24h): ${errs.n} error/warn rows`);
  if (errs.n > 0) {
    const sample = db.prepare(`SELECT datetime(ts,'unixepoch','localtime') t, level, component, substr(message,1,80) msg
                                FROM logs WHERE level IN ('error','warn') AND ts > unixepoch() - 86400
                                ORDER BY ts DESC LIMIT 5`).all();
    for (const r of sample as Array<{ t: string; level: string; component: string; msg: string }>) {
      console.log(`    ${r.t} [${r.level}] ${r.component}: ${r.msg}`);
    }
  }

  const auth = db.prepare(`SELECT value FROM app_state WHERE key='claude_auth_status'`).get() as { value: string } | undefined;
  console.log(`  Claude CLI auth: ${auth?.value || "unknown"}`);
}

// ───────────────────────── main ─────────────────────────
function main() {
  console.log(`EmailDigest health check`);
  console.log(`now: ${new Date().toISOString()}`);
  console.log(`EMAILDIGEST_DIR: ${EMAILDIGEST_DIR}`);
  if (!fs.existsSync(DB_PATH)) {
    console.error(`data.db not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });
  try {
    section1Spawns(db);
    section2SetFit(db);
    section3Features(db);
    section4Health(db);
  } finally { db.close(); }
}

main();
