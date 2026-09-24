## Feature: 推送到 Gmail 草稿

### Why
有些场景用户不想直接发，而是希望"在 Gmail 里再检查一遍再点发送"，
或希望邮件沿用 Gmail 的回复链（threadId）、原生签名、标签等。
对于重要邮件，Gmail 的"熟悉环境"能降低发送前的焦虑。

### What
草稿编辑器底部有 Send 图标按钮（旁边是直接 SMTP 发送的 Send 按钮），
点击后把本地草稿推送到 Gmail，创建一个未发送的 Gmail 草稿。
成功后本地草稿标记为 pushed，编辑器显示 "Draft saved to Gmail" badge。

### Acceptance Criteria
- 点击前自动保存本地草稿（避免推送旧版本）
- 推送过程中按钮显示 spinner 并禁用
- Gmail 侧创建的草稿包含：to / cc / subject / body / threadId（Reply 时）
- 草稿内容作为 JSON 参数传递给 Claude（而非嵌入 prompt 字符串），防 prompt injection
- 推送成功后本地草稿 status=pushed，Drafts 列表里消失
- 推送失败或超时（60 秒内无结果）不改变 status，用户可重试
- 推送后用户在 Gmail 仍需手动点"发送"——系统不代为发送
- 工具权限：推送使用完整 gmail_create_draft 权限，但无 gmail_send 权限（系统层面不可能直接发）

### Out of Scope
- 不做推送附件（本地附件只能通过 SMTP Send 发出，见 spec-attachments）
- 不做 Gmail 草稿 ID 回写到本地（当前只标记 pushed，不保存 Gmail ID）
- 不做"推送后同步修改"（Gmail 端改了，本地不感知）
- 不做 bcc 字段推送（当前 payload 只包含 to/cc）

### Open Questions
- 是否需要区分"推送成功但未发送"和"已在 Gmail 发送"？当前本地只知道 pushed。
