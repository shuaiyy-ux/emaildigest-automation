## Feature: 附件上传与发送

### Why
回老师邮件经常要带作业 PDF；回招聘邮件要带简历。没附件功能等于一半场景不能用。

### What
草稿编辑器底部 Paperclip 按钮，点击打开文件选择器。选定文件后上传到服务端，
上传成功后底部显示附件 chip（文件名 + 大小 + 移除按钮）。
SMTP 发送时附件随邮件一并发出，收件人能正常下载。

### Acceptance Criteria
- 单文件大小上限 10MB，超出在前端立即拦截并提示 "exceeds 10MB limit"
- 上传期间 Paperclip 按钮显示 spinner 并禁用
- 上传成功后 chip 显示文件名（最长 160px 截断）、大小（B/KB/MB）、X 移除按钮
- 点击 X 立即从服务端删除附件文件和 DB 记录，UI 同步移除
- 发送邮件时所有附件以 filename + path 传给 nodemailer，收件人收到完整附件
- Push to Gmail 不包含附件（由 spec-push-to-gmail Out of Scope 约定）
- 未关联草稿时（草稿尚未创建）Paperclip 按钮禁用
- 同一草稿支持多附件（累计总大小未限制，但单文件 10MB）

### Out of Scope
- 不支持拖拽上传
- 不做云存储链接（附件 > 10MB 必须走 Gmail 侧的 Drive 链接，本系统不提供）
- 不做附件预览（只显示文件名）
- 不做附件病毒扫描
- 不做附件内容去重（两次上传同一文件存两份）

### Open Questions
- 10MB 上限来自 Next.js 代理 buffer 限制；如果用户需要发大附件，
  是否需要给出指引（e.g. "点 Push to Gmail 用 Google Drive 链接"）？
