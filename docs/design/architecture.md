# EmailDigest 系统架构

## 概述

EmailDigest 是一个邮件自动化工具：**IMAP 直连 Gmail 读取 UCI 学校邮件 → Inbox SetFit 4-way + LLM 双层分类 + Jobs 独立 pipeline（SetFit binary + 4 层应用归属）→ Next.js Web UI 展示 → 本地优先草稿系统**。核心技术栈：

- Next.js 16 (App Router) + React 19 + TypeScript
- better-sqlite3（WAL 模式，23 张表）
- `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2，384-d sentence embedding)
- 自训 logistic regression（385 floats）做 Jobs 子系统的二分类 gate
- `imapflow`（IMAP 直连 + IDLE）
- Claude Code CLI subprocess（用于 email-digest、inquiry、分类等 LLM 任务）
- nodemailer（可选 SMTP 发送路径）

**两个独立分类子系统 + 一个 RAG 子系统**
- **Inbox**（主页）：SetFit 任务专属 4-way classifier（`classify-embedder.ts` + `setfit-classify-head.ts`，2026-05-07 ship）→ top1 ≥ 0.80 跳过 LLM；不自信直接落 Step 2b LLM（通用 MiniLM 质心 fallback 已于 2026-05-08 退役，详见 lessons-learned §23）
- **Jobs**（`/jobs` 看板）：SetFit 任务专属 binary classifier（`work-embedder.ts` + `setfit-head.ts`，2026-05-04）→ LLM confirm → applications 追踪。Fallback：raw-MiniLM LR (`work-classifier.ts`) → cosine seed (`work-seed.ts`)
- **Ask AI**（`/ask` chat 页）：**Agentic retrieval** — Claude Sonnet 自主决定何时调 `search_emails` MCP 工具（query 由 Sonnet 翻译成英文）；多轮 chat 走 Vercel AI SDK v5 UIMessageStream (SSE)；3 个 MCP 只读工具 (`search_emails`, `read_full_email`, `get_application`)
- 三个 embedding 列正交：`emails.embedding`（通用 MiniLM，Ask AI RAG 用）/ `emails.classify_embedding`（Inbox SetFit）/ `emails.work_embedding`（Jobs SetFit）；各路径只读自己那列。Ask 从 `emails` + `job_emails` + `events` 做 JOIN 读，不回写
- 详见 [email-pipeline.md](email-pipeline.md) / [ask-rag.md](ask-rag.md)

## 邮件流入链路

```
UCI Outlook (owner@example.edu)
  → Outlook 自动转发规则 → Gmail (owner@example.com)
    → Gmail 过滤器 → label:UCI-Mail（跳过收件箱）
      → IMAP IDLE 推送 / 定时 refresh → EmailDigest
