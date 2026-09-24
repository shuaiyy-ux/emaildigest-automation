/**
 * Validate RAG threshold — run 15 synthetic queries at cos thresholds {0.20...0.45},
 * report hit count + similarity distribution stats.
 *
 *   tsx scripts/validate-rag.ts
 *
 * Writes markdown report to scripts/validate-rag-output.md and prints summary to stdout.
 * Helps calibrate SIMILARITY_THRESHOLD in lib/ask/retrieve.ts.
 */
import { scorePool } from "../lib/ask/retrieve";
import * as fs from "fs";
import * as path from "path";

const QUERIES = [
  "本周有什么作业要交",
  "Professor Kim 最近发了什么",
  "Company A 面试什么时候",
  "哪些邮件还没回",
  "Company B 申请到哪一步了",
  "本月所有 track 类邮件的摘要",
  "有没有提到 Gradescope 的邮件",
  "下周日历事件",
  "最近未读的 primary",
  "验证码相关的邮件",
  "奖学金或资助类邮件",
  "教授发来的带附件的邮件",
  "帮我列出最近 deadline 按时间排序",
  "上个月这个公司给我发了几封",
  "有没有需要 RSVP 的邀请",
];

const THRESHOLDS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45];

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

(async () => {
  console.log("Validating RAG thresholds across", QUERIES.length, "queries...");
  const perQuery: Array<{
    query: string;
    pool_size: number;
    top50_stats: { mean: number; stddev: number; median: number; p10: number; p90: number; max: number };
    hits_at: Record<string, number>;
    top10: Array<{ sim: number; subject: string; from: string }>;
  }> = [];

  for (const q of QUERIES) {
    const { pool_size, scored } = await scorePool(q);
    const sims = scored.map((s) => s.sim);
    const top50 = sims.slice(0, 50);
    const hits_at: Record<string, number> = {};
    for (const t of THRESHOLDS) {
      hits_at[t.toFixed(2)] = sims.filter((s) => s >= t).length;
    }
    perQuery.push({
      query: q,
      pool_size,
      top50_stats: {
        mean: mean(top50),
        stddev: stddev(top50),
        median: pct(top50, 50),
        p10: pct(top50, 10),
        p90: pct(top50, 90),
        max: sims.length ? sims[0] : 0,
      },
      hits_at,
      top10: scored.slice(0, 10).map((s) => ({ sim: s.sim, subject: s.subject, from: s.from })),
    });
    const hitsStr = THRESHOLDS.map((t) => `${t}:${hits_at[t.toFixed(2)]}`).join(" ");
    console.log(`[${q.slice(0, 30).padEnd(30)}] pool=${pool_size}  max=${sims[0]?.toFixed(3) ?? "—"}  hits=${hitsStr}`);
  }

  // Aggregate stats
  console.log("\n=== Aggregate hit counts ===");
  for (const t of THRESHOLDS) {
    const counts = perQuery.map((q) => q.hits_at[t.toFixed(2)]);
    console.log(
      `threshold=${t.toFixed(2)}  median_hits=${pct(counts, 50)}  mean=${mean(counts).toFixed(1)}  max=${Math.max(...counts)}  min=${Math.min(...counts)}`
    );
  }

  // Pick recommended threshold: median hits 10-50 sweet spot
  const recommendation = THRESHOLDS.map((t) => {
    const counts = perQuery.map((q) => q.hits_at[t.toFixed(2)]);
    const m = pct(counts, 50);
    return { t, median_hits: m, mean_hits: mean(counts), count_over_100: counts.filter((c) => c > 100).length };
  });
  const picked = recommendation.find((r) => r.median_hits <= 50 && r.median_hits >= 5) ?? recommendation[3];
  console.log("\n=== Recommendation ===");
  console.log(`Threshold: ${picked.t}  (median_hits=${picked.median_hits}, mean=${picked.mean_hits.toFixed(1)})`);

  // Write markdown report
  const out: string[] = [];
  out.push(`# RAG Threshold Validation\n`);
  out.push(`Date: ${new Date().toISOString()}\n`);
  out.push(`Queries: ${QUERIES.length}, Thresholds: ${THRESHOLDS.join(", ")}\n\n`);

  out.push(`## Recommendation\n`);
  out.push(`Final threshold: **${picked.t}** (median hits ${picked.median_hits}, mean ${picked.mean_hits.toFixed(1)}).\n\n`);

  out.push(`## Per-query breakdown\n\n`);
  out.push(`| Query | Pool | Max sim | 0.20 | 0.25 | 0.30 | 0.35 | 0.40 | 0.45 | top-50 mean | stddev |\n`);
  out.push(`|---|---|---|---|---|---|---|---|---|---|---|\n`);
  for (const q of perQuery) {
    out.push(
      `| ${q.query} | ${q.pool_size} | ${q.top50_stats.max.toFixed(3)} | ${q.hits_at["0.20"]} | ${q.hits_at["0.25"]} | ${q.hits_at["0.30"]} | ${q.hits_at["0.35"]} | ${q.hits_at["0.40"]} | ${q.hits_at["0.45"]} | ${q.top50_stats.mean.toFixed(3)} | ${q.top50_stats.stddev.toFixed(3)} |\n`
    );
  }

  out.push(`\n## Top-10 spot check\n`);
  for (const q of perQuery) {
    out.push(`\n### ${q.query}\n`);
    for (const t of q.top10) {
      out.push(`- \`${t.sim.toFixed(3)}\` ${t.subject.slice(0, 80)} _(${t.from})_\n`);
    }
  }

  out.push(`\n## Aggregate\n\n`);
  out.push(`| Threshold | median hits | mean hits | max hits | queries over 100 |\n`);
  out.push(`|---|---|---|---|---|\n`);
  for (const r of recommendation) {
    out.push(`| ${r.t.toFixed(2)} | ${r.median_hits} | ${r.mean_hits.toFixed(1)} | — | ${r.count_over_100} |\n`);
  }

  const outPath = path.join(__dirname, "validate-rag-output.md");
  fs.writeFileSync(outPath, out.join(""));
  console.log(`\nReport written to ${outPath}`);

  // Suggest updating SIMILARITY_THRESHOLD
  const retrievePath = path.join(__dirname, "..", "lib", "ask", "retrieve.ts");
  const current = fs.readFileSync(retrievePath, "utf-8").match(/SIMILARITY_THRESHOLD = ([\d.]+)/)?.[1];
  if (current && parseFloat(current) !== picked.t) {
    console.log(`\nNOTE: lib/ask/retrieve.ts currently has SIMILARITY_THRESHOLD = ${current}.`);
    console.log(`      Consider updating to ${picked.t} based on this validation.`);
  }

  process.exit(0);
})().catch((e) => {
  console.error("validate-rag failed:", e);
  process.exit(1);
});
