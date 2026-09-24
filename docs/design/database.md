# 数据库设计

## 概述

SQLite 数据库，位于 `$EMAILDIGEST_DIR/data.db`（默认为项目根目录）。使用 WAL 模式（Write-Ahead Logging）提升并发读性能。通过 `better-sqlite3` 同步 API 访问。

**WAL 模式注意事项**:
- 数据库文件旁会有 `data.db-wal` 和 `data.db-shm` 辅助文件，不要删除
- WAL 模式允许并发读 + 单写，适合 Next.js API route 的并发请求
- `better-sqlite3` 是同步 API，单线程内不会有写冲突

**路径解析**: `path.resolve(process.env.EMAILDIGEST_DIR || path.join(process.cwd(), ".."), "data.db")`。Next.js 的 `process.cwd()` 是 `web/` 目录，因此 `..` 指向项目根目录。

**23 张表**，按职能分组：

| 分组 | 表 | 用途 |
|------|-----|------|
| 邮件域 | `emails`, `email_chunks`, `corrections`, `email_attachments` | 邮件元数据/正文/embedding/work_embedding/classify_embedding/maybe_work；body chunk-level embedding（Ask AI RAG 用）；用户纠正；入站附件 |
| 草稿域 | `drafts`, `attachments` | 本地草稿 + 草稿附件（cascade delete） |
| Inbox 分类域 | `categories`, `category_examples`, `category_centroids`, `base_model_centroids` | 动态分类 + few-shot 样本 + 用户质心 + 冻结基模型质心 |
| Jobs 域 | `job_emails`, `applications`, `application_domains`, `job_corrections`, `job_skipped`, `work_labels`, `job_eval_set` | 看板行 + application 聚合 + domain 快速通道 + 用户纠错 + LLM is_job=false 缓存 + 二分类器训练语料 + gold 标签 |
| 日历域 | `events` | 由 prefetch Step 5 从 Primary/Track 邮件 LLM 抽取；calendar 页消费 |
| Ask AI 域 | `conversations` | Ask AI session 索引（`/api/chat`）；过滤同目录下 1100+ subprocess jsonl |
| 推送域 | `push_subscriptions` | Web Push 订阅（VAPID endpoint + p256dh/auth keys）；daily-digest 触发推送时遍历此表 |
| 状态域 | `app_state` | 应用级 key/value 状态（含 `embed_model`, `claude_auth_status`, `claude_auth_error`, `claude_auth_checked_at`, `work_classifier_weights`, `work_classifier_version`, `work_seed_centroid`, `setfit_head_runtime`, `setfit_head_version`, `setfit_classify_head_runtime`, `setfit_classify_head_version`, `user_profile_name`, `push_config_status`, `push_config_error`, `push_last_sent_at`, `email_digest`, `push_last_slot_pushed_at`, `reclassify_started_at`）|
| 日志域 | `logs` | 结构化日志（debug 用），7 天保留 |
| 研究域 (dev) | `eval_set` | gold-standard 标注（GoldLabelPicker，仅 dev） |

表结构通过 `CREATE TABLE IF NOT EXISTS` 自动创建。后续添加的列用 `ALTER TABLE ... ADD COLUMN`（在 try/catch 中，幂等）。

## 分类法：4-bucket MECE

默认分类按**用户意图**（不是主题）划分，启动时若 `categories` 表为空则自动 seed：

| id | name | sort_order | base_fallback_name | 语义 |
|----|------|-----------|-------------------|------|
| `cat_primary` | Primary | 10 | null | 真人直接沟通，或时效性 action-required |
| `cat_track` | Track | 20 | "track" | 为你而生成的事件：订单、发货、成绩、确认、验证码、预约 |
| `cat_news` | News | 30 | "news" | 订阅/广播内容流：newsletter、digest、新闻、平台公告 |
| `cat_junk` | Junk | 40 | "junk" | 营销 + spam 合并；当前不做自动 prune（行保留以便分类质心训练）|

**关键区分（广播 vs 专属）**：Track 和 News 都是"平台发给你"，但 Track 是**因你的账号/行为专属生成**（发给你一个人），News 是**广播给所有订阅者**（同一封给很多人）。

