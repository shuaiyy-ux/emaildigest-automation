## Feature: 收件箱搜索、分类过滤、一键清扫

### Why
即使分好类，每个类别下仍可能有几十封。用户要找"上周那封 TA 发的作业邮件"
需要快速按关键词搜；想只看 job 相关需要一键切换；广告和通知堆着会干扰扫视，
但一封封右键"标记已读"太慢——需要一键把噪音清掉。

### What
收件箱列表上方有：
1. 搜索框：输入关键词，实时过滤发件人 / 主题 / 摘要
2. 分类 pill 按钮：按当前列表里每个类别的邮件数降序排列，点击只看该类别
3. MailCheck 图标按钮（仅存在未读时显示）：一键把 News + Junk 类的未读邮件
   全部标记已读（不影响 Primary / Track）

### Acceptance Criteria
- 搜索实时过滤（无 debounce），匹配 from / subject / snippet 任一字段的 lowercase 包含
- 分类 pill 只在有 ≥ 2 个不同类别时显示（单一类别时无意义，不显示）
- 点击 pill 只过滤当前 Tab（Priority/Other/All）下的邮件，不跨 Tab
- MailCheck 按钮只在存在未读邮件时显示，点击后被标记的类别的未读邮件立即变已读（前端即时更新，无需刷新）
- MailCheck 不影响 Primary / Track 类别（重要邮件不会被误标）
- 搜索清空后恢复完整列表，切 Tab 后搜索框保留（不清空）

### Out of Scope
- 不做高级搜索语法（from: / has:attachment 等）
- 不做按日期范围过滤
- 不做跨分类的 AND 组合（同时满足多个 pill）—— 单选
- 不做 "undo" 一键清扫

### Open Questions
- 搜索是否需要包含 body 全文？当前只搜 snippet，body 可能存在但不搜。
