# 本地优先草稿系统

## 设计原则

所有邮件回复/转发/撰写先存本地 SQLite，用户确认后才能离开本地。三条出口：

1. **Push to Gmail（默认，最安全）** — 推送到 Gmail Drafts，**不发送**；用户在 Gmail UI 手动点 Send
2. **Send via SMTP（可选，需显式 confirm）** — 通过 nodemailer 直接发送
3. **Schedule** — 标记 `scheduled_at`，由 `instrumentation.ts` 内的每分钟 cron 在到期时走 SMTP 路径发送

> **永不直接发送**：即便 SMTP 路径，也必须同时满足：
> - `body.userConfirmedDirectSend === true`（前端只有走完确认 modal 才会带）
> - 环境变量 `GMAIL_APP_PASSWORD` 已配置（`isSmtpConfigured()` 检查）
> - 草稿 to/subject/body 非空

## 草稿生命周期

```
创建 (POST /api/drafts action=create)
  ↓
draft (本地编辑) ←→ AutoSave 每 2s（AUTOSAVE_MS）
  │  AI Generate (readonly subprocess, 120s 倒计时)
  │  附件 / 签名 / 联系人 autocomplete
  │
  ├── Push to Gmail (full subprocess, 60s 倒计时)
  │     → markPushed → status=pushed → "Draft saved to Gmail" badge → 5s 自动 onClose
  │
  ├── Send via SMTP (10s undo 窗口 → nodemailer.sendMail)
  │     → markDraftSent → status=sent, sent_at=unixepoch(), gmail_message_id=<messageId>
  │
  ├── Schedule (datetime-local → scheduleSend)
  │     → status=scheduled, scheduled_at=epoch
  │     → instrumentation.ts 每 60s 扫 getScheduledDraftsDue(now)
  │       → sendEmail({..., includeSignature:true}) → markDraftSent
  │     → cancelSchedule → updateDraftStatus(id, "draft") 回到 draft
  │
  ├── Discard (X 按钮 / Escape)
  │     → updateDraftStatus(id, "discarded")（软删除，UI 不再显示）
  │
  └── Delete (API action=delete)
        → DELETE FROM drafts（硬删除，cascade 到 attachments）
```

### 状态枚举

| 状态 | 含义 | `getAllDrafts()` 可见 | 备注 |
|------|------|----------------------|------|
| `draft` | 本地编辑中 | ✓ | DraftList 显示 |
| `pushed` | 已推送到 Gmail Drafts | ✗ | 用户在 Gmail UI 手动发送；本地草稿只读 |
| `sent` | 已通过 SMTP 实际发送 | ✗ | sent_at + gmail_message_id 写入 |
| `scheduled` | 等待定时发送 | ✗ | scheduled_at = epoch；cancelSchedule 可回到 draft |
| `discarded` | 用户放弃 | ✗ | 软删除，记录保留 |

`getAllDrafts()` 过滤 `WHERE status='draft'`。`pushed` 和 `sent` 是两种合法终态（两条不同出口），不应合并。

> **⚠️ types.ts 漂移**：`DraftStatus = "draft" | "pushed" | "sent" | "discarded"` 少列 `"scheduled"`，但 DB 实际写入该值。由于 `getAllDrafts` 只返回 `status='draft'`，枚举空洞不会在当前 UI 暴露。新增批量状态切换逻辑时需注意。

## 创建草稿

### 入口 1：从邮件详情 Reply / Forward

`MailDisplay` 工具栏（桌面右侧 / 移动底部 action bar）→ 点 Reply / Forward → 父组件 `setComposing("reply" | "forward")`：

- **桌面**：`<DraftEditor>` 内联渲染在 `MailDisplay` 底部
- **移动**：`<DraftEditor>` 在 `fixed inset-0 z-50` 全屏 overlay 中渲染（避免与 ScrollArea 抢 flex-1 空间）

DraftEditor mount 时 POST `/api/drafts action=create`：

**Reply 自动填充**（`/api/drafts/route.ts` 的 create 分支）：
- `to` = 原邮件 `from_email`
- `subject` = `"Re: "` + 原主题（已有 `Re:` 前缀则不重复）
- `body` = 引用块：`\n\n---\nOn {email.date}, {from_name} wrote:\n> 原文逐行 prefix '> '`

**Forward 自动填充**：
- `to` = 空（用户填）
- `subject` = `"Fwd: "` + 原主题（已有则不重复）
- `body` = `\n\n---------- Forwarded message ----------\nFrom: {from_name} <{from_email}>\nDate: {date}\nSubject: {subject}\n\n{原文}`

**前端覆盖**：API 接受可选 `to/subject/body` 参数；前端传值则覆盖自动填充（`(body.to as string) || to`）。

