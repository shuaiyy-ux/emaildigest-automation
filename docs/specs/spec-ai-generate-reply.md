## Feature: AI 生成回复正文

### Why
回邮件最慢的部分是"想怎么起头"和"确认语气是否得体"，对英文邮件尤其明显。
如果能一键生成一版"大致能用但需要微调"的回复，用户只要改几个词就能发出去，
比从空白页起草快很多。用户还可以用一句话 intent（"拒绝，语气委婉"、"确认
能出席"）精确引导 LLM 的走向。前提是这版内容不能被偷偷发出去——必须让用户
看过再决定。

### What
在 Reply 或 Forward 模式的草稿编辑器里，编辑器上方会常驻一条 intent 输入栏，
用户可以选择性地写一句意图；点击 Sparkles 图标按钮（工具栏或 intent 栏旁的
Generate 按钮），系统调用 LLM 生成回复正文并填入 Body 字段。原邮件引用块
在 UI 上折叠到下方的 "Original message" chevron 块（DB 仍保存完整 body），
LLM 生成的内容只替换用户可编辑部分。Reply 与 Forward 使用两份不同的 prompt。

### Acceptance Criteria
- 只在关联到邮件的草稿（reply/forward，非 compose）显示 AI Generate 按钮
  以及 intent 输入栏
- intent 输入栏始终可见（即便留空也可生成，空 intent 时 LLM 默认生成通用回复）
- 按钮在生成期间显示 spinner 并禁用
- 生成的正文匹配原邮件语言（英文邮件生成英文回复，中文邮件生成中文）
- 生成的正文**不包含** `[AI草稿]` 或任何 AI 标识
  （2026-04 更新：marker 机制已废除，prompt 明确禁止输出该字符串）
- LLM 的输入上下文包含：原邮件正文（前 2000 字）、同 thread 最近 3 封兄弟邮件
  （`getThreadEmails(threadId, emailId, 3)`）、用户 intent 文本、`app_state.user_profile_name`
- LLM 只输出回复正文；不输出 Subject 行、不输出引用块（引用块由前端负责拼回）
- 如果 body 里已有引用分隔符（"\n\n---\n" 或 "\n\n---------- Forwarded"），
  生成内容替换分隔符之前的部分，分隔符之后的引用块保留
- 如果 body 里无分隔符，生成内容替换整个 body
- 执行路径直接 spawn `claude -p`（`lib/draft-gen.ts` 的 `generateDraft(prompt)`），
  `cwd=os.tmpdir()`，**不加载任何 MCP 工具，也不注入 safety.txt / inquiry.txt**
  (比 readonly 模式更彻底：Claude 进程里没有任何 tool 可调)
- 生成失败或超时不改动 body，保留用户已有内容

### Out of Scope
- 不做风格学习（不根据用户历史邮件模仿语气）
- 不做多版本生成供选择
- 不做"AI 建议"（只能整段替换，不能只改一句）
- 不带附件建议或日程提取

### 2026-04-21 changes
- marker 废除：prompt (`web/lib/draft-prompts.ts:57`) 明确禁止输出 `[AI草稿]`；
  send-time 弹窗提醒也同步移除
- shell 旁路：不再走 `runCommand("inquiry", [...], {readonly:true})` →
  `./emaildigest` 脚本 → safety.txt + inquiry.txt 的链路；改为 `lib/draft-gen.ts`
  直接 spawn `claude -p`，zero-tool 沙盒
- intent + thread + forward 拆分：DraftEditor 新增 intent 输入栏；prompt 上下文
  加入 thread 兄弟邮件；forward 走独立 prompt 分支（`forwardPrompt`）
