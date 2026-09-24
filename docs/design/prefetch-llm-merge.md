# Prefetch LLM 二合一合并

> **2026-05-02 update**：briefings 任务已退役（spawn floor 问题）。本文档描述的"3 task merge"（classify + jobs + briefings）现在简化为 **2 task merge**（classify + jobs）。其他设计原理（cwd=tmpdir / `--system-prompt` 全替换 / best-effort parse）保持不变，仍是 merged-prefetch 的指导思想。

## 背景

PROD 每天产生 ~150-300 个 Anthropic thread，绝大部分是后台 prefetch pipeline 触发的：

| Step | 现状 spawn | 模型 | 作用 |
|---|---|---|---|
| 2b | 1 / cycle | Sonnet | 对 MiniLM 不自信的邮件做精细分类 |
| 3  | 1+ / cycle | Sonnet | maybe_work 邮件 LLM 确认 is_job + 字段抽取 |
| 4  | 1 / cycle | Sonnet | 按类别刷新 Dashboard briefing 摘要 |
| 5  | N / cycle | Haiku | 日历事件抽取（已 env 关停）|

后 4 步独立 spawn → 每个 prefetch cycle 最多 3 个 Sonnet thread。

## 决策路径

记录我们考虑过的方案 + 为什么否决，避免后人重新走一遍。

### 方案一：跨 spawn 共享 sid（`--resume`）

让多次同类调用挂同一个 Claude CLI session_id，Anthropic 端只看到一个 thread。

**否决原因**：
- Claude CLI 的 `--resume` 把整个 jsonl 历史回放成 messages 数组重发
- 我们的后台 task 是 **stateless single-shot**：classify / jobs / briefing 每次都是独立批次，前后没有语义延续
- 共享 sid 后每次 spawn 多花 cache_read 回放无用历史，**单次 input token 反而 ~3x**
- 调用频度（1-3h 间隔 vs 5min cache TTL）让 prompt cache 必冷，无法回收
- "省 thread 数"是 cosmetic 收益（Anthropic 不按 thread 计费、不按 thread 限流）

### 方案二：时间 debounce（突发邮件合批）

新邮件触发 prefetch 后等 5 min 让更多邮件累积，再一次性跑 classify。

**搁置原因**：
- 优点：节省突发期 spawn 数；保守估计省 2-4 thread/天
- 缺点：UI 上新邮件分类延迟最多 5 min（默认 "notification" 桶 5 min 后才正确归类）
- 工程量：~2h
- ROI 一般，作为后续选项保留

### 方案三：三任务合并 prompt（**采纳**）

prefetch cycle 内 classify + jobs + briefing 同源（都"新邮件 → Sonnet → JSON 输出 → readonly"），合并到一个 spawn 一次输出。

**采纳原因**（实测数据见下）：
- 单 cycle spawn 数 3 → 1
- 单 cycle 总 latency -23%
- 单 cycle 总 cost -44%
- 输出质量未退化（5/5 classify 一致，5/5 jobs 一致，briefing 实际更精确）
- JSON parse 100% 成功（无 MCP 也稳）

## 实测对照

5 封真实邮件 / 同模型（Sonnet）/ `--system-prompt` 全替换：

| Metric | A: 3 spawn | B: merged | Δ |
|---|---:|---:|---:|
| 总 latency | 46.9s | 36.3s | **-23%** |
| Spawn 数 | 3 | 1 | **-67%** |
| Cache create | 23,033 | 8,429 | **-63%** |
| Cache read | 19,032 | 9,516 | **-50%** |
| Cost (USD) | 0.1199 | 0.0677 | **-44%** |

输出对比：
- classifications: 5/5 一致
- jobs: 5/5 一致（全部 is_job=false 正确）
- briefings: A 返回 3 keys，B 返回 4 keys —— B 用刚算出来的新分类做 grouping，比 A 用 DB 旧 category 更精确

测试脚本：`/tmp/merge-test.py`（独立 Python，不引入项目依赖）；输出快照：`/tmp/test-output.json`。

## 实施约束（hedge 已知风险）

1. **必须 `--system-prompt` 全替换**，不能 `--append-system-prompt` —— 后者会在 Claude Code 默认 system prompt（几千 token "coding assistant"）后面追加，冲淡 JSON schema 要求。daily-digest 已经踩过这个坑，参考 `daily-digest.ts:282` 注释
2. **Best-effort parse**：root JSON 解析失败 → 整次失败重试；但 root 解析成功后，每个 key（classifications / jobs / briefings）独立判 `Array.isArray` / `typeof === 'object'`，存在就写，缺失 noop —— 下次 prefetch 自然重试（needsLLM / maybe_work / stale 条件还在）
3. **写库前 validate**：每个 record 检查必需字段（`id` / `category` 在白名单 / `is_job` 是 bool 等），坏数据丢弃不写表
4. **Token budget fallback**：merged prompt > 100K 字符（约 25K tokens user prompt）→ 退回三 spawn 路径（保留原 `classifyEmailsWithLLM` / `drainMaybeWorkQueue` / `refreshStaleBriefings` 不删）
5. **保留独立函数**：merged 路径只用于 prefetch 内部 fast path；以下 caller 仍走独立路径：
   - `forceClassifyAsJob`（用户右键 → 不等 batch，立即跑）
   - `/api/emails action=briefing` 的 lazy fallback（merged 没跑或漏了某 cat）
   - `/api/emails action=reclassify`（用户对指定邮件强制重分类）

## 不合并的对象

| Task | 为什么不并 |
|---|---|
| daily-digest | 不同 cadence（PT 9/15/21 fixed slot），不同输入数据范围（48h 窗），不在 prefetch 链路 |
| event-extract | Haiku 模型，prompt 是 pure JSON 抽取，不能跟 Sonnet 任务混 |
| draft-gen / push-to-gmail | 用户驱动，每次草稿是独立 user intent，跨草稿继承上下文是 bug |
| Ask AI | 已用 `--resume` 持久化用户会话，是真正的 conversational task |

## 何时升级到 MCP

当前用 `--system-prompt` + 严格 JSON schema 提示已经 100% parse 成功。以下任一发生时升级到 MCP write-tool（schema 强约束）：
- 连续 3 次 prefetch cycle 出现 partial parse 失败（缺字段或类型错）
- 升级 Sonnet 后输出格式漂移
- 引入第 4 个合并 task

MCP 设计：在 `mcp-server/server.ts` 加 3 个 write-tool：
- `submit_classifications(items)`：参数 schema = `[{id, category in [primary,track,news,junk], primary_until?}]`
- `submit_jobs(items)`：参数 schema = jobs is_job + 字段
- `submit_briefings(map)`：参数 schema = `{[cat]: string}`

模型必须调用 tool 才能"输出"，schema 不匹配在 MCP 层面被拒，模型自然 retry。无需自家 parser。

## 实施顺序

1. ✅ 写决策文档（本文件）
2. 新建 `web/lib/merged-prefetch-llm.ts`：build prompt + spawn + parse
3. 改 `web/lib/prefetch.ts` 的 Step 2b/3/4：先收集 3 类输入 → 一次 merged spawn → 把 3 段结果分发给原有的 DB 写入逻辑
4. 保留 `classifyEmailsWithLLM` / `drainMaybeWorkQueue` / `refreshStaleBriefings` 作为非 prefetch 路径的 caller 入口
5. 本地手动验证一次 prefetch
6. 部署 PROD 后跑 24h，对比合并前后的 token-check 数据