### 入口 2：从草稿列表

侧边栏 `Drafts` → `DraftList` → 点击已有草稿 → DraftEditor 通过 `initialDraft` prop 加载（`key={initialDraft.id}` 强制 remount）。

### 入口 3：Compose（从零写新邮件）

侧边栏 / Dashboard 右上角 `PenSquare` → `setComposing(true)` → DraftEditor with `compose: true` prop：

- to/subject/body 全空
- AI Polish 按钮用 subject + body 当前内容作为 intent（**遵循 `feedback_reuse_form_fields`**，不另开 prompt 输入框）
- POST `/api/drafts action=create body={type:"new"}` 创建空草稿

移动端 Dashboard 右上角的 PenSquare 按钮走同一路径。

### ID 格式

```
d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}
```

由前端 `/api/drafts` POST 生成（`generateId()`），不由客户端生成。

## 编辑 + AutoSave

DraftEditor 维护本地表单 state（`to/cc/bcc/subject/body`）。每次输入后 2s（`AUTOSAVE_MS`）触发 PATCH（`/api/drafts action=update`）：

- 状态指示：`idle` → `saving`（Loader2 + "Saving"）→ `saved`（CheckCircle2 + "Saved"）
- API 端 `updateDraft(id, patch)` 动态构造 SET 子句，只更新传入字段
- 追加 `updated_at = unixepoch()`

字段特性：

| 字段 | 行为 |
|------|------|
| To | `validateEmails()` 校验（红字提示）；Contacts autocomplete（≥ 2 字符触发，最多 5 条） |
| Cc / Bcc | 默认隐藏，按钮展开；关闭时同步清空值 |
| Subject | 可空（提交时 amber warning） |
| Body | 纯文本 textarea；可选签名（`GMAIL_SIGNATURE` env 注入） |
| Attachments | 10MB 上限（前端 + 服务端双检） |

## AI 生成 / 润色（120s 倒计时，`AI_TIMEOUT_SEC`）

单按钮（Sparkles），同时支持两种模式：

### Reply / Forward 模式（emailId + type）

POST `/api/drafts action=aiGenerate body={emailId}` → readonly subprocess 启动 inquiry 命令（无 `gmail_create_draft` 权限）：

```
请为邮件 "${subject}" (from: ${from_name} <${from_email}>) 生成回复内容。
只返回回复正文。标注 [AI草稿]，匹配原邮件语言，简洁专业。只输出正文文本。
```

结果处理：
- `aiBody = result.result.trim()`
- 查找 body 中的分隔符：`\n\n---\n`（reply）或 `\n\n---------- Forwarded message`（forward）
- 有分隔符 → 替换分隔符**之前**的内容，保留引用块；无分隔符 → 整体替换 body

### Compose 模式（`compose: true`）

POST `/api/drafts action=aiGenerate body={compose:true, subject, body}`：
- 前端传入当前 subject + body 当作 intent（最多 200/2000 字）
- 二者都空时返回 400 `"Empty draft — write some notes first"`
- 后端 prompt：
  ```
  用户在写一封新邮件的草稿，请把它润色成完整专业的邮件。
  用户当前草稿:
    Subject: {subject || "(空)"}
    Body: {body || "(空)"}
  要求:
    - 语言与用户草稿一致
    - 保留核心意图，不臆造事实
    - subject 简洁；body 得体，开头标注 [AI草稿]
    - 不填写收件人名字，开头用通用问候
    - 返回严格 JSON: {"subject":"...","body":"[AI草稿]\n..."}
  ```
- 前端 `parseJsonObject<{subject, body}>(result.result)` 解析；失败显示 "AI 返回格式无法解析，请重试"；成功则替换两个字段

### 前端轮询

`pollJob(jobId, { timeoutSec: 120, onTick: ({remaining}) => setAiRemaining(remaining) })`：

- AI 按钮 Hint 动态：`Generating reply · 1m 30s` / `Polishing · 1m 30s`
- 底部 inline 进度条：`<Loader2 /> Generating reply` + `<span className="font-mono tabular-nums">{formatCountdown}</span>`
- timeout：destructive banner "生成超时，请重试"
- error：banner 显示后端 error
- 成功：按上述规则更新 body/subject

**关键安全**：AI Generate 无论 reply 还是 compose，都走 `runCommand(..., { readonly: true })` → Claude 无法调用 `gmail_create_draft`。

## Push to Gmail（60s 倒计时，`PUSH_TIMEOUT_SEC`）

CloudUpload 按钮：

