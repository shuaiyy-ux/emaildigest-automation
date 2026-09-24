## Feature: SMTP 直接发送（含确认 / Undo / 签名 / 忘附件提醒）

### Why
Push to Gmail 再手动点发送要两步。日常回复"收到"、"好的"、"下周二可以"这种
短邮件不值得切到 Gmail。用户需要"在当前界面就能发出"。但越快发送的系统越容易
发错——收件人打错、忘了附件、subject 空着——所以必须配套保护：
确认弹窗 + Undo 倒计时 + 签名可选 + 忘附件检测。

### What
草稿编辑器底部的 SendHorizonal 按钮。点击后弹出确认窗口显示 To/Cc/Bcc/Subject
预览 + 附件数量 + "Include signature" 勾选。确认后进入 10 秒 Undo 倒计时，
期间底部横幅显示 "Sending in Ns" + Undo 按钮。10 秒结束后真正走 SMTP 发送。

### Acceptance Criteria
- Send 按钮仅在 to 非空 + 三字段邮箱格式合法 + body 非空时可点击
- Confirm 弹窗显示 To / Cc / Bcc / Subject / 附件数，Subject 为空时显示 "(empty)" 斜体
- Body 中含"attach"/"附件"/"请见附件"等词但无附件时，弹窗显示琥珀色警告
- Subject 为空时弹窗显示琥珀色警告（但不阻塞发送）
- 确认后 10 秒 Undo 倒计时期间点击 Undo 立即取消，草稿不发出
- Undo 结束后调用 SMTP，失败时底部显示红色错误 banner，草稿保留
- 发送成功后本地草稿 status=sent，编辑器显示 "Email sent" badge
- 签名来自环境变量 GMAIL_SIGNATURE，用户可在 Confirm 弹窗勾选是否附加
- 未配置 GMAIL_APP_PASSWORD 时 Send 请求返回 400 + 提示配置位置
- ⌘↵ / Ctrl+Enter 快捷键等价于点击 Send 按钮（在可发送状态下）

### Out of Scope
- 不做"已发送"文件夹（发出就只存本地 sent 状态，不展示）
- 不做 read receipt / tracking pixel
- 不做批量发送（一次一封）
- 不做多签名切换（一个全局签名）

### Open Questions
- 10 秒 Undo 窗口是否合适？Gmail 默认 5-30 秒可调。
- 是否需要在 Undo 期间允许重新编辑（而不是只能取消或发出）？
