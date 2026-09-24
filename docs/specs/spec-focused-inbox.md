## Feature: Priority Inbox 三栏视图

### Why
分类只是标签，用户扫邮件时仍然要一次看完所有类别。真正的需求是"先看重要的，
其他留着有空再看"。Outlook 的 Focused Inbox 模式已经验证过这种分流有效，
但它依赖黑盒规则，用户看不懂也改不了——EmailDigest 用自己的 4-bucket 分类
（Primary / Track / News / Junk）+ TTL 升级机制直接驱动。

> **关键概念**：Priority/Other/All 是**视图轴**（filter），Primary/Track/News/Junk
> 是**分类轴**（label）。两者正交：分类决定一封邮件归在哪个 bucket，视图决定
> 当前 tab 显示哪些 bucket 的邮件。

### What
收件箱顶部有三个 Tab：Priority（重要）、Other（次要）、All（全部）。

- **Priority**：满足以下任一条件的邮件
  1. `category_id === "cat_primary"`
  
  3. `primary_until > now()`（TTL 临时升级 — 严格 OTP / 同日紧急 / 显式 deadline / 快递账单兜底）
- **Other**：非 Priority 且非 Junk 的邮件
- **All**：所有非 Junk 邮件
- 每个 Tab 显示未读计数；切换 Tab 立即过滤列表

### Acceptance Criteria
- Priority Tab 邮件集 ∪ Other Tab 邮件集 = All Tab 邮件集（互斥且并集 = All）
- Junk 类邮件（`category_id === "cat_junk"`）**永远不进**这三个 Tab；要查看 Junk
  必须从 Dashboard 点击 Junk 分类卡片
- Tab 未读计数：Priority / Other / All 都显示各自未读数（保持语义一致）
- TTL 行为：`primary_until` 到期后该邮件自动从 Priority 退出，回到其原 bucket
  （Track 或 News）。下次 render 时 `isPriority(e)` 返回 false 即生效，无需后台任务
- 切换 Tab 时清空当前分类 pill 过滤（避免两种过滤叠加导致空列表）
- 刷新页面后 Tab 选中状态回到默认 "Priority"

### Out of Scope
- 不允许用户自定义哪个 category 默认进 Priority（规则固定为 cat_primary）；
- 不做"学习"（不根据用户点击行为调整分流）
- 不做跨设备同步 Tab 选中状态

### 实现锚点
- 视图判定：`web/lib/utils.ts` 的 `isPriority(e)` / `isOther(e)`
- TTL 写入：`web/lib/ttl-rules.ts` 的 `inferPrimaryUntil(ctx)`（优先级 1a > 2 > 3 > 1b：严格 OTP 30min / 同日 23:59 / 显式 deadline / 快递账单 24h 兜底）
- Tab 渲染：`web/components/mail/mail.tsx` 的 `inboxTab` state 和 `priorityUnread / otherUnread / allUnread` 计算

2026-04: `isFocused()` 已从 `utils.ts` 移除；`inboxTab` 状态统一为
`"priority"/"other"/"all"`。本条历史标注关闭。