```

学校 IT 不批准第三方 Graph API 应用，因此走 Outlook→Gmail 转发绕过限制。Gmail 过滤器确保学校邮件自动打 `UCI-Mail` 标签，与个人邮件物理隔离。

**UCI Outlook 会把原始 From 头改成转发人**，真实发件人藏在 body 的 `________` 分隔块中。`lib/imap.ts` 的 `unwrapForwarded()` 负责拆解。

## 系统组件图

```
┌──────────────────────────────────────────────────────────────────┐
│  Next.js Web App (localhost:3000)                                │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Frontend         │  │  API Routes  │  │  Background        │  │
│  │  (React 19)       │  │  (/api/*)    │  │                    │  │
│  │                   │  │              │  │  prefetch.ts       │  │
│  │  / (Mail)         │  │  emails/     │  │  classify-embedder │  │
│  │                   │  │              │  │  setfit-classify-  │  │
│  │                   │  │              │  │    head            │  │
│  │                   │  │              │  │  work-embedder     │  │
│  │                   │  │              │  │  setfit-head       │  │
│  │                   │  │              │  │  work-classifier   │  │
│  │                   │  │              │  │  work-seed         │  │
│  │                   │  │              │  │  jobs-pipeline     │  │
│  │  /settings/       │  │  categories/ │  │  ttl-rules.ts      │  │
│  │    categories     │  │  contacts/   │  │  imap.ts (IDLE)    │  │
│  │                   │  │  chat/       │  │  subprocess.ts     │  │
│  │  桌面: 3-col       │  │  events/     │  │  jobs.ts           │  │
│  │  (200/380/flex)    │  │  app-state/  │  │  smtp.ts (opt)     │  │
│  │  移动: stacked +   │  │  reclassify- │  │                    │  │
│  │   MobileTabBar     │  │    all/      │  └─────┬──────────────┘  │
│  │   + overlays       │  │  run/        │        │                 │
│  │  (useIsMobile)     │  │  status/     │  ┌─────▼──────────────┐  │
│  │                   │  └──────┬───────┘  │  CLI Binary        │  │
│  │  主要组件：         │         │          │  ./emaildigest     │  │
│  │  mail.tsx          │  ┌──────▼───────┐  │   ↓ spawns         │  │
│  │  ai-panel.tsx      │  │  SQLite      │  │  claude CLI        │  │
│  │  draft-editor.tsx  │  │  (data.db)   │  │  + Gmail MCP       │  │
│  │  mail-list.tsx     │  │              │  │   (仅 pushToGmail  │  │
│  │  mail-display.tsx  │  │  23 tables:  │  │    路径使用)        │  │
│  │  category-picker   │  │  emails      │  │  + emaildigest-db  │  │
│  │  ask-page-client   │  │  email_att.  │  │    MCP             │  │
│  │  category-manager  │  │  corrections │  │   (仅 /api/chat)   │  │
│  │  gold-label (DEV)  │  │  drafts      │  └────────────────────┘  │
│  │                   │  │  attachments │                          │
│  │                   │  │  email_chunks│  │  nodemailer        │ │
│  │                   │  │  categories  │  │  (Gmail SMTP)      │ │
│  │                   │  │  cat_examples│◀─│  optional, gated   │ │
│  │                   │  │  cat_centroid│  │  by                │ │
│  │                   │  │  base_model_ │  │  GMAIL_APP_PASSWORD│ │
│  │                   │  │    centroids │  └────────────────────┘ │
│  │                   │  │  job_emails  │                          │
│  │                   │  │  applications│  ┌────────────────────┐ │
│  │                   │  │  events      │  │  imapflow          │ │
│  │                   │  │  app_state   │◀─│  imap.gmail.com:993│ │
│  │                   │  │  eval_set    │  │  IDLE + fetchRecent│ │
│  │                   │  └──────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## 核心数据流

### 1. 邮件获取与分类（prefetch pipeline）

详见 [email-pipeline.md](email-pipeline.md)。

```
startPrefetch({days=30, max=200}) / startBackfill(365d/2000封)
  Step 1: IMAP (imapflow) → UCI-Mail folder
          → simpleParser (text + html) → unwrapForwarded (text-only) → ImapEmail[]
          → upsertEmails + updateEmailThreadId（保护 classifier='user' 的行）

  Step 2a: Inbox SetFit 4-way classification
          → 对每封 category_id IS NULL AND classifier NOT IN ('user','llm')：
              embedText → updateEmailEmbedding（通用 MiniLM 384-d，Ask AI RAG 用）
              【并行】SetFit work (work-embedder + setfit-head).predict → setMaybeWork(1|0)
              【并行】SetFit classify (classify-embedder).encode → updateClassifyEmbedding
                 predictClassifyFromEmbedding → top1 ≥ 0.80 → setfit 确信命中
              → classifier='setfit', confidence=top1 实际 softmax
          → 其余进入 Step 2b llmQueue

  Step 2b: LLM 精细分类 for SetFit-uncertain 邮件
          → classifyEmailsWithLLM（readonly subprocess）
          → LLM 在 JSON 输出里 self-rate confidence: "high" | "medium" | "low"
          → mapLLMConfidence 映射到 (numeric, source, trainable)：
              high   → 0.9,  llm_high_conf (weight 25), trainable
              medium → 0.55, llm_med_conf  (weight 5),  trainable，落入 needsUserConfirm 区间
              low    → 0.3,  llm_low_conf,              **不**回灌
          → classifier='llm', confidence 写映射后的 numeric
          → trainable tier 回灌 category_examples 作为 SetFit head warm-start 训练样本

  Step 3: Jobs pipeline（独立子系统，本 session 重写）← 详见 email-pipeline.md
          → drainMaybeWorkQueue()：取 maybe_work=1 AND NOT IN (job_emails ∪ job_skipped)
          → llmConfirmBatch(chunks of 20): is_job bool + 抽取字段
              is_job=false → markJobSkipped(reason)
              is_job=true → resolveApplication 四层匹配:
                A. thread_id → job_emails 查
                B. sender domain → application_domains 唯一命中
                C. normalize(company,role) → applications 查 / 建
                D. fuzzy: 同 company 下 role levenshtein<3 → 同一条
              → upsertJobEmail + setJobEmailApplicationId
                + recomputeApplicationFromEmails(刷新卡片快照)

IMAP IDLE (lib/imap.ts startIdleListener)
  → 独立长连接监听 UCI-Mail 的 exists 事件
  → 新邮件到达 → 触发 startPrefetch()（防重入锁自动去重）
  → 断线 5s 后自动重连
```

**Inbox 和 Jobs 的关系**：两条管线**embedding 列完全正交** — Inbox 用 `emails.classify_embedding`（SetFit 4-way 专属，2026-05-07 起；SetFit 不自信直接落 LLM，无 centroid fallback）；Jobs 用 `emails.work_embedding`（SetFit binary 专属，2026-05-04 起）；`emails.embedding`（通用 MiniLM）只供 Ask AI RAG 读。三个向量同一封邮件并行编码并各自缓存。**Inbox → Jobs 三个连接点**：(1) Step 2a 串行编码 SetFit work + 打 `maybe_work` 标记（自动路径，依赖 work-embedder + setfit-head；SetFit 不可用时 fallback 到 raw-MiniLM 的 work-classifier）；(2) Step 2a 的 **L1.5 thread 短路**（`jobThreadIds.has(thread_id)` 时强制 `maybe_work=1`，跳过整个 ML gate，解决线程续封被 ML 拦下的漏判）；(3) Inbox 右键 / 长按菜单的 **"Classify as Job related"**（用户显式路径，`forceClassifyAsJob` 绕过 is_job gate，直接跑字段抽取 + `resolveApplication`，同时 warm-start retrain SetFit head）。Inbox 不读 `maybe_work` / `job_emails` / `applications` / `work_embedding`。Jobs 也不改 `emails.category_id` / `classifier` / `embedding` / `classify_embedding`。

### 2. 前端展示

详见 [frontend.md](frontend.md)。

桌面（≥ 768px）：
```
mail.tsx (根组件，三栏 grid)
  ├── 左栏: MailNav (200px) — 视图切换 + Compose + Settings link
  ├── 中栏: MailList / DraftList (380px) — 按 view 切换
  └── 右栏: DraftEditor / MailDisplay / AIPanel (flex-1) — 优先级匹配
```

移动（< 768px）：
```
mail.tsx
  ├── 内容区 (flex-1) — 按 mobileTab 切换 dashboard/inbox/drafts/ask
  ├── MobileTabBar (h-14, safe-area-pb) — 4 tab，URL 持久化
  └── 全屏 overlay (fixed inset-0 z-50)
       ├── selectedMail → MailDisplay (含 Back 按钮)
       ├── selectedDraft → DraftEditor (编辑模式)
       └── composing → DraftEditor (compose=true)
```

**Inbox 三 Tab**（都显示未读计数）：
- **Priority**：Primary 类 + `primary_until` 有效（临时 TTL 升级）
- **Other**：非 Priority 的非-Junk 未读
- **All**：所有非-Junk 邮件

Junk 永远不在这三个 tab 中，需从 Dashboard 点分类卡片访问。

**Conversation 视图（thread stack）**：`MailDisplay` 检测到所选邮件有 ≥ 2 封同 `thread_id` 的兄弟邮件时，切换到 Gmail-style 会话栈 — **按 `received_at DESC` 倒序排列**，最新一封在顶部默认展开（带 `isLatest` 蓝色高亮边），旧邮件向下折叠为一行 snippet preview，点击展开时 lazy fetch 完整 body。详见 [frontend.md 的 `mail-display.tsx` 小节](frontend.md#mail-displaytsx--邮件详情)。

**UX 契约**：所有 ≥ 3s 的 AI 操作显示 `{阶段}·{remaining}s` 倒计时。AI Generate / Push to Gmail / Ask AI 均通过 `pollJob()` 或 `useJob()` 提供倒计时。

### 3. 草稿系统

详见 [draft-system.md](draft-system.md)。

```
用户点击 Reply/Forward (或 Compose 新邮件)
  → 本地 SQLite 创建草稿 (status=draft) + AutoSave 每 2s
  → 编辑 → 可选 AI 生成/润色（readonly 模式，120s 倒计时）
  → 三条出口（互斥）：
     A. Push to Gmail (status=pushed) → subprocess full 模式 → gmail_create_draft
        → 60s 倒计时；用户在 Gmail UI 手动发送
     B. Send via SMTP (status=sent) → smtp.ts → nodemailer 直接发送
        → 必须 userConfirmedDirectSend=true + GMAIL_APP_PASSWORD 配置
        → 10s undo 窗口
     C. Schedule (status=scheduled, scheduled_at=epoch)
        → instrumentation.ts 每 60s 扫 getScheduledDraftsDue → SMTP 发送
        → cancelSchedule 回 draft
  → 任意时刻可 Discard (status=discarded) 或 Delete (硬删除)
```

### 4. 分类纠错反馈

```
用户在 CategoryPicker 纠正分类（右键 / 下拉）
  → updateCategories(ids, newCategory, "user") + insertCorrection(..)
  → classifier='user' 保护该行不被未来 prefetch 覆写
  → addCategoryExample(source='user_correction', weight=50) 写入新类训练样本
  → 旧类 removeEmailExampleFromCategory（防止 SetFit head 继续在错标签上训练）
  → queueMicrotask trainSetfitClassifyHead({warmStart:true})（50 轮 LR retrain on cached classify_embedding）
  → 下次 prefetch Step 2b LLM 走 getRecentCorrections(10) 作为 few-shot context

用户在 MailDisplay 点 Active Learning "Confirm" 按钮（needsUserConfirm 时）
  → POST /api/categories/{id}/examples action=add source=user_correction
  → 该邮件的 embedding 作为正样本入库 + warm-start retrain
```

### 5. 用户添加/管理分类

```
/settings/categories (CategoryManager)
  → 列出 categories + 每分类 exampleCount
  → Add/Edit 模态：name + description + icon
    + Email picker 多选 5-10 封种子邮件（filter by 发件人/主题）
  → POST /api/categories action=create
    → upsertCategory → 对每个 exampleId 计算 embedding
    → addCategoryExample(source=user_correction) × N
    → trainSetfitClassifyHead({warmStart:true})（吸收新种子样本）
  → Edit 模式：ExistingExamples 组件，按 source 分组，可单独 remove
```

## CLI 命令架构

`./emaildigest <command> [args]` 是一个 shell 脚本入口，执行流程：

```
emaildigest
  → source config.sh      # 加载配置变量
  → source lib/common.sh  # 加载 run_claude(), parse_common_args() 等
  → check_dependencies    # 验证 claude CLI 和 jq 已安装
  → case $command in
      digest)   source commands/digest.sh "$@"     ;;
      classify) source commands/classify.sh "$@"   ;;
      inquiry)  source commands/inquiry.sh "$@"    ;;
      setup)    do_setup                            ;;
    esac
```

### config.sh 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EMAILDIGEST_MODEL` | `"sonnet"` | Claude 模型 |
| `EMAILDIGEST_DEFAULT_HOURS` | `24` | 搜索回溯小时数 |
| `EMAILDIGEST_MAX_BUDGET` | `"100.00"` | 单次调用 USD 上限 |
| `EMAILDIGEST_LOG_DIR` | `$SCRIPT_DIR/logs` | 日志目录 |
| `EMAILDIGEST_CATEGORIES` | legacy 9 类 | 与 Web UI 的动态分类无关（仅 CLI 使用） |
| `EMAILDIGEST_CRON_DIGEST` | `"0 8 * * 1-5"` | 工作日早 8 点摘要 |
| `EMAILDIGEST_CRON_CLASSIFY` | `"0 */6 * * *"` | 每 6 小时分类 |

### 命令用途

| 命令 | 用途 | 工具权限 | 参数 |
|------|------|---------|------|
| `inquiry` | 自然语言问答（Web 端各种 AI 任务都走这个） | 按 `EMAILDIGEST_READONLY` 切换 | 问题文本 |
| `digest` | 未读邮件摘要（legacy cron 用） | 完整 | --hours N, --budget N |
| `classify` | 批量分类（legacy cron 用） | 完整 | --hours N |

> **历史命令已删除（2026-05-07）**：`draft.sh` 和 `filter.sh` 移除 — Web 端走 `web/lib/draft-gen.ts` 直 spawn 替代，filter 功能未在 Web 暴露。

每个命令 shell 脚本调用 `parse_common_args "$@"` 解析 `--hours` 和 `--budget`，然后 `get_search_date "$HOURS"` 生成 Gmail 搜索日期（macOS 用 `date -v`，Linux 用 `date -d`），最后调用 `run_claude()`.

### Ask AI / Chat（/api/chat）

独立端点，**不经** `inquiry` 命令。**Agentic retrieval**：/api/chat 不做上游 RAG，Claude Sonnet 自主决定何时调 `search_emails` 工具。

```
POST /api/chat { messages, sid? }
  → spawn("claude",
      --model sonnet
      --resume <sid?>
      --output-format stream-json
      --include-partial-messages
      --mcp-config .mcp.json              # 显式加载，绕过信任提示
      --strict-mcp-config
      --permission-mode bypassPermissions
      --append-system-prompt-file ask.txt
      -p <user query>
    )
  → readline stdout → transform 为 Vercel AI SDK v5 UIMessageStream (SSE)
  → Content-Type: text/event-stream; data: {json}\n\n
  → 前端 useChat() (@ai-sdk/react) 原生消费
```

**系统 prompt 要点**（`web/lib/prompts/ask.txt`）：
- 英文 embedder → Claude 必须把中文 query **翻译成英文关键词+同义词**再调 search_emails
- 闲聊不调工具（节省 token）
- 引用格式 `[#<前 8 位 id>]`，前端正则抽取渲染胶囊

**MCP 服务**（`.mcp.json`，项目级）：`mcp-server/server.ts` 暴露 3 个只读工具：
- `search_emails(query, max_results?)` — 调 `/api/internal/rag-search`（localhost-only，middleware 豁免 auth），走 `retrieveRelevant()` cos ≥ 0.30 + cap 100
- `read_full_email(id)` — 按主键取完整 body + 元数据
- `get_application(id)` — job application 聚合（company/role/stage/邮件历史）

**禁止**暴露 list/query 类通用工具（防 Claude 绕过 RAG）。

详见 [ask-rag.md](ask-rag.md)。

### Web 端 subprocess 用途

Web 端 `inquiry` 命令（通过不同 prompt 实现各种任务）和独立 `/api/chat` 端点：

| 调用点 | readonly | 任务 |
|--------|---------|------|
| prefetch Step 2b | ✓ | Inbox LLM 精细分类 + 回灌 category_examples |
| prefetch Step 3 / drainMaybeWorkQueue | ✓ | Jobs `llmConfirmBatch`: is_job + 字段抽取 |
| `/api/jobs action=forceClassifyAsJob`（右键 Classify as Job related） | ✓ | `forceClassifySingleEmail`：绕过 is_job gate，只跑字段抽取 (`EXTRACT_PROMPT_HEADER`) + `resolveApplication` |
| `scripts/label-work-corpus.ts` | ✓ | Work classifier bootstrap 批量打标 |
| `/api/emails action=reclassify` | ✓ | 指定邮件重新分类 |
| `/api/drafts action=aiGenerate` | ✓ | 生成回复 / 润色 compose |
| `/api/drafts action=pushToGmail` | **✗ full** | gmail_create_draft |
| AIPanel Quick actions | ✓ | Deadlines (digest 命令) / Follow-ups |
| AIPanel Ask AI | — | **已迁移到 `/api/chat` + `/ask` 页**（本 session 重构）；不再走 inquiry |
| `/api/chat` (`/ask` page) | ✓ | 本地 RAG + Sonnet + 多轮 + SSE 流式；MCP 挂 2 个 read-only 工具 |

**绕过 subprocess.ts 的成本优化路径**（直 spawn `claude -p` + `cwd: os.tmpdir()`，跳过 CLAUDE.md auto-load）：

| 调用点 | 模型 | 任务 |
|--------|------|------|
| `lib/draft-gen.ts` | Sonnet (env override) | Reply / Forward / Compose 草稿生成（用户交互，免 breaker）|
| `lib/email-digest.ts` | Sonnet | 4-section 叙事摘要 + push_summary（2h stale-check + 9/15/21 PT push slot gate）|
| `lib/event-extractor.ts` | **Haiku 4.5** | 日历事件结构化抽取，**手动触发批量**（`/calendar` Scan inbox 按钮 → 单 spawn 处理 ≤50 封邮件）|

### run_claude() 执行链

```
run_claude(prompt, prompt_file, budget, output_format)
  → 构建 claude CLI 命令:
      claude -p "$prompt"
        --model "$EMAILDIGEST_MODEL"
        --max-budget-usd "$budget"
        --allowedTools "$tools"           # readonly 或 full
        --append-system-prompt safety.txt  # 第一次追加：安全规则
        --append-system-prompt $prompt_file # 第二次追加：命令 prompt
  → 日志写入 $EMAILDIGEST_LOG_DIR/YYYY-MM-DD.log
  → output_format=json 时通过 jq 提取 .result
```

### 工具权限控制

`lib/common.sh` 定义两组 Gmail MCP 工具列表：

- **readonly**（6 个）：gmail_search_messages / gmail_read_message / gmail_read_thread / gmail_get_profile / gmail_list_labels / gmail_list_drafts
- **full**（7 个）：readonly + gmail_create_draft

`EMAILDIGEST_READONLY=1` 环境变量时使用 readonly 集合。Web 端 `subprocess.ts` 通过 `opts.readonly` 参数控制，shell 脚本通过 env 变量感知。

### 安全规则（safety.txt）

6 条规则通过 `--append-system-prompt` 注入所有命令：

1. 绝不直接发送邮件，只能创建草稿
2. 不删除任何邮件
3. 搜索必须含 `label:UCI-Mail`
4. 不访问密码/密钥
5. 不确定时不执行
6. 中文回复（除非原文其他语言）

详见 [security.md](security.md)。

## EMAILDIGEST_DIR 路径解析

Web 端的 `subprocess.ts` 和 `db.ts` 使用相同解析：

```
EMAILDIGEST_DIR = process.env.EMAILDIGEST_DIR || path.join(process.cwd(), "..")
DB_PATH = path.join(EMAILDIGEST_DIR, "data.db")
ATTACHMENTS_ROOT = path.join(EMAILDIGEST_DIR, "attachments")
```

`process.cwd()` 在 Next.js 中是 `web/` 目录，所以 `..` 指向项目根目录。

## Job 生命周期

所有 AI 操作（reclassify、pushToGmail、aiGenerate、Ask AI 的 Dashboard quick actions）通过 `jobs.ts` 管理内存中的 job store：

```
createJob(command)
  → id: j_{timestamp}_{command}_{4 位 base-36}
  → status: "running", startedAt: Date.now()
  → 存入 Map<string, Job>

updateJob(id, {status, result, error, finishedAt})
  → Object.assign 合并到已有 job

getJob(id) → 查询
isCommandRunning(command) → 遍历检查同命令是否有 running job

清理: setInterval 每 10 分钟（600,000ms）删除 status≠running 且 startedAt 超过 1 小时的 job
```

**并发控制**：`POST /api/run` 在启动前检查 `isCommandRunning(command)`，同命令同时只能运行一个，返回 409。但 API 内部的 subprocess 调用（pushToGmail / aiGenerate 等都用 `inquiry` 命令）不做此检查，可能并发。

## 启动序列 (instrumentation.ts)

Next.js `register()` hook，仅 `NEXT_RUNTIME === "nodejs"` 时执行：

```
1. cleanExistingBodies(stripLLMContamination)
   → 事务内遍历所有 body≠'' 的邮件，重新清洗
   → 幂等，修复历史 LLM 污染（IMAP 抓的新邮件无此问题）
   → 若清洗到任何行则打印 "Cleaned N contaminated email bodies"

2. getEmailCount() → count；打印 "Database has {count} emails"

3. if (count === 0) startBackfill()
   → 365 天 / 2000 封一次拉满，异步，不阻塞服务器启动

4. if (isImapConfigured()) startIdleListener(() => startPrefetch())
   → 建立 IDLE 长连接，断线自动 5s 重连

5. setInterval(60_000): scheduled drafts cron
   → 要求 isSmtpConfigured()
   → getScheduledDraftsDue(now) → sendEmail(..., includeSignature=true) → markDraftSent
   → 失败只 console.error，下一分钟重试（无断路器）

6. setInterval(60_000): email-digest stale check (≥2h since last gen + new mail since)
   → ensureDailyDigest()：若 isDailyDigestStale() (上次生成时间早于最近 9/15/21 PT slot)
     → 重生成 digest（直接 spawn `claude -p`，circuit breaker 把关）
     → 末尾 fire-and-forget triggerPushIfReady(digest) → sendPushToAll if push_summary 非空
```

## PWA + Web Push 通知系统

EmailDigest 是 **可安装 PWA**（Add to Home Screen）+ **Web Push** 通知。email-digest 数据每 2h refresh，但 push 仅在跨过 9/15/21 PT 边界时触发一次（最多 3 次/天），由 `push_last_slot_pushed_at` app_state key 防重复。若 digest `push_summary` 为空字符串则不发送。

| 组件 | 文件 | 角色 |
|---|---|---|
| Manifest | `web/public/manifest.json` | `display:standalone`, theme/background `#0a0a0a`, 192/512 icons |
| Service Worker | `web/public/sw.js` | install 预缓存 shell；fetch SWR 静态资源；push 含 `clients.matchAll({visibilityState:'visible'})` 前台抑制；notificationclick focus 已开窗口或 openWindow |
| SW 注册 | `web/components/pwa/sw-register.tsx` | 客户端组件，挂在 `app/layout.tsx` body，`navigator.serviceWorker.register('/sw.js')` |
| iOS 软提示 | `web/components/pwa/install-hint.tsx` | Dashboard 顶部黄 banner（`mobile && iOS && !standalone && !localStorage["pwa-install-dismissed"]`）|
| 订阅 hook | `web/lib/hooks/usePushSubscription.ts` | 封装 `pushManager.getSubscription/subscribe/unsubscribe` + 上报 server |
| Server config | `web/lib/push.ts` | 加载 `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`；写 `app_state.push_config_status`；`sendPushToAll(payload)` 遍历 `push_subscriptions`，410 → 自动删 |
| 设置页 | `web/app/settings/notifications/page.tsx` + `web/components/settings/notifications-form.tsx` | VAPID-missing 红 banner / iOS 装主屏 hard gate / Enable-Disable toggle / 测试推送 / 订阅统计 |
| API 路由 | `/api/push/{vapid-key,subscribe,unsubscribe,test,status}` | 各路由未配 VAPID 时返回 503 |
| Middleware 豁免 | `web/middleware.ts` | `/manifest.json` / `/sw.js` / icon `*.png` / `/login` 不需 token |
| Push 触发 | `web/lib/email-digest.ts triggerPushIfReady` | digest 写入后 fire-and-forget；slot gate 用 `push_last_slot_pushed_at` 限频；`push_summary` 为空字符串时不发 |

**数据流**（订阅）：用户 `/settings/notifications` 点 Enable → 浏览器 `Notification.requestPermission` → `pushManager.subscribe(VAPID public)` → 上报 `/api/push/subscribe` → `addPushSubscription` 入 `push_subscriptions` 表。

**数据流**（推送）：digest 重生成 → `push_summary` 是 LLM 返回的第 5 个 JSON 字段（约定空字符串=不发）→ `triggerPushIfReady` 调 `sendPushToAll({title, body, tag:digest-{slot}, url:"/"})`→ `web-push` 库走 VAPID 协议到各 push service（FCM / Mozilla / Apple's `web.push.apple.com` → APNs bridge）→ 设备 SW 收到 push event → 前台抑制检查 → `showNotification`。

**iOS 限制**：iOS 16.4+ 才支持 Web Push，且**只在 standalone PWA 模式下**生效（Safari 浏览器内的 `Notification.requestPermission` 直接返回 denied）。两层 UX：Dashboard soft banner（发现路径，可 dismiss）+ 设置页 hard gate（toggle 在非 standalone 时 disabled，强制走装主屏路径）。

**VAPID 缺失降级**：`.env.local` 没配 VAPID 时，`/api/push/*` 全部返回 503，`/settings/notifications` 顶部红 banner，主进程 startup log warning。app 不崩，只是 push 静默关闭。

详见 [database.md `push_subscriptions` 表](database.md#push_subscriptions-表) 和 [security.md push 攻击面](security.md)。

## Circuit Breaker — Claude CLI 失败保护

`web/lib/circuit-breaker.ts` 提供进程内 3 状态熔断器（closed / open / half-open）保护频繁失败的 Claude CLI 调用，防止"上游短时 5xx + 无脑重试"导致 retry storm（历史曾产生 1213 个 jsonl + 大量 exit 1 stale process）。

| 状态 | 含义 | 转换 |
|---|---|---|
| closed | 正常 | 连续 `recordFailure` × 3 → open |
| open | 拒绝所有调用，立即 throw `BreakerOpenError` | 等 5 分钟 → half-open |
| half-open | 放行单次 retry | success → closed；fail → open，下次 wait 翻倍直到 30min cap |

**调用点**：
- `web/lib/subprocess.ts runCommand/execCommand` — 默认所有 `./emaildigest inquiry` 路径过 breaker
- `web/lib/email-digest.ts runClaudeBare` — 直 spawn `claude -p` 路径 + `cwd: os.tmpdir()`（不走 subprocess.ts），单独同样过 breaker
- `web/lib/event-extractor.ts spawnHaikuExtract` — 直 spawn `claude -p --model haiku` + `cwd: os.tmpdir()`（成本优化路径，仅 `/calendar` Scan inbox 按钮触发，单 spawn 批量处理；详见 [email-pipeline.md Calendar 事件抽取](email-pipeline.md#calendar-事件抽取-event-extractorts--time-signalts)），同样过 breaker
- `web/lib/draft-gen.ts generateDraft` — 直 spawn `claude -p` + `cwd: os.tmpdir()`，**不**过 breaker（用户交互路径，breaker 关掉时也要让用户能写草稿）
- **豁免**：`forceClassifyAsJob`（用户显式意图，绝对优先级）。历史上还有一个定时 auth probe，每 30 min 跑一次 `inquiry` 调用探测 OAuth token；2026-04-29 删除 — 改走 `lib/auth-status.ts` 被动检测：每个直 spawn 路径在非零 exit 时 `flagAuthFailureIfMatch` 染色 `claude_auth_status`，下次成功调用 `clearAuthFailure` 翻回 ok

状态 in-process 维护，进程重启自动 reset。breaker 状态不写 DB（短时故障不需要持久化）。

| 层级 | 策略 |
|------|------|
| API 路由 | 外层 try-catch，JSON parse 失败 400，未知 action 400，内部错误 500 |
| Subprocess | 非零退出 → status="error" + stderr；spawn 错误 → error.message |
| Prefetch | 每步独立 try-catch，单封邮件失败不中断整批；IMAP 失败时外层 catch 释放重入锁 |
| ML 分类（embedder + classifier） | 单封失败只 log，不影响其他；`needsLLM=true` 时 Step 3 整体 try-catch，失败保留 Step 2 结果 |
| Job 轮询 | 前端 useJob / pollJob 失败只 console.error，不中断；非 running 状态时自动停止轮询 |
| JSON 解析 | parseJsonObject/Array 移除 markdown 围栏后匹配 `[{...}]` / `{...}`，解析失败返回 `null` / `[]` |
| Scheduled cron | 单草稿发送失败 console.error，下一分钟再试，**无断路器** |

## 触发机制

| 触发方式 | 触发源 | 说明 |
|----------|--------|------|
| 服务器启动 | `instrumentation.ts` | DB 为空时自动 `startBackfill()`；同时启动 IMAP IDLE + scheduled drafts cron |
| IMAP IDLE | `lib/imap.ts startIdleListener` | UCI-Mail folder exists 事件 → 立即 `startPrefetch()` |
| 前端手动刷新 / 轮询 | POST `/api/emails action=refresh` | `startPrefetch()`；mail.tsx 每 60s 自动触发 |
| Scheduled draft cron | `instrumentation.ts` 内 `setInterval(60s)` | `getScheduledDraftsDue(now)` → SMTP 发送 |
| Legacy cron (CLI) | `cron/setup.sh` | 工作日 8AM digest + 每 6h classify（CLI 场景，与 Web 无关） |

## 文件结构

```
EmailDigest/
├── emaildigest              # CLI 入口（shell 脚本）
├── config.sh                # 配置
├── data.db                  # SQLite 数据库（+ data.db-wal + data.db-shm）
├── attachments/             # 草稿附件磁盘存储
│   └── {draft_id}/{timestamp}_{safename}
├── lib/                     # CLI 侧
│   ├── common.sh            # run_claude() + 工具权限
│   ├── safety.txt           # 7 条安全规则
│   └── prompts/             # 3 个 CLI 命令的 system prompt（inquiry / digest / classify）
├── commands/                # 3 个命令的执行脚本（draft.sh / filter.sh 已于 2026-05-07 移除）
├── cron/                    # Legacy cron 调度（CLI 场景）
├── docs/design/             # 6 份设计文档
└── web/                     # Next.js 应用
    ├── app/
    │   ├── page.tsx         # 主 Mail UI
    │   ├── layout.tsx       # HTML layout (dark mode, 中文 locale)
    │   ├── settings/        # 设置页
    │   │   └── categories/  # 分类管理
    │   └── api/
    │       ├── emails/              # 邮件 CRUD + reclassify + eval
    │       ├── emails/[id]/         # 单封邮件
    │       ├── emails/[id]/attachments/ # 入站附件列表 + 下载
    │       ├── emails/digest/       # 4-section 叙事摘要（9/15/21 PT slots, thread-dedup + stripQuotedReply）
    │       ├── drafts/              # 草稿 CRUD + push + AI gen + sendNow + scheduleSend
    │       ├── drafts/[id]/attachments/ # 草稿附件
    │       ├── categories/          # 动态分类 CRUD
    │       ├── categories/[id]/examples/ # 分类样本（用户 confirm / settings）
    │       ├── chat/                # Ask AI SSE endpoint（@ai-sdk/react useChat）
    │       ├── chat/history/        # GET 列出会话；[sid] GET 加载 jsonl / DELETE 删
    │       ├── internal/rag-search/ # localhost-only，MCP search_emails 调
    │       ├── events/              # 日历事件 CRUD + scanInbox
    │       ├── jobs/                # Jobs 看板 CRUD
    │       ├── jobs/applications/   # applications 聚合 CRUD + merge / [id] / [id]/split
    │       ├── app-state/           # 白名单 key/value（user_profile_name 等）
    │       ├── contacts/            # autocomplete
    │       ├── run/                 # 启动 subprocess
    │       └── status/              # 轮询 job 状态
    ├── components/
    │   ├── mail/                    # 业务组件
    │   │   ├── mail.tsx / mail-nav.tsx / mail-list.tsx / mail-display.tsx
    │   │   ├── conversation-email.tsx # Gmail-style thread stack cell (lazy body fetch)
    │   │   ├── ai-panel.tsx / draft-editor.tsx / draft-list.tsx
    │   │   ├── category-picker.tsx / email-side-panel.tsx
    │   │   ├── email-body-view.tsx / attachments-list.tsx
    │   │   ├── gold-label-picker.tsx # DEV-only (NEXT_PUBLIC_DEV_TOOLS=1)
    │   │   └── use-mail.ts          # Jotai atoms + useCategories
    │   ├── ask/ask-page-client.tsx  # /ask chat page
    │   ├── calendar/calendar-page-client.tsx
    │   ├── settings/category-manager.tsx
    │   └── ui/                      # shadcn/ui 基础组件
    ├── instrumentation.ts           # 启动序列（含 ensureWorkSeed）
    └── lib/
        ├── db.ts                  # 全部 schema + CRUD（含 logs 表 7 天保留）
        ├── logger.ts              # 结构化日志（stdout + SQLite 双写）；trace_id 跨 step 关联；详见 docs/design/logging.md
        ├── subprocess.ts          # execCommand / runCommand (含 readonly env)
        ├── jobs.ts                # 内存 job store
        ├── prefetch.ts            # 8 步邮件获取管线 + startBackfill
        ├── classify-embedder.ts   # Inbox 唯一非 LLM 分类器：SetFit ONNX encoder + 4-way LR head（web/models/setfit-classify/）
        ├── setfit-classify-head.ts # Inbox：runtime warm-start 4-class LR retrain on cached classify_embedding
        ├── embedder.ts            # 通用 MiniLM 句向量 + cosine（仅 Ask AI RAG 用；centroid 已退役）
        ├── chunker.ts             # 邮件 body chunker for RAG（~400 字，段落→句子贪婪装箱）
        ├── work-seed.ts           # Jobs ingress fallback 末端：cosine to canonical seed centroid
        ├── work-classifier.ts     # Jobs raw-MiniLM LR fallback：SetFit 模型不可用时启用
        ├── work-embedder.ts       # Jobs 主路径：SetFit ONNX encoder + LR head 加载（web/models/setfit-work/）
        ├── setfit-head.ts         # Jobs 主路径：runtime warm-start LR retrain on cached work_embedding
        ├── jobs-pipeline.ts       # Jobs Step 1 LLM confirm + 4 层归属
        ├── applications.ts        # applications 聚合 + normalize + merge / split / rename
        ├── job-classify.ts        # [已去硬规则] 仅 throw stub 防止 stale import
        ├── job-helpers.ts         # Jobs 看板渲染 helpers
        ├── llm-classify.ts        # Inbox Step 2b LLM 分类调用
        ├── draft-gen.ts           # 直 `claude -p` spawn（bypass shell/MCP）for draft AI
        ├── draft-prompts.ts       # reply / forward / compose prompt 构建
        ├── email-digest.ts        # lazy-stale 48h 叙事摘要（Dashboard 顶部；2h stale-check + 9/15/21 PT push slot gate；thread-dedup SQL + stripQuotedReply 防 inline 引用污染）
        ├── reply-quote.ts         # stripQuotedReply：从 body 剥 inline quoted-reply 历史（目前供 email-digest 用，设计为可复用）
        ├── event-extractor.ts     # LLM 事件抽取，extractEventsForBatch 单 spawn 批量（Haiku 4.5 直 spawn + cwd=tmpdir，绕开 CLAUDE.md auto-load；仅 /calendar Scan inbox 按钮触发；入口含 hasTimeSignal 2-of-3 gate）
        ├── time-signal.ts         # event_extractor regex gate：hasTimeSignal(email)
        ├── time-patterns.ts       # TIME_RE / EXPLICIT_DATE_RE / MONTH_DAY_RE / CHINESE_DATE_RE 共享常量
        ├── email-helpers.ts       # 共享展示 helpers
        ├── ttl-rules.ts           # inferPrimaryUntil: Rule 1a auth 30m / 2 same-day EOD / 3 explicit date / 1b pickup-bill 24h
        ├── imap.ts                # IMAP 直连 + IDLE + unwrapForwarded
        ├── smtp.ts                # nodemailer (可选 SMTP)
        ├── sanitize.ts            # LLM 清洗 + HTML 安全过滤
        ├── parse.ts               # JSON 解析工具（不抛异常）
        ├── types.ts               # TypeScript 类型定义
        ├── utils.ts               # cn / getBadgeVariant / isPriority / isOther
        ├── category-helpers.ts    # slugify + getOrCreateEmailEmbedding
        ├── category-icons.tsx     # Lucide icon 白名单 + 映射
        ├── email-body.ts         # parseEmailBody / cleanSnippet
        ├── email-date.ts         # formatEmailDate
        └── hooks/
            ├── useJob.ts      # job 轮询 + pollJob + formatCountdown
            └── useMobile.ts   # 768px 媒体查询
```
