/**
 * Token usage checkpoint + reporter.
 *
 * Two modes:
 *   --mark              Write current epoch to app_state.token_check_baseline_at.
 *                       All jsonl files modified after this timestamp will be
 *                       counted on the next default-mode run.
 *   (no flag)           Read baseline → scan ~/.claude/projects/<dir>/*.jsonl
 *                       with mtime > baseline → aggregate token usage by caller
 *                       (prompt-pattern detection) and model. Report cost.
 *
 * Environment auto-detect: scans the current EMAILDIGEST_DIR's matching
 * Claude project dir (named after the directory the CLI ran in).
 *
 * Usage:
 *   npx tsx scripts/token-check.ts --mark         # plant checkpoint
 *   npx tsx scripts/token-check.ts                # report since checkpoint
 *   ssh prod "cd ~/emaildigest/web && npx tsx scripts/token-check.ts"
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SONNET_4_6 = { in: 3.0, cr: 0.30, cc: 3.75, out: 15.0 };
const HAIKU_4_5 = { in: 1.0, cr: 0.10, cc: 1.25, out: 5.0 };

const EMAILDIGEST_DIR = path.resolve(
  process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."),
);

/**
 * Claude CLI writes session jsonl to ~/.claude/projects/<slugified-cwd>/.
 * EmailDigest spawns from TWO different cwds:
 *   1. EMAILDIGEST_DIR — for ./emaildigest shell wrapper (subprocess.ts inquiry path):
 *       classify Step 2b, jobs llmConfirmBatch (briefings retired 2026-05-02),
 *       push-to-gmail, reclassify, force-classify, ai-generate
 *   2. os.tmpdir() — for direct `claude -p` paths:
 *       event-extract, email-digest, draft-gen, **merged-prefetch**, ask-ai
 * On Linux os.tmpdir() = "/tmp" → slug "-tmp"; on macOS it's "/var/folders/.../T"
 * but symlink target /private/tmp resolves to slug "-private-tmp". Scan both.
 */
