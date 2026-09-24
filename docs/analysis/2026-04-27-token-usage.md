# PROD Token Usage — 4-25/26 Optimization Effectiveness

> **2026-05-02 update**：Briefings was retired entirely. Daily-digest renamed to email-digest with 2h stale-check. Numbers below are historical — see token-check.ts for current. MiniLM threshold also retuned 0.65/0.10 → 0.55/0.05.

**Date**: 2026-04-27
**Source**: Claude CLI session logs (`~/.claude/projects/<project-dir>/*.jsonl`) on the production server (PROD)
**Question**: 最近两天的 LLM 优化（4e02060 event-extractor regex gate、08ff35f briefing thread-dedup）有没有 effective？

## Per-day call breakdown (UTC)

| 日期 (UTC) | 总 calls | event-extractor | briefing | jobs-pipeline | auth probe | tokens (sum) |
|---|---|---|---|---|---|---|
| 04-22 (baseline) | 464 | 350 | 35 | 0 | 49 | **69.5 M** |
| 04-23 ⚠ | 1213 | 960 | 96 | 3 | 49 | 42.5 M |
| 04-24 (4e02060 deployed mid-day @ 20:34 UTC) | 325 | 229 | 22 | 0 | 49 | 54.5 M |
| **04-25** (first full day post-fix) | **155** | **86** | **9** | **2** | **48** | **28.3 M** |
| **04-26** (second full day) | **131** | **67** | **8** | **0** | **48** | **22.4 M** |
| 04-27 (~6.8h, partial) | 129 | 89 | 12 | 3 | 15 | — |

> 04-23 是 anomaly：当天没有对应 commit，960 个 event-extractor 调用是其它日子的 ~3 倍。原因不明（可能手动 backfill / IDLE 异常 / 某次邮件批次冲入）。不纳入对比 baseline，用 04-22 当 baseline 更稳。

## 主要结论

### 1. event-extractor regex gate (commit 4e02060) — **效果优于宣传**

- 调用：350/日 → 67-86/日，**−76% 到 −81%**
- commit message 当时估的是 ~49%。实际超出预期。
- 原因猜测：本地 `/api/events action=scanInbox` 测试样本里时间表达式占比偏高（约半数），PROD 真实邮件流里大量 marketing / newsletter / notification 没有日期 pattern，被 `hasTimeSignal()` 直接挡掉。

### 2. 总 token 消耗

- 69.5 M/日 → 22-28 M/日，**−60% 到 −68%**
- 总 calls：464/日 → 131-155/日，**−67% 到 −72%**

### 3. briefing 调用 35 → 8-9 — **不**全归功于今天的 thread-dedup

- briefing thread-dedup（08ff35f）部署在 04-27 06:42 UTC（今天早上），**早于** 04-25/26 这两天的 briefing drop。
- 更可能解释：
  - 周末（04-25 Sat、04-26 Sun）邮件量低 → 类别 hash 变化少 → cache 命中多。
  - 不是 thread-dedup 的功劳。
- 今天的 thread-dedup 独立效果需要 1-2 个工作日（04-28 周一开始）才能观察到。

### 4. auth 探针稳定 ~48-49/日

- 30 min × 24h = 48 次/日，符合 instrumentation 设计的心跳频率。
- 不进 LLM 业务逻辑，但占总 calls 的 32%（在低活跃日）— 是固定底盘成本。

## Action items

- 暂不动。两天连续观察足以确认 4e02060 有效。
- 04-28 起观察 briefing 工作日 baseline，验证 08ff35f 独立效果。
- 04-23 的 960 event-extractor 异常可以以后查 `app.log` 确认起因。

---

# 附：为什么最近的几个申请都没有自动 categorize 成 Jobs（同日排查）

**结论：不是 classifier 的问题。是 `maybe_work` flag 在 Step 2a 之后从不重算的 stale-flag bug。**

## PROD 现状

| 指标 | 值 |
|---|---|
| `work_classifier_weights` 最近训练 | **2026-04-27 06:41:47**（今天） |
| `work_labels` 总条数 | 67（57 neg llm_bootstrap + 1 neg user + 2 pos llm_bootstrap + **7 pos user_correction**） |
| `job_emails` 行数 | 9 |
| `applications` 行数 | 6 |
| `emails.maybe_work=1` 总数 | 10 |

