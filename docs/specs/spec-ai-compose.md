## Feature: AI 起草新邮件（Compose 模式）

### Why
Compose 场景和 Reply 不同：Reply 有原邮件作为上下文，AI 能判断语气和主题；
Compose 是"从零开始写"，用户脑子里有意图（"约教授下周二 office hour"、
"感谢招聘官的面试"），但把意图翻译成得体的英文邮件花时间。
需要一个"一句话意图 → 完整邮件"的能力，把冷启动门槛拉到最低。

### What
在 Compose 模式的草稿编辑器里，用户在 subject 和 body 字段随手写一份粗略草稿
（例如 body 写"约 Prof. Smith 下周二下午 office hour 讨论 final project"），
点击右下角 Sparkles 按钮，LLM 把它润色成完整专业邮件并回填 subject + body。
To / Cc / Bcc 不被覆盖。不新增额外输入框——现有表单即意图输入器。

### Acceptance Criteria
- 仅在 Compose 模式（非 reply / forward）的 Sparkles 按钮支持"润色草稿"
- Sparkles 按钮禁用条件：subject 和 body 都为空（给不出意图无法润色）
- 生成期间按钮显示 spinner 并禁用
- 生成成功后：subject 字段填入润色主题；body 字段填入润色正文（替换原草稿）
- 生成内容不包含任何 AI 标识（2026-04 更新：marker 机制已废除）
- 草稿语言决定生成邮件语言（中文草稿→中文邮件，英文→英文）
- 已填写的 To / Cc / Bcc 不被生成覆盖
- LLM 通过 `lib/draft-gen.ts` 直接 spawn `claude -p`，不加载任何 MCP 工具
  （比只读模式更彻底：Claude 没有任何 tool 可调）
- 生成失败（subprocess error / JSON 解析失败 / 超时）保留原草稿不变，
  显示错误 banner，用户可修改后重试

### Out of Scope
- 不根据当前时间 / 日历自动填"下周二"等日期（用户意图中什么时间就是什么时间）
- 不做多版本生成（一次一版，不满意改草稿再点）
- 不做风格学习（不模仿用户历史写作）
- 不从 To 字段的联系人反推语气（给教授和给同学都用通用语气）
- 不在 Reply / Forward 模式改变按钮行为（那里是"基于原邮件生成回复"，不是"润色草稿"）
- 不新增独立意图输入框（复用 subject / body 字段）
