# Ask AI — 本地 RAG + 多轮 Chat

## 概述

`/ask` 页面是一个 **本地优先的 chatbot**：用户问题 → MiniLM 语义检索本地 SQLite → Claude Sonnet（via CLI）流式回答。**不再打 Gmail MCP live search**；Gmail 数据通过 prefetch 管线已入 `data.db`，Ask AI 从本地读即可。

与 Dashboard 顶部 email-digest（4-section 48h 叙事摘要）正交：digest 是预生成的当下状态摘要；Ask 是按语义按需检索的动态问答。

## 设计决策

| 选择 | 原因 |
|---|---|
| **本地 SQLite RAG**（不走 Gmail MCP live search） | 减少 Gmail API 往返 → 延迟从 5-30s 降到 2-5s；成本零（embedding 本机算） |
| **Agentic retrieval**（Claude 决定何时调 search_emails） | 闲聊不消耗 RAG token；对不需要 inbox 的问题直接答；对多意图问题可多轮检索 |
| **英文 embedder** `all-MiniLM-L6-v2` + **Claude 做 query 翻译** | 99% 英文邮件用英文模型精度最高；跨语言由 Sonnet 在调 tool 前翻译 query（中文→英文同义词扩展）。比多语言模型更可控、更准 |
| **余弦相似度阈值 + 软上限**（不是固定 top-K） | K 固定会切掉尾部相关，塞全部会稀释 LLM 注意力；阈值 + cap 是折衷 |
| **阈值经验校准**（validate-rag.ts） | 不拍脑袋 — 跑 15 条合成 query 看分布定阈值 |
| **Claude CLI**（不用 Anthropic SDK） | 复用 Max/Pro 订阅额度，零 API token 计费 |
| **Sonnet 模型** | Haiku 对复杂推理精度不足，Sonnet 默认 |
| **`--resume SESSION_ID`** 多轮 | CLI 官方 session 机制，免写自家 history 协议 |
| **stream-json → Vercel AI SDK v5 UIMessageStream (SSE)** | `text/event-stream` + `data: {json}\n\n` 帧；前端 `useChat()` + `DefaultChatTransport` 原生消费；工具调用是一等事件（不是 hack 的 meta prefix）|
| **3 个 MCP 工具**（search_emails + read_full_email + get_application） | Agentic RAG 入口 + 深查；`search_emails` 封装在 narrow 语义搜索里（不是裸 SQL），仍防止 Claude 做全表瞎扫 |
| **新建 `/ask` 独立页面**（不在 Dashboard inline） | Chat 需要垂直空间 + 消息列表；Dashboard 保持卡片轻量 |

## 检索（lib/ask/retrieve.ts）

### Chunk 池构建

邮件 body 不再整封 embed 成一个向量（MiniLM 的 256 token 上限 + mean-pooling 稀释会让长邮件中段关键信息失效）。每封邮件的 body 被 `lib/chunker.ts` 切成 ~400 字的 chunks，每块独立 embed 存入 `email_chunks` 表。

Retrieval 时扫所有 chunks，按 email_id dedupe 保留最高 cosine 的那块作为该邮件的代表：

```sql
SELECT c.*, e.received_at, e.subject, e.from_name, e.from_email, e.date,
       e.category_id, e.is_unread, e.primary_until, e.classifier
FROM email_chunks c
JOIN emails e ON e.id = c.email_id
WHERE e.body != ''
  AND e.received_at > unixepoch() - 180*86400
  AND (e.category_id != 'cat_junk' OR e.category_id IS NULL)
ORDER BY e.received_at DESC
LIMIT 1000 * 6     -- POOL_SIZE × 最多 chunk/邮件
```

### 相似度过滤 + dedupe

- 每 chunk `cosine(embedText(query), chunk.embedding)`
- 按 email_id 分组取最高分 chunk
- 保留 `cos ≥ SIMILARITY_THRESHOLD`（当前 **0.35**，chunk 粒度 cosine 比整邮件分布更高）
- 按相似度降序取前 `MAX_HITS = 100`
- 返回 payload 里 `body_excerpt` = 最佳 chunk 的 `chunk_text`（不是邮件前 300 字），`chunk_idx` 标明是哪段命中

### 阈值（经 validate-rag.ts 校准）

**初始**：`THRESHOLD = 0.35`  
**校准策略**：对 15 条合成 query 跑 cos ∈ {0.20, 0.25, 0.30, 0.35, 0.40, 0.45}，看每阈值下命中数 / 相似度分布 / top-10 人工相关性，定最终值。脚本输出保留在 `scripts/validate-rag-output.md` 作审计痕迹。