PROD weights 训练完成时间正好对上今天上午的 prefetch run（用户的 user_correction warm-start retrain 触发）。

## 把今天 retrained weights 跑在 11 封最近的 job-keyword 邮件上（PROD 现场实测）

```
flag_now  P_now    DB.maybe_work  subject
  YES    P=0.971  [0]   ← 错       EEO survey for Analyst Intern - Summer 2026
  YES    P=0.972  [1] ✓            Thanks for applying to Company B
  YES    P=0.810  [0]   ← 错       2026-2027 Internships & Fellowships Recruiting
  YES    P=0.952  [1] ✓            ✅ You applied to Company C
  YES    P=0.984  [1] ✓            Thank you for applying to Company D
  YES    P=0.752  [0]   ← 错       UC Irvine - Campus office is hiring Student Assistant
  YES    P=0.933  [0]   ← 错       Data Analyst Role at Company E - apply by 4/29
  YES    P=0.791  [0]   ← 错       🎒 Agency Internship Opportunities: Graduate Students
  YES    P=0.994  [1] ✓            Thank you for applying to Company F
  YES    P=0.744  [0]   ← 错       Confirmed: You've been selected to apply at Company G
  YES    P=0.932  [0]   ← 错       Company H is hiring Digital Marketing Intern and more
```

**11 封中 11 封 classifier 现在都判 ≥ 0.5（P 从 0.744 到 0.994，都很 confident）。但 DB 里只有 4 封 maybe_work=1。** 7 封该上 Jobs 的留在 `maybe_work=0`。

## Root cause

`web/lib/prefetch.ts:148-221` 的 Step 2a 只对 `category_id IS NULL` 的新邮件计算 maybe_work。一旦邮件被 classify（拿到 `category_id`），**永远不会再回头重算 maybe_work**。

这 7 封"漏掉"的邮件都是在今天 retrain (06:41) **之前** classify 的：
- 早期 PROD weights 训练样本只有 2 个正类（都来自 Company A），泛化能力弱，对 Company E/H/G 这类非 Company A 的 job 邮件 predict <0.5
- setMaybeWork(false) 写进 DB
- 之后用户右键 "Classify as Job related" 7 次，给正类喂了 7 条新样本
- warm-start retrain 把模型显著拔高（现在 P=0.93-0.99）
- **但旧邮件的 maybe_work=0 不会跟着 retrain 变化** — 没有任何代码路径回头重算它们

## 用户视角的现象

每次"Classify as Job related"右键操作只对**那一封**邮件起作用（直接写 maybe_work=1 + 跑 forceClassifySingleEmail）。模型变好了，但同期同类的其它邮件不沾光。所以用户感受是"系统就是没在自动抓 job"。

## 两类潜在 fix（仅记录，未动 PROD）

1. **训练后 backfill**：`trainWorkClassifier({warmStart:true})` 完成后，对 `maybe_work=0 AND embedding IS NOT NULL` 的非-junk 邮件重跑 predict，更新 maybe_work。一次性追上 retrain 的 gain。
2. **按需重算入口**：加一个 `/jobs` 看板的"Rescan inbox" 按钮，调 `recomputeMaybeWorkAll()`。比 1 更显式，避免每次 user_correction 都触发 N 行 update。

## Local（开发机）vs PROD 差异

local data.db 的 work_classifier_weights 还是 04-23 15:01 那次训练的（4 pos + 58 neg），predict 偏弱（11 封中 7/11 ≥ 0.5）。PROD 已经 04-27 retrain 过（9 pos + 58 neg），predict 强很多（11/11 ≥ 0.5）。但 local 和 PROD 都呈现同一个 stale-flag 现象 — 不是数据库或环境差异，是代码逻辑 gap。

*生成命令*：
```bash
ssh prod 'cd ~/.claude/projects/<project-dir> && \
  for d in 22 23 24 25 26; do
    files=$(ls -l *.jsonl 2>/dev/null | grep "Apr $d " | awk "{print \$NF}")
    # ... classify by first prompt content (events/jobs/briefing/auth/other)
  done'
```
