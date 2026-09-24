## Feature: 自然语言邮箱问答 (Ask AI)

### Why
用户真正想做的事很多是跨邮件聚合查询："这周有哪些作业要交"、"哪些招聘
邮件还没回"、"教授最近发了什么"——用关键词搜做不到，分类过滤也做不到。
只有 LLM 能真正"读"完一批邮件再用自然语言回答。早期版本是 Dashboard 内
嵌的单次问答，用户经常需要顺着第一轮结果追问——"那 Company A 面试要带什么"——
于是升级为独立 `/ask` 多轮 chat 页，并把被动 RAG 换成 agentic retrieval，
Claude 自行决定何时调 `search_emails` 工具。

### What
Dashboard 顶部有一个 "Ask anything..." 输入框 + 一组预设问题 chip；移动端
底部 tab bar 有一个 "Ask AI" tab。无论哪个入口，点击/提交后都 `router.push`
到 `/ask` 独立页（query 通过 `?q=...` 传递，首次进入自动作为第一条 user
message 发出）。`/ask` 页面是一个完整 chat UI：消息列表、底部输入框、顶部
"New" 按钮（新建 session）。前端用 `@ai-sdk/react` 的 `useChat()` Hook +
`DefaultChatTransport` 消费 `/api/chat` 的 SSE 流。

后端 `/api/chat` 调 `lib/ask/stream.ts`，spawn
`claude -p --output-format stream-json --include-partial-messages
--mcp-config .mcp.json --strict-mcp-config --permission-mode bypassPermissions
--append-system-prompt-file ask.txt [--resume <sid>]`。上游不做 RAG，Claude
自主在多轮对话中按需调工具：

- `search_emails(query, max_results?)` — 语义检索入口；内部经
  `/api/internal/rag-search`（localhost-only gate）→ `lib/ask/retrieve.ts` 的
  chunk-level cosine over `email_chunks` 表
- `read_full_email(id)` — 按主键拿完整正文
- `get_application(id)` — 某条 job application 的聚合状态

### Acceptance Criteria
- Dashboard 的 Ask 输入框 + 预设问题 chip 均 `router.push('/ask?q=...')`；
  `/ask` 页读取 query param 自动作为首条 user message 发出
- 移动端 "Ask AI" tab 跳转到 `/ask`（空 query）
- `/ask` 页经由 `useChat()` 消费 SSE 流，消息流式渲染
- 多轮对话通过 CLI 的 `--resume <sid>` 维持；sid 存在 URL `?sid=...`，刷新或
  分享链接可恢复会话
- 顶部 "New" 按钮清空消息并移除 sid，下一次提交产生新 sid
- Agentic retrieval：Claude 自主决定何时调 `search_emails`，闲聊不消耗 RAG
  token；工具调用在 UI 以独立 part 显示（"search_emails → N 封"）
- 引用格式 `[#<8-char-id>]`（如 `[#19d9c0df]`），前端正则抽取并渲染为可点击
  胶囊；点击打开 `EmailSidePanel` 显示源邮件
- `useChat().stop()` 可取消进行中的请求
- 不加载任何 Gmail 写工具；MCP 只注册上述 3 个只读工具
- 跨语言：英文 embedder + Claude 在调 `search_emails` 前自行把中文 query 翻
  成英文关键词 + 同义词（见 `web/lib/prompts/ask.txt`）；回答语言匹配用户提
  问语言（中文问中文答、英文问英文答）
- 短上下文 RAG：retrieve 在 `email_chunks` 表做 chunk-level cosine（非整封
  邮件级）以提升召回精度

### Out of Scope
- 不做服务端持久化的历史问答列表 UI（但 CLI session 通过 URL `?sid=...` 能
  起到轻量恢复作用）
- 不允许 Ask 创建草稿或发送邮件（MCP 无写工具）
- 不接入 Calendar 数据（只读邮件 + job + event JOIN）

### Open Questions
- 预设问题 chip 当前仍硬编码在 `ask-page-client.tsx:14` 和 `ai-panel.tsx:34`，
  是否应该随用户实际邮箱动态生成？
- ~~同一时刻只能一个请求在运行~~ → 已由 `useChat().stop()` 处理

### 实现参考
- 架构总览：[docs/design/ask-rag.md](../design/ask-rag.md)
- 检索实现：`web/lib/ask/retrieve.ts` + `email_chunks` 表
- MCP server：`mcp-server/server.ts`（3 个只读工具）
- Loopback gate：`/api/internal/rag-search` + middleware host check