1. `saveDraft()` 同步保存当前编辑
2. POST `/api/drafts action=pushToGmail` → **full 权限** subprocess（不设 readonly）：
   ```typescript
   const draftParams = { to, subject, body };
   if (draft.thread_id) draftParams.threadId = draft.thread_id;
   if (draft.cc) draftParams.cc = draft.cc;
   // prompt:
   // 请用 gmail_create_draft 创建草稿。参数如下 JSON，请原样传递每个字段，
   // 不要修改内容:\n${JSON.stringify(draftParams)}\n只创建草稿，返回创建结果。
   ```
3. `pollJob(jobId, { timeoutSec: 60, onTick: setPushRemaining })`：
   - Hint：`Pushing to Gmail · 45s`
   - 同一 inline 进度条复用
4. `status === "done"`：POST `action=markPushed` → `updateDraftStatus(id, "pushed")` → 显示 `Draft saved to Gmail` badge + "closing…" → **5s（`PUSHED_AUTO_CLOSE_MS`）自动 onClose()**
5. 错误 / 超时：`setPushError`，destructive banner + Dismiss 按钮

**JSON.stringify 防注入**：草稿内容可能含恶意 prompt injection。JSON 序列化确保引号、换行被正确转义，内容作为数据传递而非指令。详见 [security.md](security.md) 第 2 层。

**Push 失败**：草稿 status 保持 `draft`，用户可重试；不会误写 pushed。

## Send via SMTP（10s undo，`UNDO_SEND_MS`）

Send 按钮 → 确认 modal（预览 to/cc/bcc/subject/files + Subject empty / forgot attachment warning + signature toggle）→ Confirm Send → `startSend()`：

1. 立即 `setSending(true)`，启动 10s 倒计时 + 底部 banner `Sending in {undoSecondsLeft}s` + Undo 按钮
2. `setInterval(1s)` 驱动 `undoSecondsLeft` 递减
3. `setTimeout(10s)` 到时：
   - `saveDraft()` 同步保存
   - POST `/api/drafts action=sendNow body={id, includeSignature, userConfirmedDirectSend: true}`
4. 后端检查（**任一失败立即 400/500，不发送**）：
   - `body.userConfirmedDirectSend === true` 否则 400 `"userConfirmedDirectSend required"`
   - `isSmtpConfigured()` 否则 400 `"SMTP not configured. Set GMAIL_APP_PASSWORD..."`
   - 草稿存在 + `to_address.trim()` + `subject.trim()` + `body.trim()` 都非空
5. `getAttachments(draft.id)` → 构造 nodemailer `attachments: [{filename, path}]`
6. `sendEmail({to, cc, bcc, subject, body, attachments, includeSignature})`：
   - **AI 草稿安全网**：若 `body.includes("[AI草稿]")` 但 `subject` 不含 → 自动在 subject 前缀 `[AI草稿] `
   - 签名：`includeSignature && GMAIL_SIGNATURE` 时在 body 末尾追加 `\n\n--\n${SIGNATURE}`
   - transporter：`nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_FROM_ADDRESS, pass: GMAIL_APP_PASSWORD } })`（cached）
   - `inReplyTo` + `references` 字段用于线程续接（当前 API 未传）
7. 成功：`markDraftSent(id, messageId)` → status=sent, sent_at=now, gmail_message_id=<id>；前端显示 "Email sent" badge + Close 按钮
8. 失败：返回 500，前端 destructive banner

### Undo 处理

用户在 10s 内点 Undo → `cancelSend()`：
- `clearTimeout(undoTimerRef.current)` — 阻止实际请求
- `clearInterval(undoCountdownRef.current)` — 停倒计时
- `setSending(false); setUndoSecondsLeft(0)` — 回到编辑态

**组件卸载时**：useEffect cleanup 清掉 timer/interval，避免 leak。

## Schedule Send

Clock 图标 → modal 选择 `<input type="datetime-local">` → POST `action=scheduleSend body={id, sendAt}`：

- `sendAt = Math.floor(new Date(scheduleTime).getTime() / 1000)`
- 后端检查 `sendAt > now`，否则 400
- `scheduleDraft(id, sendAt)` → status=scheduled + scheduled_at
- 前端显示 "Send scheduled for {time}" badge + Close 按钮

### 执行：instrumentation.ts 的 cron

```typescript
setInterval(async () => {
  if (!isSmtpConfigured()) return;  // 没 SMTP 跳过
  const due = getScheduledDraftsDue(Math.floor(Date.now() / 1000));
  for (const draft of due) {
    const attachments = getAttachments(draft.id).map(...);
    const result = await sendEmail({
      to, cc, bcc, subject, body,
      attachments, includeSignature: true,  // cron 路径强制含签名
    });
    markDraftSent(draft.id, result.messageId);
  }
}, 60_000);  // 每 60s
```

`getScheduledDraftsDue(now)` SQL：`SELECT * FROM drafts WHERE status='scheduled' AND scheduled_at <= ?`

