# 安全模型

## 安全规则 (`lib/safety.txt`)

6 条规则注入到所有 CLI 命令的 system prompt 中：

1. **绝对不要直接发送邮件** — 只能创建草稿 (gmail_create_draft)
2. **不要删除任何邮件**
3. **Label 隔离** — 所有搜索必须包含 `label:UCI-Mail`，只处理学校邮件
4. **凭证保护** — 不访问或显示密码、密钥或敏感凭证信息
5. **安全优先** — 不确定时选择不执行
6. **语言规则** — 使用中文回复，除非邮件原文是其他语言

## 工具权限控制

### 双模式架构

`lib/common.sh` 定义两组 Gmail MCP 工具列表：

**Readonly 工具集**（6 个）:
- gmail_search_messages
- gmail_read_message
- gmail_read_thread
- gmail_get_profile
- gmail_list_labels
- gmail_list_drafts

**Full 工具集**（7 个）:
- readonly 6 个 + `gmail_create_draft`

### 切换机制

```
lib/subprocess.ts: runCommand/execCommand(..., opts)
  → if (opts.readonly) env.EMAILDIGEST_READONLY = "1"
    → spawn("./emaildigest", [...], { cwd: EMAILDIGEST_DIR, env })
      → emaildigest → source lib/common.sh
        → common.sh: if [[ -n "${EMAILDIGEST_READONLY:-}" ]]; tools=readonly
          → claude CLI --allowedTools ${tools}
```

> **关键点**：权限控制在 shell 脚本层执行，不在 TypeScript 层。TypeScript 只设置 env 变量。如果绕过 shell 直接调用 Claude CLI，权限控制不生效。

### 应用场景

| 调用点 | 模式 | 原因 |
|--------|------|------|
| prefetch Step 2b（Inbox LLM 精细分类 + 回灌 category_examples） | `readonly: true` | 只需读取参考做分类 |
| prefetch Step 3 / drainMaybeWorkQueue（Jobs `llmConfirmBatch`） | `readonly: true` | is_job 判定 + 字段抽取 |
| **`forceClassifyAsJob`（用户右键 / 长按 → Classify as Job related）** | `readonly: true` | 只跑字段抽取 LLM（`EXTRACT_PROMPT_HEADER`），不创建草稿；用户意图已经绕过 is_job gate |
| `scripts/label-work-corpus.ts`（work classifier bootstrap） | `readonly: true` | 批量打二分类标签 |
| AI Generate（reply / compose 润色） | `readonly: true` | 只生成文本，不创建草稿 |
| Reclassify（`action=reclassify`） | `readonly: true` | 只读取做再分类 |
| Push to Gmail（`action=pushToGmail`） | **full** | 需要 gmail_create_draft |
| **`/api/chat`（Ask AI）** | **readonly + 自制 MCP 3 个只读工具** | Agentic RAG 问答 — Gmail MCP 不启用；挂 `search_emails` / `read_full_email` / `get_application`（都走 local SQLite；search_emails 经 `/api/internal/rag-search` loopback）|
| **event-extractor (`lib/event-extractor.ts`)** | **绕过 subprocess.ts 完全**（直 spawn `claude -p --model haiku` + `cwd: os.tmpdir()`） | 结构化事件抽取，pure JSON output，无 MCP / Gmail tools / safety.txt 注入。无工具 = 无创建草稿 / 发邮件可能。安全等价于 readonly |

**Web 端走 subprocess.ts 的调用只有 `pushToGmail` 是 full，其余都是 readonly。** event-extractor / draft-gen / email-digest 走直 spawn 路径，不传任何 `--allowedTools` / `--mcp-config`，从源头消除工具调用面。

### Ask AI 的 MCP 自制工具边界

`/api/chat` 启动 Claude CLI 时，通过 `.mcp.json` 注册一个 stdio MCP server `emaildigest-db`。它**只暴露 3 个工具**，都走 local SQLite read-only：

| 工具 | 允许的 SQL 动作 | 拒绝的动作 |
|---|---|---|
| `search_emails(query, max_results?)` | 经 `/api/internal/rag-search` loopback → `retrieveRelevant()`：扫 `email_chunks` 表（JOIN emails 拿元数据），chunk-level cosine，按 email_id dedupe 保留最高分 chunk，阈值 ≥ 0.35，cap 100。| 无写；无裸 SQL；不能绕过相似度过滤看任意邮件 |
| `read_full_email(id)` | `SELECT ... FROM emails WHERE id=?` | 无写；无模糊匹配 |
| `get_application(id)` | `SELECT ... FROM applications a LEFT JOIN job_emails je WHERE a.id=?` | 无写；无全表扫描 |