### 返回结构

```ts
interface RetrieveResult {
  stats: {
    pool_size: number;      // e.g. 847
    hit_count: number;      // e.g. 42
    threshold: number;
    mean_similarity: number;
    max_similarity: number;
    min_similarity: number;
  };
  hits: Array<{
    id: string;
    date: string;
    from: string;
    subject: string;
    body_excerpt: string;   // first 500 chars
    category: string;
    is_unread: boolean;
    primary_until: string | null;
    job: { stage, company, role, deadline, needs_action, ... } | null;
    event: { title, start, location } | null;
    similarity: number;     // cos score (for debug/citation ordering)
  }>;
}
```

## Prompt（lib/ask/prompt.ts）

系统 prompt 放 `web/lib/prompts/ask.txt`（新增）；动态部分（stats + 邮件 JSON）代码拼。

**系统 prompt 要点**：

- 角色：学校邮箱助手
- 数据边界：只能看到下面传入的邮件（来自本地 DB 语义检索）。如信息不在，明说"未找到相关邮件"
- 工具使用：可以调 `read_full_email(id)` 拉完整正文；可调 `get_application(id)` 查 job 卡片聚合
- 引用：标注邮件用 `[id_suffix]` 如 `[#19d9c]`
- 语言：用户问中文就用中文；问英文就用英文
- **禁止**：编造内容；推测未出现的邮件；访问 Gmail live（工具未暴露）

**用户 prompt 结构**：

```
## Inbox 概览
今天: 2026-04-19
检索窗口: 180 天，池 947 封
相似度 ≥ 0.35 命中 42 封 (均值 0.51, 最大 0.78)
其中未读 8，job 6，event 3

## 相关邮件（按相似度降序）
[
  {
    "id": "19d9c0dfd28296ca",
    "date": "2026-04-17",
    "from": "Recruiter A [Company A] <recruiter@example.com>",
    "subject": "Company A | Monday, April 20th - In-Person Interview",
    "body": "...",
    "category": "primary",
    "unread": true,
    "primary_until": "2026-04-20T23:59",
    "job": { "stage": "interview_scheduled", "company": "Company A", "role": "Data Scientist", "deadline": "2026-04-20", "needs_action": true },
    "event": { "title": "On-site interview", "start": "2026-04-20T13:45", "location": "Company A office" },
    "similarity": 0.78
  },
  ...
]

## 用户问题
{Q}
```

## 调用链（lib/ask/stream.ts）

```
POST /api/chat { messages, sid? }       Content-Type: text/event-stream
                                        x-vercel-ai-ui-message-stream: v1
    ↓
  extract latest user msg Q  (no upfront retrieval)
    ↓
  spawn("claude",
    --model sonnet
    --resume <sid?>              (若无则 Claude 生成新 id)
    --output-format stream-json
    --include-partial-messages
    --mcp-config .mcp.json       (显式加载 → 绕过信任提示)
    --strict-mcp-config
    --permission-mode bypassPermissions
    --append-system-prompt-file ask.txt
    -p <Q>
  )
    ↓
  readline(stdout) 逐行 JSON →  transform 到 v5 part 类型：
    system init          → data: {type:"start",messageId}
                           data: {type:"start-step"}
                           data: {type:"data-session",id,data:{sid}}
    assistant text chunk → data: {type:"text-start",id} (首次)
                           data: {type:"text-delta",id,delta}
    assistant tool_use   → data: {type:"tool-input-available",toolCallId,toolName,input}
    user tool_result     → data: {type:"tool-output-available",toolCallId,output}
    result               → data: {type:"text-end",id}
                           data: {type:"finish-step"}
                           data: {type:"finish"}
                           data: [DONE]
    ↓
  前端 useChat 自动重建 UIMessage.parts[]；工具面板实时显示 "search_emails → N 封"
```

**session 持久化**：CLI 写 `~/.claude/projects/<dir>/sessions/<sid>.json`。后端记录 sid 返回给前端（SSE 首条 init 消息），前端存 URL `?sid=...`，下次请求带回。

## MCP 自制工具（mcp-server/）

**scope**：项目级（`.mcp.json` 放项目根），只在 `claude -p` 在本项目目录下跑时生效。

### Tool: `search_emails`