function getCheckpointDirs(): string[] {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const projectSlug = EMAILDIGEST_DIR.replace(/\//g, "-");
  // Resolve tmpdir symlinks (macOS /tmp → /private/tmp) so the slug matches
  // what Claude CLI actually sees as cwd.
  let tmpResolved = os.tmpdir();
  try { tmpResolved = fs.realpathSync(tmpResolved); } catch {}
  const tmpSlug = tmpResolved.replace(/\//g, "-");
  return [
    path.join(projectsRoot, projectSlug),
    path.join(projectsRoot, tmpSlug),
  ];
}

function readBaseline(): number | null {
  const dbPath = path.join(EMAILDIGEST_DIR, "data.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(`SELECT value FROM app_state WHERE key = 'token_check_baseline_at'`).get() as { value: string } | undefined;
  db.close();
  return row ? parseInt(row.value, 10) : null;
}

function writeBaseline(): number {
  const dbPath = path.join(EMAILDIGEST_DIR, "data.db");
  const db = new Database(dbPath);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('token_check_baseline_at', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  ).run(String(now));
  db.close();
  return now;
}

interface Stats {
  files: number;
  in: number;
  out: number;
  cr: number;
  cc: number;
}

function newStats(): Stats {
  return { files: 0, in: 0, out: 0, cr: 0, cc: 0 };
}

function classifyPrompt(prompt: string): string {
  const p = prompt || "";
  // Most specific first: merged path emits a tagged preamble
  if (/<task>\s*You will perform 1-2 INDEPENDENT analytical tasks/i.test(p)) return "merged-prefetch";
  // Legacy 1-3 form (briefings era, removed 2026-05-02). Kept so historical
  // logs still classify correctly when token-check sweeps the past.
  if (/<task>\s*You will perform 1-3 INDEPENDENT analytical tasks/i.test(p)) return "merged-prefetch";
  if (/Extract \*\*real, user-facing scheduled events/i.test(p)) return "event-extract";
  if (/TASK: For each email line|push_summary|Inbox lines \(one per email\)/i.test(p)) return "email-digest";
  if (/^reply with exactly: ok$/i.test(p)) return "auth-probe";
  if (/AI草稿|生成回复|polish.*draft/i.test(p)) return "draft-gen";
  if (/search_emails|read_full_email/i.test(p)) return "ask-ai";
  if (/is_job|determine if.*job|career/i.test(p)) return "jobs-confirm";
  if (/primary.+track.+news.+junk/i.test(p)) return "llm-classify";
  return "unknown";
}

function priceFor(model: string): typeof SONNET_4_6 {
  if (model.includes("haiku")) return HAIKU_4_5;
  return SONNET_4_6; // sonnet/opus default
}

function cost(s: Stats, model: string): number {
  const p = priceFor(model);
  return (s.in / 1e6) * p.in + (s.cr / 1e6) * p.cr + (s.cc / 1e6) * p.cc + (s.out / 1e6) * p.out;
}

function reportSince(baseline: number) {
  const dirs = getCheckpointDirs();
  const existing = dirs.filter((d) => fs.existsSync(d));
  if (existing.length === 0) {
    console.error(`No project dirs found. Tried: ${dirs.join(", ")}`);
    process.exit(1);
  }
  const files: string[] = [];
  for (const dir of existing) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).mtime.getTime() / 1000 > baseline) files.push(full);
    }
  }

  const byCaller = new Map<string, Stats & { model: string }>();
  let totalCost = 0;
  let totalSpawns = 0;

  for (const f of files) {
    let prompt = "";
    let model = "?";
    const local = newStats();
    try {
      const lines = fs.readFileSync(f, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try { o = JSON.parse(line); } catch { continue; }
        if (!prompt && o.type === "user") {
          const msg = o.message as { content?: unknown } | undefined;
          const c = msg?.content;
          if (Array.isArray(c)) {
            for (const part of c as Array<Record<string, unknown>>) {
              if (part?.type === "text" && typeof part.text === "string") {
                prompt = part.text.slice(0, 400);
                break;
              }
            }
          } else if (typeof c === "string") prompt = c.slice(0, 400);
        }
        const msg = o.message as { model?: string; usage?: Record<string, number> } | undefined;
        if (msg?.model) model = msg.model;
        const u = msg?.usage;
        if (u) {
          local.in += u.input_tokens || 0;
          local.out += u.output_tokens || 0;
          local.cr += u.cache_read_input_tokens || 0;
          local.cc += u.cache_creation_input_tokens || 0;
        }
      }
    } catch {
      continue;
    }

    const caller = classifyPrompt(prompt);
    const key = `${caller}|${model}`;
    if (!byCaller.has(key)) byCaller.set(key, { ...newStats(), model });
    const agg = byCaller.get(key)!;
    agg.files++;
    agg.in += local.in;
    agg.out += local.out;
    agg.cr += local.cr;
    agg.cc += local.cc;
    totalSpawns++;
    totalCost += cost(local, model);
  }

  const since = new Date(baseline * 1000).toISOString();
  const dur = (Date.now() / 1000 - baseline) / 3600;
  console.log(`=== Token usage since ${since} (${dur.toFixed(1)}h) ===`);
  console.log(`Scanned: ${existing.join(", ")}`);
  console.log(`Total spawns: ${totalSpawns} | Total cost (API-equiv): $${totalCost.toFixed(2)}`);
  console.log();
  console.log(`${"caller|model".padEnd(50)} files     cost  cache_create  cache_read   output`);
  const rows = [...byCaller.entries()].sort((a, b) => cost(b[1], b[1].model) - cost(a[1], a[1].model));
  for (const [key, s] of rows) {
    const c = cost(s, s.model);
    console.log(
      `${key.padEnd(50)} ${String(s.files).padStart(5)}  $${c.toFixed(2).padStart(6)}  ${String(s.cc).padStart(12)}  ${String(s.cr).padStart(10)}  ${String(s.out).padStart(7)}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--mark")) {
    const ts = writeBaseline();
    console.log(`Token-check baseline planted: ${ts} (${new Date(ts * 1000).toISOString()})`);
    console.log(`EMAILDIGEST_DIR: ${EMAILDIGEST_DIR}`);
    return;
  }
  const baseline = readBaseline();
  if (baseline === null) {
    console.error("No baseline found. Run with --mark to plant one.");
    process.exit(1);
  }
  reportSince(baseline);
}

main();