**故意不暴露**：`list_emails / query_db / execute_sql` 等通用查询。Claude 的全部检索动作都必须过 `retrieveRelevant` 的语义门槛，防止：(a) 越权看到 RAG 过滤掉的邮件，(b) 语义噪声稀释答案精度。

`/api/internal/rag-search` 端点有 **localhost-only gate**（middleware 检查 `Host` header 是否为 127.0.0.1/localhost/::1），外部请求会落到正常 auth 链路被 401 阻断。

MCP server 代码在 `mcp-server/server.ts`（~180 行），用官方 `@modelcontextprotocol/sdk`。Server 进程由 Claude CLI fork，scope 限定项目目录（`.mcp.json` 为 project-scoped 配置）。

**CLI 启动 flags**（防信任提示死锁）：
- `--mcp-config .mcp.json` 显式路径加载，绕过首次信任对话
- `--strict-mcp-config` 只用本配置，忽略用户/全局 MCP
- `--permission-mode bypassPermissions` 允许 `-p` 模式下的工具调用

没这组 flag，非交互式 `claude -p` 会拒绝未经 approval 的 project-scoped MCP，Claude 看不到工具 → 瞎编"需要授权"的假消息。

## Label 隔离

### 硬编码到每个 prompt

所有 3 个 CLI prompt 文件都硬编码 `label:UCI-Mail`：

- inquiry.txt: "始终在查询中添加 label:UCI-Mail"
- digest.txt: 同上
- classify.txt: `label:UCI-Mail after:<date>`

Web 端不走 Gmail MCP（改用 IMAP），Label 隔离改由 IMAP folder 决定：

```typescript
client.mailboxOpen("UCI-Mail", { readOnly: true });
```

`lib/imap.ts` 的 `fetchRecent({ label })` 默认 `label="UCI-Mail"`，IDLE listener 也固定打开此 folder。邮件在 Gmail 层面的 Label 过滤规则决定了哪些邮件进入 `UCI-Mail`，与个人邮件物理隔离。

### Gmail 侧隔离

Gmail 过滤器规则确保只有 UCI 邮件进入 `UCI-Mail` 标签，且跳过 Inbox，与个人邮件完全分离。

## Prompt Injection 防御

### 层 1：输入清洗 `sanitizeForPrompt` (`lib/sanitize.ts`)

对所有传入 LLM 的邮件内容预处理（按执行顺序）：

1. 移除 injection 模式：
   - `/ignore\s+(all\s+)?(previous\s+)?instructions/gi` → `[REDACTED]`
   - `/system\s*prompt/gi` → `[REDACTED]`
   - `/you\s+are\s+(now\s+)?a/gi` → `[REDACTED]`
2. 截断到 **200 字符**
3. 移除控制字符 `[\x00-\x08\x0b\x0c\x0e-\x1f]`

Step 3 LLM 分类的 prompt 里所有邮件字段（from / subject / snippet）都过这层。

### 层 2：JSON 参数传递 (`pushToGmail`)

草稿推送时内容通过 `JSON.stringify(draftParams)` 序列化：

```
请用 gmail_create_draft 创建草稿。参数如下 JSON，请原样传递每个字段，
不要修改内容：
{"to":"...","subject":"...","body":"...","threadId":"...","cc":"..."}
只创建草稿，返回创建结果。
```

草稿内容作为 JSON 数据传递，引号/换行被转义，防止"正文里的 AI 指令"被当作 prompt 执行。

### 层 3：LLM 输出清洗 `stripLLMContamination`

Claude 返回的邮件正文可能被污染，清洗流程（`lib/sanitize.ts`）：