失败（`sendEmail` throw）只 console.error，该草稿下一分钟再试。**当前没有"连续失败 N 次后放弃"的断路器**，网络持续故障时会每分钟重试直到成功。

### 取消 Schedule

API `action=cancelSchedule body={id}` → `updateDraftStatus(id, "draft")` → 回到 `draft` 状态，重新出现在 DraftList。

## 附件

### 上传

- UI：`<input type="file">` 隐藏，Paperclip 按钮触发 `fileInputRef.current?.click()`
- 客户端：`file.size > 10*1024*1024` → 显示 "exceeds 10MB limit. Use Push to Gmail for larger files."
- 网络：`POST /api/drafts/[id]/attachments` with FormData

### 服务端（`/api/drafts/[id]/attachments`）

```typescript
export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_SIZE = 10 * 1024 * 1024;  // 10MB
const ATTACHMENTS_ROOT = path.join(EMAILDIGEST_DIR, "attachments");
```

1. 草稿存在性检查 → 404
2. `Content-Length` 早期检查（超 10MB+1KB → 413）
3. `req.formData()` 解析（失败 → 413，信息含"File exceeds 10MB limit or malformed upload"）
4. `file.size > MAX_SIZE` 再查一次（FormData 解析后）→ 413
5. 磁盘写入：`${EMAILDIGEST_DIR}/attachments/${draftId}/${Date.now()}_${safeName}`
   - `safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")`（防路径穿越）
6. `addAttachment(draftId, originalFilename, storedPath, size, mimeType)` 入表

### 列出 / 删除

- GET `/api/drafts/[id]/attachments` → `getAttachments(draftId)`
- DELETE `/api/drafts/[id]/attachments?attachmentId=N` → `deleteAttachment(id)` + `fs.unlink(row.path)`（安全 try/catch）；校验 `row.draft_id === draftId` 防跨草稿删除

### 前端呈现

`DraftEditor` flex-wrap chip：Paperclip icon + filename + `formatBytes(size)` + X 按钮。uploading 时 Paperclip 按钮 spinner。

### ≥ 10MB 怎么办

提示走 Push to Gmail 路径：推送到 Gmail UI 后再由用户手动附加大文件（Gmail 25MB 限制）。

## 联系人 Autocomplete

DraftEditor mount 时一次性 fetch `/api/contacts`：

```sql
SELECT from_email AS email, from_name AS name, COUNT(*) AS count
FROM emails WHERE from_email != ''
GROUP BY from_email ORDER BY count DESC, name ASC
```

To 字段 `onChange` → 取最后一段（逗号/分号后）→ `length >= 2` 时匹配 email/name includes → 最多 5 条建议 → 点击应用时替换最后一段。onBlur 200ms 延迟关闭（给 click 时间）。

## 删除草稿

| 入口 | 行为 |
|------|------|
| DraftEditor X / Escape | POST `discard` → onClose |
| DraftList Trash2 | stopPropagation → POST `discard` → 乐观更新（无回滚） |
| API `action=delete` | `DELETE FROM drafts WHERE id=?`（cascade 删除 attachments + 磁盘文件未清理，遗留在 `attachments/` 目录） |

> **已知遗留**：硬删除 API 没清磁盘文件。当前只有 attachments DELETE 端点会 `fs.unlink`。草稿硬删除基本不用（前端一律走 discard），实际影响小。

## 键盘快捷键

| 键 | 动作 |
|----|------|
| `Cmd/Ctrl + Enter` | 触发确认发送 modal（仅 `canSend` 时；已 sending/sent/confirmOpen 时忽略） |
| `Escape` | fullscreen → 退出全屏；否则 onClose；confirmOpen/scheduleOpen/sending 期间忽略 |

## 签名处理

- env 变量 `GMAIL_SIGNATURE` 注入
- DraftEditor mount 时 POST `action=getSignature` → `/lib/smtp.getSignature()` 返回字符串
- 渲染：body textarea 下方 `<div className="text-muted-foreground/60">— {signature}</div>`（仅 `includeSignature` 为 true 时显示）
- 确认 modal 显式 checkbox toggle
- SMTP send 路径 `includeSignature: body.includeSignature !== false`（默认 true，用户取消勾选才 false）
- Schedule cron 发送路径 `includeSignature: true`（强制）

## 数据库 Schema

见 [database.md](database.md#drafts-表) — drafts + attachments 表。关键字段：

- `status` 状态机：draft → {pushed|sent|scheduled|discarded}
- `scheduled_at` / `sent_at` / `gmail_message_id` 均为 ALTER 加入的后续字段
- `attachments.draft_id` 有 FK CASCADE，硬删除草稿时附件 DB 行自动清；磁盘文件目前不会 cascade
