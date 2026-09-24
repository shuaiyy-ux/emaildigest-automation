## Feature: 定时发送

### Why
用户经常在非工作时间（深夜、周末）写邮件，但希望收件人在工作时间收到，
显得更专业。或者写完邮件想"冷静一天"再发。Gmail 的 Schedule send 是日常刚需。

### What
草稿编辑器底部 Clock 图标按钮。点击弹出时间选择器（datetime-local 默认当前时间+1 小时）。
用户选好时间点 Schedule，本地草稿状态变为 scheduled，编辑器显示
"Send scheduled for {时间}" badge。到点后系统自动发送。

### Acceptance Criteria
- Schedule 按钮与 Send 按钮共用禁用条件（可发送才可定时）
- 时间选择器默认值 = 当前时间 + 1 小时
- 选择的时间必须在未来（≤ 当前秒级时间戳的返回 400）
- Schedule 成功后本地 status=scheduled，Drafts 列表不再显示，UI 锁为 "scheduled" 视图
- 定时发送不需要用户保持应用打开（服务器端调度）
- 到达发送时间后自动走 SMTP 发送路径，失败记录到 job store 可查
- 取消定时（cancelSchedule action）将草稿 status 回到 draft，恢复编辑

### Out of Scope
- 不做定时草稿的可视列表（当前只能通过 DB 查看 scheduled 的草稿）
- 不做定时前的二次确认（点 Schedule 直接定）
- 不做"循环定时"（每周一早上发 X）
- 不做时区选择（使用本地时区）

### Open Questions
- ~~定时发送由谁执行？~~ → **ANSWERED / closed**：Next.js `instrumentation.ts`
  内 `setInterval(60_000)` 轮询 `getScheduledDraftsDue(now)` → `sendEmail` +
  `markDraftSent`。需 `isSmtpConfigured()` 通过。