**`primary_until` 是 TTL 临时升级**：某封 Track 邮件（如 2FA 验证码）可以被标记 `primary_until` = now+30min，在这段时间内被当作 Primary 显示，过期后回到 Track。TTL 规则详见 [email-pipeline.md](email-pipeline.md#primary-ttl-规则)。

`types.ts` 的 `EmailCategory` 类型仍保留 legacy 值（`academic, assignment, ...` 等）用于旧行兼容，但新系统主要通过 `category_id` 字段。

## emails 表

```sql
CREATE TABLE emails (
  id TEXT PRIMARY KEY,                       -- Gmail messageId（X-GM-MSGID 转 16 进制）
  from_name TEXT NOT NULL,                   -- 发件人显示名
  from_email TEXT NOT NULL DEFAULT '',       -- 发件人邮箱
  subject TEXT NOT NULL,                     -- 主题
  snippet TEXT NOT NULL DEFAULT '',          -- 前 50 字预览
  body TEXT NOT NULL DEFAULT '',             -- plain-text MIME part（经过 unwrapForwarded）；用于 LLM prompt / 引用回复 / 预览 / 搜索
  body_html TEXT NOT NULL DEFAULT '',        -- HTML MIME part（parsed.html，未改动）；UI 通过 react-letter 渲染（自带 permissive sanitizer）。''=邮件仅有 text 部分
  date TEXT NOT NULL,                        -- 太平洋时间的显示字符串（同日 HH:mm，否则 M/D）
  category TEXT NOT NULL DEFAULT 'notification',   -- legacy 字段，保留兼容
  urgency TEXT NOT NULL DEFAULT 'fyi',       -- [legacy] 紧急度。本 session 删除 urgency 功能后不再写入；列保留（SQLite drop 代价大）；旧行仍填 'fyi'
  confidence REAL NOT NULL DEFAULT 0,        -- 分类置信度（0-1）
  classifier TEXT NOT NULL DEFAULT 'llm',    -- 分类来源：minilm / llm / user
  thread_id TEXT NOT NULL DEFAULT '',        -- Gmail threadId
  is_unread INTEGER NOT NULL DEFAULT 1,      -- 1=未读，0=已读
  received_at INTEGER NOT NULL DEFAULT 0,    -- 邮件接收时间（Unix 秒）
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),   -- 入库时间
  classified_at INTEGER,                     -- 最后分类时间
  embedding BLOB,                            -- [ALTER] 通用 MiniLM 句向量（Inbox 分类 + Ask AI RAG 都读这个）
  category_id TEXT,                          -- [ALTER] FK → categories.id（新系统主字段）
  primary_until INTEGER,                     -- [ALTER] TTL epoch；未来时间时临时升 Primary
  maybe_work INTEGER NOT NULL DEFAULT 0,     -- [ALTER] Jobs pipeline 入口标记（见 work-embedder.ts）；Inbox 不读该字段
  work_embedding BLOB,                       -- [ALTER 2026-05-04] SetFit 任务专属向量（仅 work-classifier 用，Inbox/RAG 不读）
  classify_embedding BLOB                    -- [ALTER 2026-05-07] SetFit 4-way 分类专属向量（仅 classify-embedder 用；与 work_embedding/embedding 三向量正交）
)
```

### classifier 字段的三种活跃值

| 值 | 来源 | confidence 语义 |
|----|------|----------------|
| `setfit` | `predictClassifyFromEmbedding` — SetFit 4-way LR head | softmax top1（≥ 0.80 才写）|
| `llm` | LLM 精细分类（SetFit 不自信时落 Step 2b） | LLM self-rate tier 映射后 — high=0.9, medium=0.55, low=0.3。**Medium 落入 needsUserConfirm 区间**自动触发 active learning 横幅。2026-05-14 前是硬编码 0.9（被 needsUserConfirm gate 永远排除，详见 lessons-learned §25）|
| `user` | 用户在 CategoryPicker 手动纠正 | 通常保持前值；行被保护不被批量覆写 |

> **DEPRECATED 2026-05-08**：旧值 `minilm`（来自已退役的 generic-MiniLM 质心 fallback）仍可能出现在历史行里，但新代码不再写入此值。

### classifier='user' 的保护层

用户手动纠正过的邮件在多个路径上被"冻结"：

1. `upsertEmails()` ON CONFLICT：`category` 仅在 `classifier != 'user'` 时才覆盖
2. prefetch Step 2：在进入 embedding+classify 循环前用 `SELECT id FROM emails WHERE classifier='user' AND id IN (...)` 构造 skip set
3. prefetch Step 2b LLM 升级：走同一条 `updateStmt`，SQL 的 `WHERE id = ? AND classifier != 'user'` 过滤
4. `setCategory` API（用户手动操作）和 `setEmailCategoryId()` 会直接覆盖（包括 user 行）

### classified_at 语义

每次 upsert 和 updateCategories 都会重设为 `unixepoch()`，即使分类结果不变。代表"最后被分类系统处理的时间"，不是"分类结果变更的时间"。

### 排序策略

`getAllEmails()` 使用 `ORDER BY received_at DESC, fetched_at DESC`。`received_at=0`（时间戳解析失败）的邮件排在最后，但 `fetched_at` 作为 tiebreaker 保证它们之间也有序。

### 函数

| 函数 | SQL / 说明 |
|------|----------|
| `upsertEmails(emails[])` | INSERT ... ON CONFLICT DO UPDATE，事务包裹；body/from_email 新值为空保留旧；`classifier='user'` 的行不覆盖 category |
| `getAllEmails()` | ORDER BY received_at DESC, fetched_at DESC |
| `getEmailById(id)` | 单封查询（含 embedding / category_id / primary_until） |
| `getEmailCount()` | 总数 |
| `updateCategories(ids[], category, classifier?)` | 批量更新 legacy category 字段 |
| `setEmailCategoryId(id, categoryId)` | 更新 category_id（新系统），重设 classified_at |
| `setEmailPrimaryUntil(id, ts)` | 设置/清除 TTL |
| `setEmailRead(id, isUnread)` | 标记已读/未读 |
| `markCategoriesAsRead(categories[])` | WHERE is_unread=1 AND category IN (...) |
| `updateEmailBody(id, body)` | 单独更新正文 |
| `updateEmailEmbedding(id, Buffer)` | 缓存句向量 |
| `updateEmailThreadId(id, threadId)` | 补 thread_id |
| `cleanExistingBodies(sanitizer)` | 事务内遍历所有 body≠''，调用 sanitizer 并 UPDATE 变化项；返回清洗行数 |

## email_attachments 表

入站邮件附件（Outlook auto-forward 可能带 .eml 附件，解析后入库）。

```sql
CREATE TABLE email_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,                        -- 磁盘路径
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_id TEXT,                           -- cid: 内联图片的 Content-ID
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

| 函数 | 说明 |
|------|------|
| `getEmailAttachments(emailId)` | 该邮件的全部附件，按 id 排序 |
| `getEmailAttachment(id)` | 单附件查询（下载 API 用） |

## logs 表

结构化日志（双写：stdout + SQLite）。详细设计见 [logging.md](logging.md)。

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
  component TEXT NOT NULL,                -- 'prefetch' / 'email-digest' / 'imap' / 'breaker' / 'auth' / etc.
  message TEXT NOT NULL,
  ctx TEXT,                               -- JSON blob: {emailId?, jobId?, durationMs?, errorStack?, ...}
  trace_id TEXT                           -- 关联同一逻辑流（如一次 prefetch 跨 step 共用 ID）
)
CREATE INDEX idx_logs_ts ON logs(ts DESC)
CREATE INDEX idx_logs_component_ts ON logs(component, ts DESC)
CREATE INDEX idx_logs_level_ts ON logs(level, ts DESC) WHERE level IN ('warn','error')
```

**保留**：启动时 `DELETE FROM logs WHERE ts < now - 7*86400`。**写入**：`lib/logger.ts` 异步 batch（1s 或 100 行 flush）。**debug** 级仅 stdout 不入 DB。

## ~~briefings 表~~ (REMOVED 2026-05-02)

Per-category dashboard summaries were retired. The stale-trigger ("max(received_at) > briefing.updated_at") fired on every new email arrival in a category, dragging merged-prefetch into a spawn for almost every IMAP IDLE event regardless of MiniLM verdict. UX consolidated into a single email-digest at the dashboard top (refreshes every 2h with stale-check). DB cleanup runs at startup: `DROP TABLE IF EXISTS briefings` + `DELETE FROM app_state WHERE key='daily_digest'` (renamed to `email_digest`).

Historical detail of the briefings schema and caching mechanism: see `docs/archive/briefing-density-redesign.md` and `docs/archive/briefing-stale-trigger.md`.

## corrections 表

记录用户分类纠正，反馈到分类器。

```sql
CREATE TABLE corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_domain TEXT NOT NULL,                 -- 从 from_email 自动提取（@ 后部分，无 @ 则存完整值）
  subject TEXT NOT NULL,
  ml_category TEXT NOT NULL,                 -- 原分类（legacy short name）
  user_category TEXT NOT NULL,               -- 纠正后的分类
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

### 反馈到分类器

`corrections` 表目前主要作为历史日志 + LLM few-shot 来源——SetFit head 的 warm-start retrain 直接从 `category_examples` 读取标注，不再走 `corrections` 表的中间步骤。

### 反馈到 LLM

prefetch Step 2b（Inbox LLM 精细分类）可选择性地将最近 10 条 corrections 注入 prompt 作为 few-shot 示例。

### 反馈到 SetFit head

当用户 `setCategory` 改分类时，除了把邮件加入新类别 `category_examples`（source='user_correction', weight=50），还会**从旧类别 examples 删除该邮件**，防止 SetFit head warm-start 同时拿到该邮件的两份矛盾标签。详见 email-pipeline.md 纠错反馈循环。

### 函数

| 函数 | 说明 |
|------|------|
| `insertCorrection(emailId, fromEmail, subject, mlCategory, userCategory)` | 自动提取 domain |
| `getRecentCorrections(limit=10)` | 最近 N 条（LLM few-shot 用） |

## drafts 表

详见 [draft-system.md](draft-system.md)。

```sql
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,                          -- d_{timestamp}_{random}
  email_id TEXT,                                -- 关联邮件 ID（nullable，compose 模式无）
  thread_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'reply',           -- reply | forward | new
  to_address TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '',
  bcc TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  status TEXT NOT NULL DEFAULT 'draft',         -- draft|pushed|sent|scheduled|discarded
  gmail_draft_id TEXT,                          -- Push 后 Gmail 返回的 draft ID（当前未回填）
  sent_at INTEGER,                              -- SMTP 发送时间（status=sent）[ALTER]
  gmail_message_id TEXT,                        -- nodemailer 返回的 messageId（status=sent）[ALTER]
  scheduled_at INTEGER,                         -- 定时发送 epoch（status=scheduled）[ALTER]
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

> **types.ts 漂移**：`DraftStatus = "draft" | "pushed" | "sent" | "discarded"` 没列 `"scheduled"`，但 `scheduleDraft()` 会实际写入 `status='scheduled'`。前端 `getAllDrafts()` 只返回 `status='draft'` 所以不会撞到这个枚举空洞，但批量状态切换代码需注意。

### 函数

| 函数 | 说明 |
|------|------|
| `createDraft(draft)` | 插入新草稿，返回完整 DraftRow |
| `getDraftById(id)` | 单条查询 |
| `getAllDrafts()` | 仅 status='draft'，ORDER BY updated_at DESC |
| `updateDraft(id, patch)` | 动态 SET 子句；undefined 字段跳过；追加 `updated_at = unixepoch()` |
| `updateDraftStatus(id, status, gmailDraftId?)` | 设置状态 |
| `markDraftSent(id, messageId)` | SMTP 发送完成：status=sent + sent_at + gmail_message_id |
| `scheduleDraft(id, sendAt)` | status=scheduled + scheduled_at |
| `getScheduledDraftsDue(now)` | 取到期 scheduled 给 cron |
| `deleteDraft(id)` | 永久删除（cascade 删除 attachments） |

## attachments 表（草稿附件）

```sql
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,                           -- 磁盘路径
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
)
```

`DraftEditor` 通过 `/api/drafts/[id]/attachments` POST/GET/DELETE。客户端 10MB 上限。SMTP send 时从此表读取路径喂给 nodemailer。

## email_chunks 表

Ask AI RAG 的 chunk-level embedding 池。每封邮件 body 切成 ~400 字 chunks 独立 embed，避免整邮件单向量被营销 boilerplate 稀释。与 `emails.embedding`（Inbox 分类器用）正交，互不读写。详见 [ask-rag.md](ask-rag.md)。

```sql
CREATE TABLE email_chunks (
  id TEXT PRIMARY KEY,              -- <email_id>_<chunk_idx>
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  chunk_idx INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding BLOB NOT NULL,          -- 384-d Float32 (all-MiniLM-L6-v2)
  UNIQUE(email_id, chunk_idx)
)
CREATE INDEX idx_chunks_email ON email_chunks(email_id)
```

| 函数 | 说明 |
|------|------|
| `upsertChunk(row)` | INSERT OR UPDATE by (email_id, chunk_idx) |
| `replaceChunksForEmail(emailId, rows)` | 事务：删旧 chunks 再批量插入 |
| `listChunksForEmail(emailId)` | 该邮件所有 chunks（调试/debug-chunk-cos 用） |
| `listAllChunks(windowDays, maxEmails)` | 取 windowDays 内非 junk 邮件的所有 chunks + email metadata JOIN（retrieve.ts 用） |
| `listEmailsNeedingChunks(limit)` | body 非空但 email_chunks 为空的邮件（backfill + Step 1.6 增量用） |
| `hasChunks(emailId)` / `countChunks()` | 存在性 + 总数 |

切分策略见 `web/lib/chunker.ts`：段落→句子贪婪装箱，目标 400 字，上限 500，最多 6 块/邮件，URL 剥离。Backfill: `web/scripts/backfill-chunks.ts`。

## categories 表（动态分类）

```sql
CREATE TABLE categories (
  id TEXT PRIMARY KEY,                          -- "cat_" + slug(name)
  name TEXT NOT NULL UNIQUE,                    -- 显示名 (如 "Primary")
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',                -- Lucide icon 名
  is_default INTEGER NOT NULL DEFAULT 0,        -- 1=系统默认（种子行为保留）
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  base_fallback_name TEXT                       -- [ALTER] [DEPRECATED 2026-05-08] 旧 MiniLM 时代指向 base_model_centroids.category_name；当前不读
)
```

启动时若表为空，seed `DEFAULT_CATEGORIES`（4 个 bucket，见上）。表非空时，对已有默认分类 backfill `base_fallback_name`（幂等）。

| 函数 | 说明 |
|------|------|
| `listCategories()` | ORDER BY sort_order ASC, name ASC |
| `getCategoryById(id)` / `getCategoryByName(name)` | 单查询 |
| `upsertCategory({...})` | INSERT OR UPDATE，含 base_fallback_name |
| `deleteCategory(id)` | 事务：先 `UPDATE emails SET category_id=NULL WHERE category_id=?` 再 DELETE（is_default 检查在 API 层）|

## category_examples 表

```sql
CREATE TABLE category_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  email_id TEXT,                                -- 可为 null（seed 样本无对应邮件）
  source TEXT NOT NULL,                         -- user_correction | onboarding_seed | seed | llm_auto | bulk_import
  embedding BLOB NOT NULL,                      -- 样本向量
  subject_preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(category_id, email_id)
)
```

### source 权重（分类器用）

SetFit head warm-start retrain 的 sample weight = class-balance × source-priority。`SOURCE_WEIGHTS` 集中定义在 `setfit-classify-head.ts`：

| source | 权重 | 场景 |
|--------|------|------|
| user_correction | 50 | 用户右键纠正（最强信号） |
| llm_high_conf | 25 | LLM self-rate `high` — 明确教科书级样本 |
| llm_med_conf | 5 | LLM self-rate `medium` — 类别合理但至少一个信号模糊（2026-05-14 起）|
| bootstrap | 5 | 冷启动手工种子 |
| spam_corpus | 3 | 公开 spam 语料（legacy seed-junk-corpus.ts 写入，2026-05-08 起脚本已删，残留行保留）|
| bulk_import | 1 | 规则启发式批量导入（legacy） |

确保 5 个手选样本不会被 100 个规则标注的样本淹没。

**Low-tier LLM 不回灌**：`mapLLMConfidence(raw).trainable === false` 时跳过 `addCategoryExample`，所以 `SOURCE_WEIGHTS` 里没有 `llm_low_conf` 这一行。低信心 LLM 判定仍写入 `emails`（用户能看分类），但不进训练池——把猜测当作 label 会污染 head（参见 lessons-learned §25 + 2026-05-10 §1）。

**注**：work_labels（Jobs 二分类器）有自己的独立 `SOURCE_WEIGHTS`（`user_correction=50`, `llm_bootstrap=1`）— 见 [work_labels 表](#work_labels本-session-新增)。两套权重互不影响。

### 函数

| 函数 | 说明 |
|------|------|
| `addCategoryExample({categoryId, emailId, source, embedding, subjectPreview?})` | ON CONFLICT(category_id, email_id) 更新 |
| `addCategoryExamplesBulk(rows[])` | 事务批量插入，ON CONFLICT DO NOTHING；返回实际插入数 |
| `listExamplesByCategory(categoryId)` | ORDER BY id DESC |
| `countExamplesByCategory(categoryId)` | 计数 |
| `deleteCategoryExample(id)` | 删除 |
| `removeEmailExampleFromCategory(categoryId, emailId)` | 用户改分类时清旧类样本 |
| `getLabeledClassifySamples()` | SetFit head warm-start 的训练数据源（JOIN emails 拿 `classify_embedding`）|

## category_centroids 表（DEPRECATED 2026-05-08）

```sql
CREATE TABLE category_centroids (
  category_id TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  centroid BLOB NOT NULL,
  example_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

旧 generic-MiniLM 质心 fallback 用，`minilm-classifier.ts` 退役（2026-05-08，lessons-learned §23）后不再读写。schema 保留避免 SQLite drop 麻烦；历史数据冻结。`getCategoryCentroid` / `listAllCentroids` / `upsertCentroid` / `deleteCentroid` 几个 helpers 已从 db.ts 删除。

## base_model_centroids 表（DEPRECATED）

历史保留。SetFit 4-way ship 后不再有任何代码读这张表。schema 保留避免 SQLite drop 麻烦。

```sql
CREATE TABLE base_model_centroids (
  category_name TEXT NOT NULL,                  -- "track" / "news" / "junk"（对应 categories.base_fallback_name）
  version TEXT NOT NULL,                        -- "v1", "v2", ...
  centroid BLOB NOT NULL,
  example_count INTEGER NOT NULL,
  source TEXT NOT NULL,                         -- 数据集标识
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (category_name, version)
)
```

## Jobs 域表（本 session 重构）

Jobs 是**独立**于 Inbox 分类的子系统。详见 [email-pipeline.md#step-3](email-pipeline.md) Jobs Pipeline。Inbox 永远不读下面这些表。

### job_emails（看板事件流）

```sql
CREATE TABLE job_emails (
  email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,                           -- applied/interview_scheduled/offer/rejected/withdrawn/...
  needs_action INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium',
  deadline INTEGER,                              -- epoch 秒
  summary TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  is_user_corrected INTEGER NOT NULL DEFAULT 0,
  classified_at INTEGER NOT NULL DEFAULT (unixepoch()),
  salary TEXT NOT NULL DEFAULT '',               -- [ALTER]
  location TEXT NOT NULL DEFAULT '',             -- [ALTER]
  remote_mode TEXT NOT NULL DEFAULT '',          -- [ALTER]
  visa_note TEXT NOT NULL DEFAULT '',            -- [ALTER]
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL  -- [ALTER]
)
```

### applications（看板卡片聚合）

```sql
CREATE TABLE applications (
  id TEXT PRIMARY KEY,                           -- app_{timestamp}_{random}
  company TEXT NOT NULL,                         -- normalized（见 applications.ts）
  role TEXT NOT NULL,                            -- normalized
  company_display TEXT NOT NULL,                 -- 原文
  role_display TEXT NOT NULL,
  current_stage TEXT, current_priority TEXT,
  current_summary TEXT, current_deadline INTEGER,
  needs_action INTEGER, action_type TEXT,
  salary/location/remote_mode/visa_note TEXT,
  is_user_corrected INTEGER NOT NULL DEFAULT 0,  -- 1=rename/merge/改 stage，锁快照
  first_email_at INTEGER, latest_email_at INTEGER,
  created_at, updated_at INTEGER,
  UNIQUE(company, role)                          -- 触发 fuzzy merge 的关键约束
)
```

### application_domains（本 session 新增）

**Jobs 归属 Step 2B 的 domain → application 快速通道**。第一次 LLM 判出某 application 后，把 sender 域名写入；后续同 domain 邮件免判直接归属。多对多：big employers 可绑多个 application（不同 role），同一 application 可有多个 domain（收购、代转发）。

```sql
CREATE TABLE application_domains (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (application_id, domain)
)
CREATE INDEX idx_application_domains_domain ON application_domains(domain)
```

函数：`addApplicationDomain(appId, domain)` / `findApplicationsByDomain(domain)`。

### job_skipped（本 session 新增）

缓存 Jobs Step 1 LLM 判 `is_job=false` 的结果。防止同一封邮件被反复 LLM 判空。

```sql
CREATE TABLE job_skipped (
  email_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  skipped_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

函数：`markJobSkipped(id, reason)` / `clearJobSkipped(id)`（用户右键 → Classify as Job related 时清）/ `isJobSkipped(id)`。

### work_labels（本 session 新增）

Work classifier 的训练语料。每封邮件最多一行，label ∈ {0, 1}。`source='llm_bootstrap'`（初次 Sonnet 全库打标）或 `'user_correction'`（Inbox 右键 / 长按 → "Classify as Job related"，或看板 remove）。

```sql
CREATE TABLE work_labels (
  email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  label INTEGER NOT NULL,                -- 0 = not work, 1 = work
  source TEXT NOT NULL,                  -- llm_bootstrap | user_correction
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

**source 权重**（`lib/work-classifier.ts SOURCE_WEIGHTS`）：
- `user_correction = 50`
- `llm_bootstrap = 1`

一次用户纠正等于 50 条 LLM 标注的梯度权重。训练时 class balance × source weight 一起乘进 BCE loss。

函数：`upsertWorkLabel(emailId, label, source)` / `listWorkLabels()` / `countWorkLabels()` / `getLabeledEmailsWithEmbeddings()`（训练入口用）。

### job_corrections

用户在看板改 stage / company / 标 remove 时的操作日志。作为 LLM few-shot 示例注入下次 Jobs Step 1 prompt。

```sql
CREATE TABLE job_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  from_email TEXT, subject TEXT,
  ml_stage TEXT, user_stage TEXT,
  ml_company TEXT, user_company TEXT,
  correction_kind TEXT NOT NULL,                 -- "stage" | "remove" | "company"
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

函数：`insertJobCorrection({...})` / `getRecentJobCorrections(limit=8)`。

### job_eval_set（dev-only）

gold 标签用于回归测试 Jobs classifier。

```sql
CREATE TABLE job_eval_set (
  email_id TEXT PRIMARY KEY,
  gold_is_job INTEGER NOT NULL,
  gold_stage TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

由 `scripts/seed-eval-set.ts` / `scripts/eval-job-classifier.ts` 使用。

---

## conversations 表

Ask AI 会话索引。Source of truth 是 Claude CLI 的 per-session jsonl `~/.claude/projects/<dir>/<sid>.jsonl`；这张表只记录"哪些 sid 是 Ask AI 会话"，过滤同目录下另外 1100+ 个 subprocess（event-extractor / jobs-pipeline / digest / draft-gen 等）产生的 jsonl 干扰。详见 [ask-rag.md#chat-history](ask-rag.md#chat-history)。

```sql
CREATE TABLE conversations (
  sid TEXT PRIMARY KEY,                      -- Claude CLI session uuid
  title TEXT NOT NULL,                       -- 首条 user message slice(0,60)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC)
```

写入：`lib/ask/stream.ts` 的 `proc.on("close")` 在 `code === 0` 时调 `upsertConversation(sid, prompt)`；ON CONFLICT 只 bump `updated_at`，**永不覆盖 title**（保持首条 user message 作为话题标识）。

| 函数 | 说明 |
|------|------|
| `upsertConversation(sid, firstUserMessage)` | INSERT，title=`firstUserMessage.slice(0,60).replace(/\s+/g," ").trim()`；ON CONFLICT(sid) DO UPDATE SET updated_at=unixepoch() |
| `listConversations(limit=50)` | ORDER BY updated_at DESC LIMIT ? |
| `deleteConversation(sid)` | DELETE 行（API 层另外 `fs.unlink` jsonl 物理文件） |

## push_subscriptions 表

Web Push 订阅。每个浏览器/设备一行（unique by `endpoint`）。`daily-digest.ts` 在 digest 重生成成功且 `push_summary` 非空时遍历此表，调 `web-push` 库给所有订阅推送精简通知。

```sql
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,             -- VAPID push service URL（FCM / Mozilla / Apple）
  p256dh TEXT NOT NULL,                      -- 客户端公钥（用于加密 payload）
  auth TEXT NOT NULL,                        -- 客户端 auth secret
  user_agent TEXT NOT NULL DEFAULT '',       -- 调试用：标识设备
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),  -- 每次成功 send 后 bump
  last_error TEXT NOT NULL DEFAULT '',       -- 最近一次 web-push 失败原因
  last_error_at INTEGER
)
CREATE INDEX idx_push_subs_created ON push_subscriptions(created_at DESC)
```

**生命周期**：
- 用户在 `/settings/notifications` 点 Enable → 浏览器 `pushManager.subscribe()` → 上报后端 → `addPushSubscription` (INSERT OR REPLACE by endpoint)
- `sendPushToAll` 失败：404 / 410 → `deletePushSubscriptionByEndpoint`（订阅过期，清除）；其他错误 → `recordPushFailure`（记日志，下次仍尝试）
- 成功：`bumpPushLastSeen`

| 函数 | 说明 |
|------|------|
| `addPushSubscription({endpoint, p256dh, auth, userAgent})` | INSERT OR REPLACE by endpoint |
| `listPushSubscriptions()` | 全部订阅 |
| `countPushSubscriptions()` | 计数（daily-digest 决策是否调 web-push）|
| `deletePushSubscriptionByEndpoint(endpoint)` | DELETE — 订阅 410 / 用户主动 unsubscribe 时调 |
| `recordPushFailure(endpoint, error)` | UPDATE last_error / last_error_at |
| `bumpPushLastSeen(endpoint)` | UPDATE last_seen_at on successful send |

## app_state 表

通用 key/value 状态。

```sql
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

### 已知 key

| key | value | 用途 |
|-----|-------|------|
| `embed_model` | e.g. `Xenova/all-MiniLM-L6-v2` | 当前 embedder 模型 id。instrumentation 启动时对比；若变化则 wipe `emails.embedding` 全部置 null（触发 Step 1.5 自愈）|
| `claude_auth_status` | `ok` / `failed` / `timeout` | Claude CLI auth 健康。**被动检测**（2026-04-29 删除定时 probe）：每次直 spawn 失败 → `lib/auth-status.flagAuthFailureIfMatch` 扫 stderr 关键词染色为 `failed`；下次成功调用 `clearAuthFailure` 翻回 `ok`。UI 在 mail.tsx 顶部 banner 显示红 alert when not `ok` |
| `claude_auth_error` | string | 最近一次失败的 stderr 片段（≤200 char）|
| `claude_auth_checked_at` | epoch sec | 最近一次状态变更时间戳 |
| `user_profile_name` | string | 用户显示名（/settings/profile）|
| `work_seed_centroid` | base64(Float32Array[384]) | Jobs ingress cosine 阈值的 fallback 种子向量（10 条 canonical 文本平均）。**当前为 work-classifier 链路最末端 fallback**——SetFit 不可用 + work-classifier 未训练时使用 |
| `work_classifier_weights` | base64(Float32Array[385]) | 旧 work-classifier (raw MiniLM + LR) 权重 + bias。**SetFit 集成后退为 fallback**——SetFit 模型文件丢失时启用 |
| `work_classifier_version` | `v{timestamp}` | 每次 trainWorkClassifier 写入；调试 / 回滚可追溯 |
| `setfit_head_runtime` | JSON | **Jobs SetFit binary head runtime override**。用户右键 "Classify as Job" → 写这个 key（warm-start retrain）。读 head 时优先这个 > web/models/setfit-work/head.json |
| `setfit_head_version` | `v{timestamp}` | 每次 trainSetfitHead 写入 |
| `setfit_classify_head_runtime` | JSON | **Inbox SetFit 4-way head runtime override**（PR #3，2026-05-07）。用户在 CategoryPicker 改分类 → /api/emails action=setCategory 触发 trainSetfitClassifyHead({warmStart:true}) → 写这个 key。读 head 时优先这个 > web/models/setfit-classify/head.json |
| `setfit_classify_head_version` | `v{timestamp}` | 每次 trainSetfitClassifyHead 写入 |
| `reclassify_started_at` | epoch sec | /api/emails action=reclassifyUnclassified 的 in-flight 锁（state-boundary PR #1）。100s freshness window；过期自愈 |
| `push_config_status` | `ok` / `missing` / `error` | VAPID 配置健康标记。`lib/push.ts` 模块加载时写入；UI 在 `/settings/notifications` 顶部读取并显示红 banner if not `ok` |
| `push_config_error` | string | VAPID 配置失败的错误片段（≤200 char）|
| `push_last_sent_at` | epoch sec | 最近一次 `sendPushToAll` 至少送出 1 条的时间戳 |
| `email_digest` | JSON | dashboard 顶部 4-section 叙事摘要的缓存。每 2h refresh with stale-check（参见 `lib/email-digest.ts`）|
| `push_last_slot_pushed_at` | epoch sec | 最近一次 push 命中的 9/15/21 PT slot。slot gate 用此 key 防止同一 slot 内重复 push |

**已废弃但 DB 可能残留**：`onboarding_completed`（onboarding 功能已移除）、`base_model_version`（base_model_centroids reader 被清除）、`daily_digest`（rename 后启动时一次性 DELETE，2026-05-02 改 `email_digest`）。新代码不读，保留不影响运行。

**非 API 暴露 key**（`work_seed_centroid` / `work_classifier_*` / `setfit_head_*` / `setfit_classify_head_*` / `push_config_*` / `push_last_sent_at` / `reclassify_started_at`）只通过服务端 `getAppState/setAppState` 读写，不在 `/api/app-state` 的 `ALLOWED_KEYS` 白名单里。

| 函数 | 说明 |
|------|------|
| `getAppState(key)` | 返回字符串或 null |
| `setAppState(key, value)` | INSERT OR UPDATE |

## eval_set 表（dev-only）

```sql
CREATE TABLE eval_set (
  email_id TEXT PRIMARY KEY,
  gold_category_id TEXT NOT NULL REFERENCES categories(id),
  added_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

`GoldLabelPicker`（仅 `NEXT_PUBLIC_DEV_TOOLS=1` 可见）写入。回归测试时跑全集对比 SetFit `predictClassifyFromEmbedding` 的预测 vs gold。

| 函数 | 说明 |
|------|------|
| `addEvalLabel(emailId, goldCategoryId)` | INSERT OR UPDATE |
| `listEvalSet()` | 全部 |
| `removeEvalLabel(emailId)` | 删除 |

## 联系人（派生自 emails）

```sql
-- 没有独立表；实时从 emails 聚合
SELECT from_email AS email, from_name AS name, COUNT(*) AS count
FROM emails WHERE from_email != ''
GROUP BY from_email ORDER BY count DESC, name ASC
```

`getContacts()` 驱动 DraftEditor 的 `to` 字段 autocomplete。

## 数据关系

```
emails.id ←── corrections.email_id    (一对多；邮件可被多次纠正)
emails.id ←── drafts.email_id         (逻辑引用；无 FK)
emails.id ←── email_attachments.email_id   (FK + CASCADE)
emails.category_id → categories.id    (逻辑引用；deleteCategory 时 SET NULL)

categories.id ←── category_examples.category_id  (FK + CASCADE)
categories.id ←── category_centroids.category_id (FK + CASCADE)
categories.id ←── eval_set.gold_category_id      (FK)
categories.base_fallback_name → base_model_centroids.category_name  (逻辑引用)

drafts.id ←── attachments.draft_id    (FK + CASCADE)

corrections.from_domain → (历史记录，当前不被分类器消费)
```

**注意事项**:
- 邮件不主动删除，所以孤儿 corrections/drafts 理论不会出现
- 草稿状态部分可逆：`cancelSchedule` 把 scheduled 改回 draft；其它终态（pushed/sent/discarded）不可逆
- `updateDraft()` 动态构建 SET 子句，只更新传入字段（undefined 跳过），追加 `updated_at = unixepoch()`

## 事务与原子性

| 操作 | 事务包裹 | 原子性 |
|------|---------|-------|
| `upsertEmails()` | ✓ | 全成功或全失败 |
| `cleanExistingBodies()` | ✓ | 全成功或全失败 |
| `deleteCategory()` | ✓ | 先清 emails.category_id 再删 category |
| `addCategoryExamplesBulk()` | ✓ | 全成功或全失败 |
| 默认分类 seed（启动时） | ✓ | 仅当 categories 表为空时执行 |
| base_fallback_name backfill（启动时） | ✓ | 对每个默认分类幂等 UPDATE |
| `updateCategories()` / `setEmailRead()` 等单语句 | SQLite 隐式事务 | 原子 |

## TypeScript 类型（types.ts）

```typescript
type Command = "digest" | "draft" | "classify" | "filter" | "inquiry"
type JobStatus = "running" | "done" | "error"

// 4 个是真正活跃的 bucket；其余为兼容旧行
type EmailCategory =
  | "primary" | "track" | "news" | "junk"
  | "log" | "feed" | "followup" | "promotion" | "noise"     // legacy
  | "academic" | "assignment" | "job" | "admin"             // legacy
  | "newsletter" | "social" | "notification" | "spam" | ""  // legacy

type DraftType = "reply" | "forward" | "new"
type DraftStatus = "draft" | "pushed" | "sent" | "discarded"   // ⚠️ 缺 "scheduled"（DB 实际会写）

interface Email {
  id; from; fromEmail?; subject; snippet; body?; bodyHtml?; date; receivedAt?
  category?; categoryId?; confidence?; classifier?;
  threadId?; isUnread?;
  needsUserConfirm?;      // 派生：0.4≤confidence≤0.7（LLM medium tier 0.55 落入此区间 → active learning 横幅）
  primaryUntil?;          // epoch sec
  ttlHint?;               // 派生："valid for Nm/h/d" 或 null
  isPriority?;            // 派生：isPriority(email) 的结果
}

interface DynamicCategory {
  id; name; description; color; icon;
  isDefault; sortOrder;
  exampleCount;                   // 派生字段，API 层计算
}
```
