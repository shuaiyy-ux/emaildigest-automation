## Feature: Dashboard 分类 AI 摘要

### Why
即使有 Priority Inbox 分流，用户还是要逐个打开邮件才知道它在说什么。对于
News / Junk 这种没打算细看的类别，用户真正想要的是"这堆里有没有我需要关心的"
——一句话 AI 总结就够了。对重要类别（Primary / Track），摘要能让用户决定
先处理哪封。

### What
首次进入应用或切回 Dashboard 时，右侧面板显示每个分类的卡片：
- 卡片头：图标、类别名、未读数
- 卡片体：AI 生成的 1-2 句中文摘要 + 该分类下最近 3 封邮件的发件人 + 主题
点击卡片展开弹窗，看该分类下所有邮件。
每个动态分类（categories 表）一张卡片，按 sortOrder 排列；Junk 卡片不在主网格中显示。

### Acceptance Criteria
- 分类卡片按 categories 表的 sort_order 升序展示（默认 Primary → Track → News）
- 空分类显示灰色紧凑占位（不消失，保持布局一致）
- 摘要仅针对未读邮件生成（已读不浪费 LLM token）
- 首次请求摘要走 LLM 生成；邮件集未变时下次进入直接走缓存（零 token 消耗）
- 邮件集变化时，只对"变化的分类"重新生成摘要，未变的分类复用缓存
- **主动预热**（2026-04-17 新增）：prefetch 管线 Step 4 在每次邮件到达后自动
  调 `refreshStaleBriefings()`，stale 类别直接后台 LLM 生成并写 `briefings` 表；
  用户打开 Dashboard 通常直接命中缓存、无倒计时
- Junk 分类不在主网格中显示（用户从专门入口查看）
- 摘要加载中显示骨架，完成后不闪烁替换（渐入）
- 组件卸载后若 LLM 还没返回，结果被丢弃不 setState（防 unmounted warning）

### Out of Scope
- 不做摘要手动刷新按钮（依赖邮件集 hash 自动判断）
- 不支持用户自定义摘要 prompt 风格
- 不做跨 session 同步缓存（浏览器本地 SQLite 缓存）
- 不在摘要里链接具体邮件（只概括，不精准引用）

### Open Questions
- 摘要粒度是"1-2 句"还是"bullet 列表"更符合用户扫视习惯？
  → 看实际使用 feedback