```json
{
  "name": "search_emails",
  "description": "Chunk-level semantic search over the user's local email database. Returns top-scoring emails (deduped by email_id, one best chunk per email). Query should be short English nouns + synonyms; for Chinese queries, translate before calling. Default max_results=20; body field contains the matched chunk, not a blind first-300-chars.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "max_results": { "type": "number" }
    },
    "required": ["query"]
  }
}
```

内部走 `/api/internal/rag-search` localhost-only endpoint → `retrieveRelevant()`。

### Tool: `read_full_email`

```json
{
  "name": "read_full_email",
  "description": "Fetch complete email body from local SQLite database by ID. Use when a snippet in the context is insufficient.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Email ID (from context citations, e.g. 19d9c0dfd28296ca)" }
    },
    "required": ["id"]
  }
}
```

返回：`{ subject, from, body, bodyHtml, date, category, threadId }` 或 `{ error: "not_found" }`。

### Tool: `get_application`

```json
{
  "name": "get_application",
  "description": "Fetch a job application's aggregated state — company, role, current stage, all emails in this application's thread, stage history, deadline.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Application ID (app_xxxx) or company+role (e.g. 'Company A:Data Scientist')" }
    },
    "required": ["id"]
  }
}
```

返回完整 applications 行 + 关联 job_emails 列表（每个含 stage / date / subject）。

### 注册

`.mcp.json`（项目根，tracked in git）：

```json
{
  "mcpServers": {
    "emaildigest-db": {
      "command": "node",
      "args": ["mcp-server/dist/server.js"]
    }
  }
}
```

Claude CLI 在项目目录启动时自动发现并挂载。

## 前端（app/ask/page.tsx）

```
┌─────────────────────────────────────────────┐
│ ← Back   ✨ Ask AI                 [New]    │  ← top nav
├─────────────────────────────────────────────┤
│                                              │
│  ┌ assistant bubble ────────────────────┐   │
│  │ 基于我看到的邮件 [#19d9c][#a4be1]...   │   │  ← markdown
│  │                                       │   │
│  │ [参考：Company A 面试 x] [TA 邮件 x]  │   │  ← 源胶囊
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌ user bubble ─────────────────────────┐   │
│  │ 那 Company A 那边需要我带什么？       │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌ assistant bubble (streaming) ────────┐   │
│  │ 建议你携带▋                            │   │
│  └──────────────────────────────────────┘   │
│                                              │
├─────────────────────────────────────────────┤
│ [Ask anything about your inbox...]  [↑]     │  ← input
└─────────────────────────────────────────────┘
```

### 技术栈

- `ai` v6 + `@ai-sdk/react` 的 `useChat()` Hook + `DefaultChatTransport` — 消息 state + SSE 消费 + 原生工具调用渲染
- `react-markdown` + `remark-gfm` — markdown 渲染
- 现有 glass-card 风格 + `@/components/mail/email-side-panel` 复用

### 入口

- Dashboard "Ask anything..." 输入框 `onSubmit` → `router.push('/ask?q=' + encodeURIComponent(q))`
- 移动 Tab "Ask AI" → `router.push('/ask')`
- URL `?q=...` 首次进入自动作为第一条 user message 发出
- URL `?sid=...` 会话恢复

### 引用源展示

`useChat` 消息的 `message.annotations` 字段放引用邮件 `{id, subject, from, date}` 列表。消息下方渲染为可点击胶囊：点 → 调 `EmailSidePanel` 打开源邮件。

## Chat History

左侧 240px 抽屉（移动端汉堡按钮 + sheet）列最近 50 个 Ask AI 会话，可点击复活，可删除。

**Source of truth**: 消息内容存 Claude CLI 的 per-session jsonl `~/.claude/projects/<项目目录编码>/<sid>.jsonl`。`data.db` 的 `conversations` 表只是索引——记录哪些 sid 是 Ask AI（`/api/chat`）的会话，过滤掉同目录下另外 1100+ 个 subprocess（event-extractor / jobs-pipeline / digest / draft-gen 等）产生的 jsonl 干扰。

**写入**：`lib/ask/stream.ts` 的 `proc.on("close", code)` 在 `code === 0` 时调 `upsertConversation(capturedSid, prompt)`；`title = prompt.slice(0,60)`，已存在 sid 只 bump `updated_at`，永不覆盖 title（保持首条 user message 作为话题标识）。

**3 个端点**（`web/app/api/chat/history/`）：