0. **不可见字符**：`[\u034f\u00ad\u200b\u200c\u200d\ufeff]`（CGJ / soft hyphen / ZWSP / BOM）
1. **空行/空格折叠**：`\n{3,}` → `\n\n`，` {5,}` → `  `
2. **中文 AI 前缀移除**（6 种）：`邮件正文内容如下：` / `以下是邮件正文：` / `邮件正文：` / `正文如下：` / `正文内容：` / `以下是邮件的正文：`
3. **中文 AI 后缀移除**（5 种）：`正文为空—...` / `这封邮件...` / `该邮件...` / `这是一封...` / `注：...`
4. **Markdown 围栏**：首 ` ```lang ` 和末 ` ```/``` `
5. **邮件头块**：前 10 行内 `From:/Sent:/To:/Subject:/Cc:/Bcc:/Date:` 块，需同时有 From + (Sent 或 Date)；允许 Subject 后一个空行；前置 `________` 分隔线也一并去除

调用点：
- 服务器启动时 `cleanExistingBodies(stripLLMContamination)`（`instrumentation.ts`），事务内遍历 body≠'' 重洗（幂等，修复历史 MCP-fetch 污染）
- `mail-display.tsx` 渲染前对每封邮件 body 调用一次

IMAP 拉的新邮件不会产生 AI 污染（正文不经 LLM），但幂等清洗也不会误伤。

### 层 4：HTML 渲染安全（react-letter）

HTML 邮件通过 `react-letter` 的 `<Letter html={...} />` 渲染，由其内部的 permissive sanitizer 处理 — 移除 `<script>` / `<iframe>` / `on*` 事件处理器、阻止 `javascript:` URL，同时保留典型营销邮件需要的 inline `<style>` / `<table>` 布局以避免邮件样式坍塌。

EmailDigest 不再维护自家的 allowlist sanitizer（旧的 `sanitizeHTML` / `isHTML` 在 react-letter 接管渲染后变成死代码已删除）。攻击面取决于 react-letter 的 sanitizer 质量；该库在 GitHub 有 active maintenance，依赖 `juice` + `dompurify` 风格的清洗。如未来需要更严格的策略（例如完全禁用 inline style），需在外层 wrapper 里二次清洗，不要恢复 ad-hoc 实现。

## SQL 注入防御

所有数据库操作使用参数化查询（`?` 占位符），含动态 IN 子句：

```typescript
const placeholders = ids.map(() => "?").join(",");
db.prepare(`... WHERE id IN (${placeholders})`).run(...ids);
```

`deleteCategory(id)` 的事务内也是参数化；分类 ID 格式固定为 `cat_<slug>`（`slugify()` 强制小写字母数字下划线），无外部注入路径。

## 发送防护

EmailDigest 有两条潜在发送出口，均加了硬性闸门：

### Gmail MCP 路径（默认）

- 工具列表中**没有** `gmail_send_draft` — Claude CLI 完全无能力发送
- 只有 `gmail_create_draft` 可用，创建未发送草稿
- 用户在 Gmail UI 手动点发送

### SMTP 路径（可选，三重门）

`lib/smtp.ts` 通过 nodemailer 直接发送，绕过 Gmail UI。3 重保护：

1. **环境变量门**：`GMAIL_APP_PASSWORD` 必须在 `.env.local` 配置（https://myaccount.google.com/apppasswords 生成，要求 2FA）。未配置时 `isSmtpConfigured()` 返回 false，API 400
2. **API 显式 confirm 标志**：`sendNow` 必须收到 `body.userConfirmedDirectSend === true`，否则 400。前端只有走完 Send → 确认 modal → Confirm Send 路径才带这个标志
3. **字段非空校验**：`to.trim() / subject.trim() / body.trim()` 任一空则 400，防止空邮件事故
4. **10s undo 窗口**：UI 显示倒计时 + Undo 按钮，给用户最后一次取消机会

### Schedule cron 路径

`instrumentation.ts` 每 60s 检查 `getScheduledDraftsDue(now)`。该路径：
- 只有 `isSmtpConfigured()` 通过才会执行
- 绕过 `userConfirmedDirectSend` 检查（因为创建 scheduled 时已经走过前端确认）
- `includeSignature: true` 硬编码
- 当前**无断路器**：SMTP 持续失败会每分钟重试直到成功。若 rate-limit / 凭据失效需手动 cancelSchedule

### Dev-only UI（不在生产攻击面）

`GoldLabelPicker` 组件仅在 `NEXT_PUBLIC_DEV_TOOLS=1` 环境变量下可见。生产 build 时该 UI 完全不渲染（`NEXT_PUBLIC_*` 在 build 时内联，未启用的分支被 tree-shake）。对应 API（`/api/emails` 的 `addEvalLabel / removeEvalLabel / listEvalSet`）仍存在但未鉴权 — 本地开发 OK，公网暴露需补鉴权。

## 攻击面分析

| 风险 | 缓解措施 | 残留风险 |
|------|---------|---------|
| 邮件含 prompt injection | sanitizeForPrompt 截断+清洗；内容在 few-shot context 而非直接指令 | 200 字截断后仍可能含有效 injection |
| 草稿含恶意指令 | JSON.stringify 序列化，内容作为数据传递 | Claude 可能仍解释 JSON 内容为指令 |
| 绕过 label 限制 | `label:UCI-Mail` 硬编码到所有 prompt；IMAP 侧硬编码 folder | prompt 文件被改时 label 可能丢失（无运行时验证） |
| XSS（HTML 邮件） | react-letter `<Letter>` 内置 sanitizer（`<script>` / `on*` / `javascript:` 全部移除） | 第三方依赖；如未来发现 bypass 需上游升级或外层补救 |
| 意外发送（Web Push） | VAPID 私钥本地 `.env.local` 永不进 git；`/api/push/subscribe` 限本服务；payload 仅 digest 摘要（不含原始邮件内容） | VAPID 私钥泄露 → 攻击者可向已订阅设备发任意推送（不能读邮件） |
| Claude CLI 失败风暴 | Circuit breaker（`lib/circuit-breaker.ts`）：3 次失败开 5min，最长 30min；forceClassifyAsJob 豁免 | 半开期单次 retry；breaker 状态进程内存（重启重置）|
| SQL 注入 | 全部参数化查询 | 无 |
| 意外发送（MCP 路径） | 工具列表不含 send，只含 create_draft | 无 |
| 意外发送（SMTP 手动路径） | 3 重门：env var + userConfirmedDirectSend + 字段非空；10s undo | 配置 + 前端 bug 同时发生才可能误发 |
| 意外发送（Schedule cron 路径） | 创建 scheduled 需走前端确认；cron 本身在 isSmtpConfigured 通过后才运行 | **无断路器**：SMTP 持续失败会无限重试 |
| AI 模式越权 | readonly 模式由 env var 控制 | 如果 subprocess.ts 未设 env var，默认 full 权限 |
| API 无认证 | 仅本地运行，localhost:3000 | 局域网其他设备可访问；公网部署需补认证层 |
| Dev-tool UI 暴露 | `NEXT_PUBLIC_DEV_TOOLS` tree-shake；API endpoint 本地开发 OK | 公网部署需鉴权包 eval API |
| Claude CLI token 过期 | 被动检测：每次直 spawn 失败时 `lib/auth-status.flagAuthFailureIfMatch` 扫 stderr 关键词 → `app_state.claude_auth_status='failed'` → UI 红 banner；下次成功调用 `clearAuthFailure` 翻回 ok | 长时间无 LLM 活动时染色滞后；如要立即检测可手动触发任意 LLM 调用 |

## 权限执行链（完整）

```
subprocess.ts: runCommand("inquiry", [...], { readonly: true })
  → createJob(command) 返回 Job 并 insert store
  → env.EMAILDIGEST_READONLY = "1"
  → spawn("./emaildigest", ["inquiry", ...], { cwd, env, stdio: ["ignore","pipe","pipe"] })
    → emaildigest(shell) sources config.sh + lib/common.sh
      → check_dependencies（claude CLI + jq）
      → case $command in inquiry) source commands/inquiry.sh "$@" ;; esac
        → commands/inquiry.sh parse_common_args → run_claude(...)
          → lib/common.sh run_claude():
              if [[ -n "${EMAILDIGEST_READONLY:-}" ]]; tools=readonly
              claude -p "$prompt"
                --model "$EMAILDIGEST_MODEL"
                --max-budget-usd "$budget"
                --allowedTools "$tools"
                --append-system-prompt safety.txt
                --append-system-prompt commands/inquiry.txt
      stdout → updateJob(id, { status: "done", result: stdout })
      非 0 exit → updateJob(id, { status: "error", result: stdout, error: stderr || "exit code N" })
```

`stdio: ["ignore", "pipe", "pipe"]` — stdin 不连接（防交互式），stdout / stderr 捕获。
