# 邮件获取与分类管线

## 概述

EmailDigest 的邮件获取是 **多步管线**（`prefetch.ts`）：**IMAP 拉取 → Embedding 自愈 → Chunking → Inbox 分类（SetFit + LLM）→ Jobs pipeline（LLM + 4 层归属）**。由 `startPrefetch()` 驱动，有防重入锁（`fetching` 布尔），所有 step 在 `try/finally` 中确保锁总能释放。日历事件抽取改为手动按钮触发（详见 [Calendar 事件抽取](#calendar-事件抽取-event-extractorts--time-signalts) 小节），dashboard briefing 已退役（2026-05-02）。

| Step | 作用 |
|---|---|
| 1 | IMAP 拉头+正文，upsert emails 表 |
| 1.5 | **自愈**：扫 `embedding IS NULL AND body != ''` 的已分类邮件，补算通用 MiniLM 向量（Ask AI RAG 用，不改分类）|
| 1.6 | **Chunking**：切 body 成 ~400 字 chunks，每块 embed 入 `email_chunks`（Ask AI RAG 专用，Inbox 分类器不用）|
| 2 | Inbox 分类 — 2a SetFit 4-way + maybe_work 标；2b SetFit 不自信送 LLM，回灌 category_examples |
| 3 | Jobs pipeline — drain maybe_work 队列，LLM 确认 is_job + 4 层 application 归属 |
> **Briefings 已从 prefetch 移除（2026-05-02）**。原本 Step 4 是按 category 刷新 stale 摘要，但 stale-trigger（任一新邮件 → 该 category 摘要 stale）让 merged-prefetch 几乎每个 IMAP IDLE 都 fire spawn，是 spawn 数主要来源。UX 已合并到 dashboard 顶部的统一 email-digest（每 2h 刷新 with stale-check）。|

> **日历事件抽取已从 prefetch 移除（2026-05-01）**。现在仅在用户点击 `/calendar` 页 **Scan inbox** 按钮时触发，单 Haiku spawn 批量处理所有 SQL+regex 候选邮件（详 [Calendar 事件抽取](#calendar-事件抽取-event-extractorts--time-signalts)小节）。原因：每次 IMAP IDLE / 60s refresh 自动跑 per-email spawn 是 2026-04 Anthropic 封号事件后日均 spawn 数的主要来源。|

**两个独立分类子系统，各有任务专属向量**
- **Inbox**（主页显示）：**SetFit 任务专属 4-way 分类器**（`classify-embedder.ts` + `setfit-classify-head.ts`，2026-05-07 ship）→ top1 ≥ 0.80 即写库，跳过 LLM；不自信直接落 Step 2b LLM。SetFit 通过 ~95% 信心门。**通用 MiniLM 质心 fallback 已于 2026-05-08 退役**（lessons-learned §23）
- **Jobs**（/jobs 看板）：**SetFit 任务专属 binary 分类器**（`work-embedder.ts` + `setfit-head.ts`，2026-05-04 ship）→ LLM 确认 → applications 追踪。Fallback：`work-classifier.ts`（旧 raw-MiniLM LR，模型文件丢失时启用）→ `work-seed.ts`（cosine 阈值，最末端兜底）
- 三个 embedding 列正交：`emails.embedding`（通用 MiniLM，仅 Ask AI RAG 用）/ `emails.classify_embedding`（Inbox SetFit 专属）/ `emails.work_embedding`（Jobs SetFit 专属）。各路径只读自己那列。详见 [database.md](database.md)。

**两种入口**：

| 函数 | 参数 | 用途 |
|------|------|------|
| `startPrefetch({ days, max })` | 默认 `days=30, max=200` | 常规增量拉取（IDLE 触发、手动 refresh、服务器启动） |
| `startBackfill()` | 硬编码 `days=365, max=2000` | 首次启动（DB 为空）或用户显式"全量扫历史"。重新 upsert 触发对历史行重跑 `unwrapForwarded`，修正旧 MCP 抓取时误归属的发件人 |

**防重入**：`fetching` 布尔 + `isPrefetching()` 对外暴露给 API。重复调用静默 return。

**架构决策 — 为什么用 IMAP 而不是 Gmail MCP**：早期走 Claude CLI subprocess + Gmail MCP，每次 prefetch spawn 子进程 + LLM 往返，Step 1+4 合计 ~100–150s 且烧 tokens。切到 `imapflow` 直连 `imap.gmail.com:993` 后，Step 1 降到 ~3–5s，Step 4 消失（正文随元数据一起拿），零 LLM 成本。鉴权用 App Password（`GMAIL_APP_PASSWORD` env）。

## Step 1: IMAP 拉取（lib/imap.ts）

### `fetchRecent({ label, days, max })`

默认 `label="UCI-Mail", days=30, max=200`。流程：

1. `new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth })` 建 TLS 连接
2. `client.mailboxOpen(label, { readOnly: true })` — Gmail 把每个 label 暴露为独立 IMAP folder，直接打开（避免 locale 差异；中文账号的"所有邮件"名字不一样）
3. `client.search({ since: now - days·86400s }, { uid: true })` → UID 升序列表
4. `uids.slice(-max)` 取末尾 N 个（最新的）
5. `client.fetch(uids, { uid, source, envelope, flags, emailId, threadId, internalDate }, { uid: true })` 遍历
6. 对每封 `simpleParser(msg.source)` 解 MIME → text / html / from / subject / date
7. `unwrapForwarded(...)` 拆解 UCI Outlook 自动转发 wrapper（**见下**）
8. `out.push(...)`；finally 中 `client.logout()`；最终按 `receivedAt` 倒序

### unwrapForwarded — 关键但不直观

UCI Outlook 自动转发规则会把原始邮件包在一个 wrapper 里：From 头改成转发人（`owner@example.edu`），原始发件人藏在 body 中：

```
________________________________
From: Original Sender <original@x.com>
Sent: Thursday, April 16, 2026 4:43:48 PM ...
To: Shuaiyu <owner@example.edu>
Subject: The real subject

<actual body>
```

`unwrapForwarded(body, fromName, fromEmail, subject)` 做：

1. 找 `^_{10,}$` 分隔线
2. 分隔线后最多 25 行内找 `From:` 行；解析 `"X <x@y>"` 格式，去掉 `on behalf of` 后缀
3. 只有既有 `From:` 又有 `Subject:` 时才触发替换（否则原样返回）
4. 丢掉从分隔线到 `Subject:` 后第一个空行的整块，拼接剩余内容
5. 返回 `{body: 新正文, from: 原始名, fromEmail: 原始邮箱, subject: 去掉 Fwd: 的原主题}`

没有这个函数，所有邮件发件人都会是 `owner@example.edu`，分类彻底失效。

### 返回 `ImapEmail[]`

| 字段 | 说明 |
|------|------|
| `id` | `BigInt(emailId).toString(16)` — 16 进制 X-GM-MSGID，与 Gmail REST API 的 messageId 一致 |
| `threadId` | `BigInt(threadId).toString(16)` |
| `from` | 发件人显示名（经 unwrapForwarded 还原） |
| `fromEmail` | 发件人邮箱（经 unwrapForwarded 还原） |
| `subject` | 主题（去掉 `FW:/Fwd:/Fw:` 前缀） |
| `snippet` | `body.slice(0, 50).replace(/\s+/g," ").trim()` |
| `body` | `parsed.text` — 拆解后的纯文本（经 unwrapForwarded），用于 LLM prompt / 引用回复 / 预览 |
| `bodyHtml` | `parsed.html` — HTML MIME part 原样，用于 UI `react-letter` 渲染；邮件只有 text/plain 时为 `''` |
| `date` | `formatPacificDate(d)` — 同日 `HH:mm`，异日 `M/D` |
| `receivedAt` | `Math.floor(date.getTime() / 1000)` |
| `isUnread` | `!flags.has("\\Seen")` |

### 入库

`upsertEmails(emails[])` INSERT OR REPLACE，事务批量。冲突策略（见 db.ts）：
- `from_email` / `body` / `body_html` 新值为空则保留旧值（三字段独立判断）
- `received_at` 新值为 0 则保留旧值
- `category` **仅在 `classifier != 'user'` 时覆盖**（保护用户手动纠正）
- 其他字段总是覆盖
- `thread_id` 通过 `updateEmailThreadId(id, threadId)` 单独写入，不走 upsertEmails

所有新邮件初始 `category="notification"`（legacy 默认值），`category_id=NULL`（等 Step 2 写入）。

## 实时推送：IMAP IDLE（lib/imap.ts）

`instrumentation.ts` 启动时调 `startIdleListener(() => startPrefetch())`：

1. 独立长连接 `ImapFlow` 实例，mailboxOpen `UCI-Mail`，监听 `exists` 事件
2. Gmail 新邮件 → IDLE 推送 → `data.count > data.prevCount` → 触发 `startPrefetch()`（防重入锁自动去重）
3. 连接断开（空闲超时、网络波动）→ 5s 后自动重连（`while (!idleStopRequested)` loop）
4. `stopIdleListener()` 用于进程退出时清理

前端配合：`mail.tsx` 每 60s 调 `POST /api/emails action=refresh` + `GET /api/emails`，让 IDLE 推进来的新邮件在 UI 上 1 分钟内可见。无需手动刷新。

## Step 1.5: Embedding 自愈

Step 2a 的分类只触及 `category_id IS NULL` 的邮件——已分类的邮件不会复跑 MiniLM。当 `emails.embedding` 因模型版本切换、迁移、DB 恢复而被置 NULL 时，这些已分类邮件就永远失去向量，**Ask AI 的 `search_emails` 会看不到它们**。

Step 1.5 每次 prefetch 都无条件扫一次：

```sql
SELECT id, from_name, from_email, subject, snippet FROM emails
 WHERE embedding IS NULL AND body != ''
 ORDER BY received_at DESC LIMIT 50
```

对每条跑 `embedText(buildEmbedText(...))` + `updateEmailEmbedding`，**只写 embedding，不触碰分类、TTL、job 等任何其他字段**。上限 50/run 防止单次 IDLE 唤醒卡太久，下一轮 prefetch 会继续补余下的。

触发场景：
- `instrumentation.ts` 检测 `app_state.embed_model` 与当前 `MODEL_ID` 不一致 → 一次性 `UPDATE emails SET embedding = NULL` → 下几次 prefetch 逐步回填
- 用户手动把 data.db 从别处拷来（embedder 版本不同）
- 未来加新 embedding 字段时迁移路径

## Step 1.6: Chunking（lib/chunker.ts）

Ask AI RAG 需要 chunk-level embedding 才能在长邮件中段命中关键句。Step 1.6 每次 prefetch 扫 `listEmailsNeedingChunks(limit)` —— body 非空但 `email_chunks` 为空的邮件 —— 跑 `chunkEmailBody()` 切成 ~400 字块，每块独立 `embedText` 后 `replaceChunksForEmail()`。

切分策略（`lib/chunker.ts`）：段落→句子贪婪装箱，目标 400 字，上限 500，最多 6 块/邮件，URL 剥离，boilerplate 预清洗。与 `emails.embedding`（Inbox 分类器的整邮件向量）互不干扰。

全量 backfill 脚本：`web/scripts/backfill-chunks.ts`。详见 [ask-rag.md](ask-rag.md)。

## Step 2a: Inbox 分类（SetFit 4-way → LLM 两层）

**两层架构（2026-05-08 起）**：SetFit 任务专属 4-way 分类器自信即写库；不自信直接落 Step 2b LLM。SetFit 模型文件不在位（fresh deploy before scp）时整批落 LLM——**不再退化到 generic-MiniLM 质心 fallback**（lessons-learned §23）。

| 层 | 文件 | 通过率 | 通过条件 |
|---|---|---|---|
| 1. **SetFit 4-way** | `classify-embedder.ts` + `setfit-classify-head.ts` | ~85-95% | top1 ≥ 0.80（softmax） |
| 2. **LLM (Step 2b)** | `llm-classify.ts` | 全部剩余 | — |

**SetFit 4-way 分类器**：SetFit fine-tuned MiniLM body（contrastive learning on `category_examples`）+ 4-class LR head。86 MB ONNX 在 `web/models/setfit-classify/onnx/`（gitignored，PROD 走 scp）；head 优先读 `app_state.setfit_classify_head_runtime`（user 纠错 warm-start 写），否则读 `web/models/setfit-classify/head.json`。Held-out eval 97.1% / smoke test 85% confident pass。详见 `docs/changelog/2026-05-04-setfit-4way-classify.md`。

**Warm-start 训练数据可见性约束**：TS warm-start 通过 `getLabeledClassifySamples` 读样本，SQL JOIN `emails.classify_embedding` —— 该列在 SetFit ship（2026-05-07）后才加入 schema，ship 前已分类的邮件该列 NULL。这些样本在 warm-start 路径**不可见**，但在 Python 离线训练（`training/setfit-classify/train.py` 当场计算 embedding）路径**可见**。两条路径不等价是 §24 退化事故的根因。修复：`lib/embed-backfill.ts ensureClassifyEmbeddingsBackfilled()` 在 instrumentation 启动时 fire-and-forget 扫 orphan 补缓存；`trainSetfitClassifyHead` 入口加 coverage invariant check（覆盖率 < 70% 打 warn 日志）。详见 `docs/lessons-learned.md §24`。

**为什么需要 SetFit**：通用 MiniLM 在 4-way 任务上 cluster overlap 严重（cat_track 和 cat_news 的 cosine 都在 0.6-0.7 区间，centroid 互相涂抹），margin 0.05 阈值就拦下大部分邮件。SetFit 的 contrastive 训练把同类 cosine 拉到 0.9+、异类拉到 0.5 以下，使 top1 ≥ 0.80 成为可达门。详见 `docs/lessons-learned.md` §22。

**为什么删 centroid fallback**：理论上多一层兜底无害；实际上它与"主路径走 SetFit"的承诺不一致，让 reclassify 等 API 入口可以"跳过 SetFit 直接吃 centroid 命中"——SetFit ship 一周内就出现 195 封邮件全程绕过 SetFit 的事故（lessons-learned §23）。统一为 SetFit→LLM 两层后，任何旁路都会立即转化为 LLM token spend，能在 metrics 里看见，不会沉默退化。

### 流程（prefetch.ts Step 2a）

1. `SELECT ... WHERE category_id IS NULL AND classifier NOT IN ('user','llm')` 取待分类邮件（一次最多 40 条，保 LLM prompt 紧凑）
2. **L1.5 thread 短路预加载**：`listJobThreadIds()` 一次性拿到所有已在 `job_emails` 里的 `thread_id` Set。本 batch 所有邮件共用。
3. 对每封邮件，**三个 embedding 串行计算 + 各自缓存**：
   - 通用 MiniLM `vec`（仅 Ask AI RAG 用）→ `updateEmailEmbedding`
   - SetFit work `workEmb`（用于 Jobs is_work gate）→ `updateWorkEmbedding`，`setMaybeWork(id, inJobThread || workFlag)`
   - SetFit classify `cEmb`（用于 Inbox 4-way）→ `updateClassifyEmbedding`
4. 分类决策（两层）：
   - **SetFit 4-way**：`predictClassifyFromEmbedding(cEmb)` → `top1 ≥ 0.80` 即写库 with `classifier='setfit'`
   - 否则 → 入 `llmQueue` 等 Step 2b 处理
5. 任一层写库都跑一遍 `inferPrimaryUntil()` 决定 TTL 升级

### L1.5 thread 短路的来龙去脉

**问题**：work-classifier 是 logistic regression on MiniLM embedding，当训练集正样本偏少时（例：2 个 llm_bootstrap 正 vs 57 个负），对 reject / follow-up 这类同线程续封常 predict < 0.5，`maybe_work=0`。一旦落 0，该邮件不会进 Step 3 队列，`resolveApplication` 的 Layer A (thread 匹配) 永远没机会执行——前门拦死，后门的硬信号用不上。

**短路**：在 work-classifier 之前加一道 thread 级硬规则：若 `emails.thread_id` 已出现在任何 `job_emails` 行里，直接 `maybe_work=1`。绕过 ML gate。

**为什么安全**：Gmail `thread_id` 来自 X-GM-THRID，是服务端基于 In-Reply-To / References 头计算的确定值，不是 ML 判的；同 thread 的邮件 99%+ 是真续封（极少有 thread-hijack 攻击）。Layer A 在 Step 3 里已经依赖这个等式，这里只是把它提前到 gate 层。

**不覆盖历史邮件**：短路只对 `pending`（`category_id IS NULL`）生效，已分类过的邮件不回头扫。历史漏判需要用户右键 "Classify as Job related"。

### SetFit head 升级判定

| 条件 | 字段 |
|------|------|
| `top1 < 0.80`（softmax 信心不足） | 落 `llmQueue` → Step 2b LLM |

阈值由 `classify-embedder.ts:CLASSIFY_PREDICT_THRESHOLD` 单点定义，held-out eval 100% pass rate / 2.9% error。

## Step 2b: LLM 精细分类 + 回灌训练样本

对 SetFit 不自信的邮件批量送 LLM（`classifyEmailsWithLLM`），`EMAILDIGEST_READONLY=1` 模式，无 `gmail_create_draft` 权限。

**LLM self-rate confidence**（2026-05-14 起）：JSON schema 多一个 `"confidence": "high" | "medium" | "low"` 字段，LLM 自评判断难度。`mapLLMConfidence(raw)`（`web/lib/llm-classify.ts`）单点映射到三元组：

| Tier | emails.confidence (numeric) | category_examples.source | trainable | 用途 |
|---|---|---|---|---|
| high | 0.9 | `llm_high_conf` (weight 25) | ✓ | 教科书级样本；与原硬编码 0.9 等价 |
| medium | **0.55** | `llm_med_conf` (weight 5) | ✓ | 类别合理但至少一信号模糊；**落入 needsUserConfirm 0.4-0.7 区间 → UI 显示 active learning 横幅** |
| low | 0.3 | — | ✗（跳过 addCategoryExample） | LLM 自承猜测；写入路由但不进训练池，避免把猜测当 label |

默认 fallback：LLM 漏字段 / 拼写错 / 输出非预期值 → 视为 `medium`（保守 — 触发用户审查而非把不确定洗成高信）。

**为什么是 tier 而不是浮点**：让 LLM 输出 0.7 这种数值不可校准（LLM 的 0.7 跟 SetFit 的 0.7 含义不同），三档语义清晰、容易自评。

**回灌逻辑**（`prefetch.ts` Step 2b）：`conf.trainable=true` 时把邮件 embedding 写入 `category_examples`，source 取自 tier 映射——下一次 SetFit head warm-start retrain 直接读这个表 + cached `classify_embedding` 做训练。

- 用户纠正权重 50 仍是 `llm_high_conf=25` 的 2× / `llm_med_conf=5` 的 10×，错误 LLM 标注一次纠正即可盖过
- 25 是 2026-05-08 从 10 上调（PROD user_correction 长期只 2 条 vs 167 llm_high_conf，旧比例让 head 在用户纠错之间几乎不学到新东西）
- 历史 row 仍是 `confidence=0.9 + source=llm_high_conf`（不回填，只对新分类生效）；新数据随时间稀释旧数据的偏置

> 旧版本（≤ 2026-05-13）硬编码 `confidence=0.9` + 所有样本都标 `llm_high_conf`，等于把 LLM 的 10% error rate 当作高信样本喂给 head。详 `docs/lessons-learned.md §25`。

## Primary TTL 规则（ttl-rules.ts）

某些非 Primary 邮件（如验证码、今日截止的作业、包裹待取）应**临时**显示在 Priority 视图。`inferPrimaryUntil(ctx)` 纯函数按优先级匹配，返回 epoch sec 或 null：

| 优先级 | 触发 | TTL |
|-------|------|-----|
| 1a | 严格 auth code（`VERIFY_STRICT_RE`：verification / verify / one-time code / authentication code / 2FA / OTP / passcode 附近 4-8 位数字） | anchor + 30 分钟 |
| 2 | 主题或正文含 `SAME_DAY_RE`（expires today / last chance / final reminder / due today / by EOD / ASAP） | 今天 23:59 本地时间 |
| 3 | 文本含 `DEADLINE_RE`（due / deadline / expires / submit by / RSVP by / apply by 后跟 weekday / tomorrow / "Oct 15" / "10/15" 等日期短语） | 解析后的 end-of-day |
| 1b | 快递/账单（`PICKUP_BILL_RE`：pick-up / package / parcel / locker / delivery / shipment / tracking / bill / invoice / statement / payment due / balance due / overdue）且前三条都没中 | anchor + 24 小时 |
| — | 否则 | null（留在 home category，不升级） |

**优先级为什么是 1a > 2 > 3 > 1b**：1a（真实 OTP）永远 30 分钟；1b 是兜底默认窗口，必须让 2（"今天到期"）和 3（"4/29 截止"）的精确语义先触发，否则一封"payment due today"会被 1b 抢成 24h 而不是 EOD，一封"pay by April 29"会被抢成 24h 而不是解析日期。

**Rule 1a 和 1b 分开的理由**：老版 `VERIFY_CODE_RE` 触发词太宽（`security|access|login|sign-in|code|pin`），既抓到真 OTP 也抓到包裹自提码、账单账号、安全更新通知，统一给 30 分钟。真实 OTP 30 分钟合理，但包裹通常 1 天才过期、账单更长。收紧 1a 之后把快递/账单拆成独立 1b 24h 默认，让每类都有合理窗口。

`parseDateClause(clause, anchor)`：支持 today/tonight/tomorrow、weekday 名、"Oct 15"、"10/15/26"。过去日期（未显式带年份）自动滚到明年。

`clampTtl(ts, anchor)` 上限 `anchor + 7 天`，下限 `anchor + 5 分钟`（太近已过期的直接返回 null）。

**应用场景**：一封 Track 类别的 2FA 邮件收到后 30 分钟内在 Priority 高亮；过期后 `isPriority()`（utils.ts）返回 false，回到 Track。包裹取件通知在 24 小时内停留 Priority。

**调用位置**（本 session 补齐）：prefetch Step 2a MiniLM 命中后 + Step 2b LLM 返回 primary_until 为 null 时 fallback，两处都调一次。**确定性规则独立于分类路径**，保证 MiniLM 自信命中的邮件（例如验证码被归 Track）也能拿到 TTL 升级，不再因 MiniLM 跳过 LLM 就失去时效性。

**UI 展示**（本 session 补齐）：`formatTtlHint(primary_until, now)` 返回 `"valid for Nm / Nh / Nd"` 字符串，前端 MailList 和 MailDisplay 分别以 amber pill 展示；过期时自动返回 null，hint 消失。

## Step 3: Jobs Pipeline（jobs-pipeline.ts）

**完全独立于 Inbox 分类**。入口是每封邮件在 Step 2a 被 work-gate 打上的 `maybe_work=1` 标记。

### 入口：work-gate 三层 fallback（2026-05-04 升级）

**当前主路径：SetFit 任务专属编码 + LR 头**（`web/lib/work-embedder.ts` + `web/lib/setfit-head.ts`）

- 模型：SetFit fine-tune 的 MiniLM body（contrastive learning on `work_labels`）+ LR 头
- 输入：邮件文本 → SetFit body 编码 → 384-d task-tuned embedding（缓存到 `emails.work_embedding` 列）
- 输出：P(is_work) ∈ [0, 1]，阈值 0.5 → `maybe_work` 布尔
- 权重：encoder ONNX 在 `web/models/setfit-work/onnx/model.onnx`（86 MB，gitignored，PROD 走 scp）；LR 头优先读 `app_state.setfit_head_runtime`，否则读 `web/models/setfit-work/head.json`
- **离线训练**：`training/setfit-work/train.py`（Python，setfit + optimum），输出 ONNX + head.json
- **运行时 warm-start**：用户右键纠错 → `trainSetfitHead({ warmStart: true })`（仅 retrain LR 头，body 不动），50 轮 LR on cached `work_embedding`，~100ms

**Fallback layer 1**：raw-MiniLM logistic regression（`web/lib/work-classifier.ts`）
- 当 SetFit 模型文件丢失时启用（`isWorkEmbedderAvailable()` 守门）
- 同样 384-d input + LR + 0.5 阈值；权重在 `app_state.work_classifier_weights`
- 已知缺陷：raw MiniLM space 中 job vs non-job cosine 分得不开，FPR 容易 ~71%（详 2026-05-04 实测）。SetFit 解决了这个问题

**Fallback layer 2**：cosine to work-seed centroid（`web/lib/work-seed.ts`）
- 最末端兜底：work_classifier_weights 也没有时退回这个
- 10 条 canonical job-text 平均向量做种子，cosine ≥ 0.25 即视为 work

**训练数据**（共享于 SetFit head + legacy LR）：`work_labels` 表，binary 标签（0/1）+ source（`llm_bootstrap` 或 `user_correction`）

**SetFit 完整重训**（offline，需要 Python）：
- 冷启动 / body 漂移：跑 `training/setfit-work/train.py` → 输出新 ONNX + head.json → 部署到 PROD（scp）
- 75 秒 / 51 样本（contrastive fine-tune）

**Runtime warm-start**（online，纯 TS）：
- 用户右键 → `trainSetfitHead({ warmStart: true })`，更新 LR 头，body 不动
- 样本加权：class balance × source weight（`user_correction=50`, `llm_bootstrap=1`），一次用户纠正 ≈ 50 次 LLM 标注的影响力（与 legacy work-classifier 同公式）

### Pipeline 三步

输入：`getMaybeWorkEmails()` 取所有 `maybe_work=1 AND NOT IN job_emails AND NOT IN job_skipped` 的邮件。

**Step 3-1: LLM confirm is_job**（`llmConfirmBatch`，chunks of 20）
- Readonly subprocess，prompt 问 `{is_job: bool, stage, company, role, deadline, ..., reason}`
- `is_job=false` → `markJobSkipped(email_id, reason)` 终结
- `is_job=true` → 进 Step 3-2

**Step 3-2: 归属 application**（`resolveApplication`，四层匹配）

```
A. thread_id → job_emails 查同 thread 已有的 application_id → 命中返回
B. sender domain → application_domains 表 → 唯一命中返回；多命中进 C
C. normalize(company) + normalize(role) → applications 查（findOrCreateApplication）
D. fuzzy：同 company 下 levenshtein(role) < 3 视为同一条 → 命中的话避免裂开
```

每次归属后 `addApplicationDomain(applicationId, sender_domain)` 写入 domain 映射，为未来同 domain 邮件走 B 快速通道。

**Step 3-3: 写入 + 重算**
- `upsertJobEmail(...)` 写 job_emails 行
- `setJobEmailApplicationId(email_id, applicationId)`
- `recomputeApplicationFromEmails(applicationId)` 刷新 application 的 current_stage / needs_action / deadline 快照

### 硬规则清零

本 session 删除：
- ❌ `JOB_SENDER_PATTERNS / JOB_SUBJECT_PATTERNS / JOB_BODY_PATTERNS`（9+4+4 条 regex）
- ❌ `isJobCandidate()` 函数
- ❌ 旧 `classifyJobEmails()` 单体 LLM 调用

保留的 `lib/job-classify.ts` 只剩 throw stub，防止 stale import 静默失败。

## Calendar 事件抽取（event-extractor.ts + time-signal.ts）

**触发模式（2026-05-01 改为手动）**：用户在 `/calendar` 页点 **Scan inbox** 按钮 → `POST /api/events action=scanInbox` → 单 Haiku 4.5 spawn 批量处理所有 SQL+regex 候选邮件 → 写入 `events` 表供 `/calendar` 渲染。

**为什么改成手动 + 批量**：原先在 prefetch Step 5 自动跑 per-email spawn — 每次 IMAP IDLE 推送 + 60s 前端 refresh 都触发 ≤10 封邮件 × 1 spawn each。Anthropic rate-limit 按请求数算（不按 token），这条路径是 2026-04 封号事件后日均 spawn 数的主要来源。改成手动按钮 + 单 spawn 批量后，每次扫描 1 个 spawn 处理 ≤50 封邮件（实测 26 封 × 31KB prompt → 单 Haiku × 100s × $0.01）。

> **应急关停**：`EMAILDIGEST_DISABLE_EVENT_EXTRACT=1` 写到 `.env.local` 后，`extractEventsForBatch` 入口 short-circuit 返回 0，**完全不 spawn**。手动按钮模式下其实已经天然受控，env 保留作 belt-and-suspenders；用于 Anthropic rate-limit / ban 等紧急场景。已存在的 events 仍展示，新邮件不进 calendar。删除 env + 重启服务即恢复。

### 两层 gate

历史教训：早期 gate 只问 "邮件里有没有任何日期/时间字符串"（4 条 regex 任一命中即过），本地 84-email 集 49% 拦截率看着不错，但 PROD 实测 100% 通过率 + 100% 空回 — Sonnet 每天烧 $70 抽 0 个事件。营销邮件 / 收据 / 账单 / 转发头残留全有日期。

收紧后的 B 层（current）：`hasTimeSignal` 要求 **2-of-3 信号**（date / time / event-context-keyword），并对常见 FP 主题（`Submission Posted` / `Apple Services:` / `Order Confirmation` 等）做硬黑名单短路。

| 层 | 位置 | 行为 |
|---|---|---|
| A | `db.ts listEmailsNeedingEventExtraction` SQL | `category_id IN ('cat_primary','cat_track')` 硬约束（LLM 永不看 News/Junk）|
| B | `time-signal.ts hasTimeSignal(email)` | (1) 主题命中 `SUBJECT_FP_BLACKLIST_RE` 直接拒；(2) 否则 body 前 2000 字 + subject 扫 4 条共享 date/time regex + `EVENT_CONTEXT_RE` 关键词；(3) `score = hasDate + hasTime + hasKeyword ≥ 2` 才过 |

SQL 先取 `limit * 2` 放大候选池，再在 JS 层 `.filter(hasTimeSignal).slice(0, limit)`。`extractEventsForBatch` 入口也对每封邮件重复一次 `hasTimeSignal` 守门，防止 API / 脚本直接调用绕过 SQL gate。

本地 17-positive 验证（2026-04-29）：旧 gate 47.5% 通过率 → 新 gate 32.5% 通过率，recall 17/17 (0 误拦)。

### 架构不变量

- **LLM 永不看 cat_news / cat_junk**：SQL 硬约束 + `SELECT COUNT(*) FROM events ev JOIN emails e ON e.id=ev.email_id WHERE e.category_id IN ('cat_news','cat_junk')` 必须 = 0
- **gate recall = 100%（截至 2026-04-29）**：历史 events 表所有 17 个 positives 都能过 `hasTimeSignal`。回归测试任何关键词调整都必须保此 invariant
- **共享 regex**：TTL Rule 3 和 event_extractor gate 都从 `time-patterns.ts` import，永远一致 — 避免过去"TTL 认得 4/29 但 gate 认不得"的漂移
- **weekday-only pattern 禁止进 gate**：`Mon / Thu` 这类子串会误触发 "mon"/"Thu" 噪声，3-10 天日期漂移。weekday 识别归 `ttl-rules.ts parseDateClause` 的精确解析路径，不进"这是不是日期"的粗筛
- **AND constraint, not OR**：keywords 是 `score ≥ 2` 的**额外要求**（与 date/time 一起累加），不是 fallback OR — 历史拒绝过 keyword OR 路径，原因是会引入 noise re-admission

### 防跨邮件重复（thread-duplicate 防护）

`/calendar` 曾出现同一 real-world 事件多次（用户截图：同一场 Project Review Meeting × 3 on Apr 27）。根因：一个 N-email back-and-forth thread，每封邮件 body 里都带着 inline quoted history，每次 Sonnet 抽取都看到同一事件 → 写 N 行。`upsertEvent` 的 `ON CONFLICT(email_id, hash)` 只 dedup 同邮件、不跨邮件。

两层保险：

**上游 — `stripQuotedReply` 在 `buildBatchPrompt`**：`event-extractor.ts` 对每封邮件 body 调 `stripQuotedReply(email.body).slice(0, 3000)`。同 thread 的第 N 封 reply，strip 之后只剩真·新内容（实测末封 4326→162 字节）—— LLM 根本看不到老事件，不会重复抽出。

**下游 — `findEventByNormalizedKey` 写入前查重**：写 `upsertEvent` 之前先查近 60 天所有 events，按归一化 key `(normalizeEventTitle(title) | startDayLocal(start_ts) | normalizeEventTitle(location))` 匹配。命中则 `updateEventFields` 只补充老行缺失的字段（location / end_ts / rsvp_by），不插新行。

归一化强度：lowercase + 标点替空格 + 连续空格折叠。**不做 fuzzy matching**（Levenshtein / 语义相似）。后果：`"Company A In-Person Interview"` vs `"Company A Holdings Inc. In-Person Interview"`（简称 vs 全称）仍视作不同事件（LLM 抽取不稳定产生的 title 变体不会被合并）。这是已知 limit —— 上游 strip 的作用就是减少 LLM 被 inline 引用干扰的概率，让 title 输出更稳定，间接降低这类漂移。

### LLM 调用路径（成本优化）

**不走** `subprocess.ts` / `./emaildigest inquiry` shell wrapper（那条路径会触发 CLAUDE.md + 7 份 @docs auto-load，每 spawn 烧 ~71K cache_create tokens 在 Sonnet 上）。改为直 spawn `claude -p --model haiku` 配 `cwd: os.tmpdir()`：

- `cwd: os.tmpdir()` → CLI 找不到项目 CLAUDE.md → 跳过 auto-load → cache_create 从 ~71K → ~5K (-94%)
- `--model haiku` (4.5) → input/output 单价是 Sonnet 的 1/3（$1 vs $3 per 1M）
- 无 MCP / safety.txt / inquiry.txt — 抽取是 pure JSON output，不需工具
- 仍受 `circuit-breaker` 保护（同 draft-gen.ts），单 spawn = 单 record，失败归因清晰
- 模型可经 `EMAILDIGEST_EVENT_MODEL` env override

**批量 prompt schema**（`buildBatchPrompt`）：每封邮件作为一个 `[email_N] id=... | From | Subject | Body` 块，`---` 分隔；LLM 返回 `[{email_id, events:[]}, ...]` 严格按输入顺序。`email_id` 字段确保即使 LLM 漏掉或乱序，调用方仍能用 Map 查找映射回原邮件。空 events 数组也必须返回（占位映射）。

`upsertEvent` 写表 / `source_start/source_end` 回填 / 跨邮件 dedup 等下游逻辑都没动。参见 `lib/event-extractor.ts` 的 `extractEventsForBatch` + `spawnHaikuExtract`。

## Inbox 分类纠错反馈循环

用户在 `CategoryPicker` 改分类：

1. `POST /api/emails action=setCategory` 事务内：
   - 读取 OLD category_id（纠错前快照）
   - `updateCategories(ids, newCategory, "user")` 锁 classifier='user'
   - `UPDATE emails SET category_id = newCategoryId`
   - `removeEmailExampleFromCategory(OLD 类别)`（防止 SetFit head 继续在错标签上训练）
   - `addCategoryExample(NEW 类别, source='user_correction', weight=50)`
2. 事务外：缓存该邮件的 `classify_embedding`（如缺）+ `queueMicrotask(trainSetfitClassifyHead({warmStart:true}))`（50 轮 LR retrain on cached classify_embedding）
3. `POST /api/emails action=recordCorrection` → `insertCorrection` 记录域名 bias（LLM few-shot 用）
4. 下次类似邮件到达：retrain 过的 SetFit head 直接给出更高 top1 → 跳过 LLM

**为什么必须删 OLD example**：不删则 SetFit head warm-start 同时拿到该邮件的两份矛盾标签（OLD + NEW），梯度互相抵消。删除后只剩 NEW 一票，weight=50 能干净盖过历史 llm_high_conf 噪声。

## Jobs 纠错反馈循环（本 session 新增）

| 用户动作 | 路径 | 效果 |
|---|---|---|
| Inbox 右键 / 长按 → "Classify as Job related" | `api/jobs action=forceClassifyAsJob` → `setMaybeWork(1)` + `clearJobSkipped` + `upsertWorkLabel(id, 1, 'user_correction')` + 缓存 `work_embedding`（如缺）+ 异步 `trainSetfitHead({warmStart:true})`（SetFit 不可用时 fallback 到 `trainWorkClassifier`）+ **同步** `forceClassifySingleEmail(id)`（绕过 is_job gate，只跑字段抽取 + `resolveApplication`） | 用户显式确认 = 邮件一定进 Jobs 看板；同时给 classifier 注入一条权重 50 的正样本，下次同类邮件自动 `maybe_work=1` |
| 看板 remove | `api/jobs/[id] action=remove` → `upsertWorkLabel(id, 0, 'user_correction')` + 缓存 `work_embedding`（如缺）+ `trainSetfitHead({warmStart:true})`（SetFit 不可用时 fallback 到 `trainWorkClassifier`） | 分类器 predict 该类邮件概率下移，连带压低 embedding 近邻 |
| 看板改 stage/company | `api/jobs/[id] action=updateStage` → `insertJobCorrection(kind='stage'/'company')` | 下次 prefetch Step 3-1 LLM prompt 的 few-shot 示例 |

user_correction 权重 50 保证一次纠正盖过 50 条 LLM bootstrap 标签。

**为什么绕过 is_job gate**：当训练集正样本偏少时（例如刚冷启动、bootstrap 标签里 label=1 只有个位数），is_job LLM 对 terse rejection 邮件（"Thanks for your interest, we're moving forward with other candidates"）容易误判 false，把邮件扔进 `job_skipped` 永久遮蔽。用户右键说"这是 job"时，意图必须是绝对的，不能被 LLM 再否决一次；所以 `forceClassifySingleEmail` 用另一个 prompt 只问字段（`EXTRACT_PROMPT_HEADER`），不再问 is_job。

**API action**：UI 只走 `forceClassifyAsJob`（绕过 is_job gate）。早期的 `sendToJobs` action 已删除。

## 服务器启动序列（instrumentation.ts）

Next.js `register()` hook，仅 `NEXT_RUNTIME === "nodejs"` 时执行：

```
1. cleanExistingBodies(stripLLMContamination)
   → 事务内遍历所有 body≠''，调用 sanitizer 并 UPDATE 变化项
   → 输出 "Cleaned N contaminated email bodies"
   → 幂等：修复历史 MCP-fetch 留下的 AI 污染前缀 / 不可见字符
     （IMAP 拉的新邮件不会产生这类污染）

2. getEmailCount() → count
   console.log "Database has {count} emails"

3. if (count === 0) startBackfill()
   → 365 天 / 2000 封一次拉满，异步，不阻塞服务器启动

4. if (isImapConfigured()) startIdleListener(startPrefetch)
   → 建立 IDLE 长连接，断线自动重连

5. setInterval(60_000): 检查到期 scheduled drafts
   → getScheduledDraftsDue(now) 取到期草稿
   → sendEmail({..., includeSignature: true}) 通过 SMTP 实际发送
   → markDraftSent(id, messageId) 终结
   → 需要 isSmtpConfigured() 否则跳过
```

## LLM 正文污染清洗（sanitize.ts）

即便已切换到 IMAP，`stripLLMContamination(raw)` 在 `cleanExistingBodies` 启动清洗 + `mail-display.tsx` 渲染前仍被调用，处理历史遗留：

1. **不可见字符**：`[\u034f\u00ad\u200b\u200c\u200d\ufeff]`（CGJ / soft hyphen / ZWSP / BOM）— 邮件营销人员用来搞 preheader padding 的技巧
2. **连续空行/空格折叠**：`\n{3,}` → `\n\n`，` {5,}` → `  `
3. **中文 AI 前缀**（6 种）：`邮件正文内容如下：` / `以下是邮件正文：` / `邮件正文：` / `正文如下：` / `正文内容：` / `以下是邮件的正文：`
4. **中文 AI 后缀**（5 种）：`正文为空—...` / `这封邮件...` / `该邮件...` / `这是一封...` / `注：...`
5. **Markdown 围栏**：首 ` ```lang ` 和末 ` ```/`` `
6. **邮件头块**：前 10 行内 `From:/Sent:/To:/Subject:/Cc:/Bcc:/Date:` 块，必须同时出现 From + (Sent 或 Date) 才清除；允许 Subject 后一个空行；前置 `________` 分隔线也一并去除

函数幂等，多次调用结果一致。