| 方法 + 路径 | 行为 |
|---|---|
| `GET /api/chat/history` | `listConversations(50)` → JSON `{conversations: [{sid, title, created_at, updated_at}]}` |
| `GET /api/chat/history/[sid]` | 读 jsonl → 过滤 user/assistant 文本 turns（跳过 tool_use/tool_result）→ 按 uuid dedupe（Claude CLI 流式快照可能产生同 uuid 多行，保最后一份）→ v5 `UIMessage[]`。jsonl 不存在则 `deleteConversation(sid)` 自愈 + 返回 410 |
| `DELETE /api/chat/history/[sid]` | `deleteConversation(sid)` + best-effort `fs.unlink(jsonlPath)` |

**MVP 限制**：旧会话只重建 user / assistant 文本 turns，不重建 tool-call UI（jsonl 里 tool_use/tool_result 完整，未来可加）。删除连物理 jsonl 一起删，否则 URL `?sid=` 还能复活，违反"删除"语义。无搜索/置顶/分页（写死 50）。

**前端**：`web/components/ask/ask-page-client.tsx` 的 `<HistoryPane>`：mount 时 GET 一次；每次 stream 完成（status edge `submitted/streaming → ready`）refetch 让 title 出现 / `updated_at` 更新；`loadConversation(sid)` 调 `stop() + setMessages(...) + setSid(...)` + URL 写 `?sid=`；`handleDelete` 走 confirm() → DELETE → 移除条目，删的是当前 sid 则触发 `newConversation()`。

## Validation（scripts/validate-rag.ts）

15 条合成 query（覆盖 deadline / 发件人 / 分类 / job / event / 语义召回 / 计数）：

1. 本周有什么作业要交
2. Professor X 最近发了什么
3. Company A 面试什么时候
4. 哪些邮件还没回
5. Company B 申请到哪一步了
6. 本月所有 track 类邮件的摘要
7. 有没有提到 Gradescope 的邮件
8. 下周日历事件
9. 最近未读的 primary
10. 验证码相关的邮件
11. 奖学金或资助类邮件
12. 教授发来的带附件的邮件
13. 帮我列出最近 deadline 按时间排序
14. 上个月这个公司给我发了几封
15. 有没有需要 RSVP 的邀请

对每条跑 6 个阈值（0.20, 0.25, 0.30, 0.35, 0.40, 0.45），统计：

- `hit_count`：该阈值下命中数
- `mean / stddev / median / p10 / p90` of top-50 similarities
- 人工抽 5 条 query 的 top-10 做相关性 sanity check（是否真的语义相关）

输出保存到 `scripts/validate-rag-output.md`，最终阈值决定记录在同一文件末尾 + 写进 `retrieve.ts` 常量。

## 性能预期

| 阶段 | 时间 |
|---|---|
| `embedText(Q)` | ~20ms（MiniLM 常驻，单次 forward）|
| SQL 池拉取（1000 行）+ cosine loop | ~30ms（纯 CPU，384-d × 1000 = 384k muladd）|
| Prompt 拼接 | <5ms |
| Claude Sonnet 流式首 token | ~1-2s |
| 完整回答 | ~3-8s（与 prompt 长度 + 工具调用数量相关）|
| 后续 `--resume` 多轮（相同 sid） | 更快（claude 缓存上下文）|

## 失败模式与降级

| 场景 | 降级 |
|---|---|
| `emails.embedding` 列大面积空（新库）| 触发 prefetch Step 2a embed 缓存；临时回落仅按 `received_at DESC` 取 20 封 |
| Top-1 相似度 < 0.3 | 不调 LLM，直接返回"未找到相关邮件" — 省 token |
| Claude CLI spawn 失败 / 超时 | SSE 发 error event，前端显示 retry 按钮 |
| MCP server 未启动 | Claude 调工具得到错误，降级为只用 prompt 内邮件回答 |
| `embedder.ts` 模型未加载完 | 第一次查询等待（~5s），后续常驻 0 开销 |

## 安全边界

- MCP 工具 **只读 local DB**；不允许写 / 删 / 改
- 不暴露 `list_emails / search_emails` 类工具 → Claude 不能绕 RAG
- `claude` CLI 启动时 **不传 `--allowedTools gmail_create_draft`** → 无法建草稿
- Prompt 里硬编码 "数据边界"约束，额外加一条"禁止建议用户执行命令 / 点击可疑链接"
- 同 `inquiry` 命令一样走 readonly（Gmail MCP 工具不启用）
