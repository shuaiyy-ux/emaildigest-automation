## Feature: 本地草稿编辑（回复 / 转发 / 新建）

### Why
Gmail 的草稿同步有几秒延迟，写一半切页面可能丢。用户需要一个"不论发生什么
都能找回"的本地暂存：关闭浏览器再开仍在、断网继续写、AI 生成失败不丢已写内容。
发出之前一切先在本地。

### What
从邮件详情页点击 Reply / Forward，或从 Dashboard 的 Compose 按钮新建邮件，
会打开一个草稿编辑器。编辑器顶部显示类型 badge（Reply / Forward / New）+
自动保存状态。表单字段：To（支持 Cc/Bcc 展开）、Subject、Body。
侧边栏 Drafts 视图列出所有未发出草稿，点击进入继续编辑，右侧 Trash 图标放弃。

### Acceptance Criteria
- Reply 自动填充：to=原发件人邮箱，subject="Re: ..."（已有 Re: 不重复），
  body=带引用分隔符 + 原文每行 "> " 前缀
- Forward 自动填充：to=空，subject="Fwd: ..."（已有 Fwd: 不重复），
  body=含 "---------- Forwarded message ----------" 块 + 原文
- Compose（新建）：三字段全空
- reply/forward 模式下，回复区 textarea 只显示用户编辑部分；引用块（> 前缀
  + On <date> wrote:）折叠到下方可展开的 "Original message" chevron 块中
  （存储不变，纯展示层分离）
- 编辑任何字段后 2 秒内自动保存（防抖），状态条显示 Saving → Saved
- 放弃（X 按钮 / Trash 图标）为软删除，status=discarded，Drafts 列表立即消失
- Drafts 列表仅显示 status=draft 的草稿，按 updated_at 降序
- To/Cc/Bcc 输入非法邮箱格式时字段变红，但仍允许保存（只在 Send 时阻塞）
- Esc 键关闭编辑器（非全屏 / 非发送倒计时时）
- 切换不同草稿时编辑器 remount，不残留上一封状态

### Out of Scope
- 不做草稿历史版本 / 版本回滚
- 不做富文本编辑（只有 plain text）
- 不做草稿分享 / 多人协作
- 不做跨设备同步（本地 SQLite 独立）

### Open Questions
- 2 秒自动保存防抖窗口是否合适？长文本打字时可能一直在 Saving 状态。
