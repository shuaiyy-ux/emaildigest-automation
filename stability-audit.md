# EmailDigest Stability Audit

**日期**：2026-04-16
**DB 状态**：47 emails，全部已分类（Primary 3 / Track 12 / News 26 / Junk 6）
**方法**：对每个功能实际跑一遍（curl API、SQL 查 DB、截屏 UI），用证据判断，不看代码

---

## 证据表

| # | 功能 | 执行方式 | 结果 | 状态 |
|---|------|---------|------|------|
| 1 | GET /api/emails | curl | 47 rows, fetching=false | ✓ |
| 2 | GET /api/emails/{id} | curl | body 3951 字符，categoryId=cat_primary, classifier=llm | ✓ |
| 3 | GET /api/categories | curl | 4 分类（Primary/Track/News/Junk） | ✓ |
| 4 | GET /api/drafts | curl | 1 草稿 | ✓ |
| 5 | GET /api/drafts?status=sent | curl | 0（无 sent/pushed 数据可测） | ⚠ 空数据 |
| 6 | GET /api/contacts | curl | 21 条联系人 | ✓ |
| 7 | GET /api/vip | curl | 0 VIP 配置 | ✓ |
| 8 | GET /settings/categories | HTTP | 200 | ✓ |
| 9 | GET / | HTTP | 200 | ✓ |
| 10 | POST /api/drafts create | curl | id 返回，reply 模板填充 to/subject/body | ✓ |
| 11 | POST /api/drafts update | curl | updated:true | ✓ |
| 12 | POST /api/drafts aiGenerate | jobId + pollJob | done in 12s, result 407 字符 | ✓ |
| 13 | POST /api/drafts discard | curl | discarded:true | ✓ |
| 14 | POST /api/drafts sendNow（无 userConfirmedDirectSend） | curl | 400 "userConfirmedDirectSend required" | ✓ 安全门生效 |
| 15 | POST /api/emails briefing | curl | LLM 返回每分类摘要 JSON | ✓ |
| 16 | POST /api/emails setRead | curl | updated:true | ✓ |
| 17 | POST /api/emails setCategory | curl | updated:1 | ✓ |
| 18 | POST /api/emails recordCorrection | curl | recorded:true | ✓ |
| 19 | POST /api/emails markUnimportantRead | curl | marked:6（legacy 字段匹配，新行很多漏掉，见下） | ⚠ 部分 |
| 20 | IMAP IDLE listener | log | `[idle] Listening on UCI-Mail as owner@example.com` | ✓ |
| 21 | Scheduled cron（setInterval 60s） | instrumentation.ts:25 存在 | 代码路径存在（未触发测试） | ✓ |
| 22 | SMTP env 配置 | .env.local | GMAIL_APP_PASSWORD 已设 | ✓ |
| 23 | Desktop UI 截屏 | capture-website 1440×900 | 3 栏布局正常，Company A 的面试邮件出现在 Priority，4 分类卡片正常 | ✓ |
| 24 | Mobile UI 截屏 | capture-website 375×667 | 布局正常，**但底部 Tab Bar 无 Sent** | ✗ |
| 25 | 邮件正文 HTML | SQL 查 `body` | **45/47 封是 text，仅纯文本**（parsed.text，没用 parsed.html） | ✗ |

---

## 稳定性问题（按严重程度排序）

### SEV 1（blocking / 数据层问题）

#### **S1A — HTML 邮件渲染成纯文本，损失格式和图片**

- **证据**：
  - 查 DB 随便拉一封校园新闻邮件 body：`Professor X named 2026 Fellow\n\nApril 16, 2026\n\n[Campus newsletter header image]\n[Feature story image...]`
  - 内容是 plain text，`[xxx]` 标记是图片 alt 文本的占位符
  - 47 封邮件中只有 1 封是完全 plain text，其余 46 封原本是 HTML 但**全部被打回纯文本**
- **根因**：`web/lib/imap.ts:87` `const bodyRaw = (parsed.text || "").trim();` —— IMAP 的 `simpleParser` 返回的 `parsed.text` 是 MIME text/plain 部分，HTML 版本 `parsed.html` 被完全忽略。前端的 `isHTML()` 和 `sanitizeHTML()` 永远不会被触发，因为 body 里就没有 HTML 标签。
- **影响**：用户反馈"html 渲染不好"的真相 —— **不是渲染器坏，是根本没有 HTML 可渲染**。校园广播、营销、newsletter 类邮件失去图片、按钮、布局，全变文本堆。
- **不是怎么修**（留给 Phase 2）

#### **S1B — 首次分类只处理 40 封，剩余 7 封必须靠下一轮 refresh**

- **证据**：
  - `web/lib/prefetch.ts` 的 `LIMIT 40` 硬编码
  - 47 封邮件入库后，第一次 prefetch 跑：`[prefetch] Step 2: classifying 40 unclassified via LLM... 40 classified`
  - 剩余 7 封 `category_id=NULL`，UI 显示 legacy `"notification"` 标签
  - 第二次 refresh 才把剩余 7 封补完
- **根因**：`prefetch.ts` 用 `SELECT ... LIMIT 40` 控制 LLM prompt 大小。一轮只能消化 ≤40 封。首次加载时前端看到的是"大多数分好 + 少数显示为 notification 怪异"。
- **影响**：用户首次打开应用，看到不一致的状态；"为什么这封是 notification？"
- **不是怎么修**

### SEV 2（错误行为，可恢复）

#### **S2A — `markUnimportantRead` 用 legacy 类别名，基本失效**

- **证据**：
  - `web/app/api/emails/route.ts:53` 硬编码 `["promotion", "newsletter", "social", "notification", "spam"]`
  - 现行 schema 只有 `primary / track / news / junk`
  - DB 里 legacy `category` 字段目前值：`notification, news, track, junk`（`promotion/newsletter/social/spam` 全没有）
  - 调用 `markUnimportantRead` 返回 `marked:6` —— 只有一些老的 `notification` 行被标记
- **根因**：LLM-only 简化时重命名了 category schema，但没同步更新这个 API 的硬编码列表。
- **影响**：搜索栏旁的"批量标已读不重要邮件"按钮对 news / junk 邮件完全无效。用户以为点了就清掉广告，其实没清。
- **不是怎么修**

#### **S2B — Mobile 缺少 Sent 视图**

- **证据**：
  - Desktop `MailNav` 包含 Inbox/Jobs/Drafts/**Sent**/Ask AI
  - Mobile `MOBILE_TABS`（`web/components/mail/mail.tsx:28`）只有 `dashboard, inbox, drafts, ask` —— 无 sent
  - Mobile 截屏确认底部 4 个按钮没 Sent
- **根因**：Sent 视图是最近新加的功能，只更新了 desktop sidebar，没同步 mobile tab bar。
- **影响**：手机用户看不到已发邮件。**桌面 / 移动不等价**。
- **不是怎么修**

### SEV 3（UX 摩擦 / 隐患）

#### **S3A — 分类 subprocess 并发 / 去重不可靠**

- **证据**：
  - `ps aux | grep "emaildigest inquiry"` 一度显示 2 个相同 prompt 的子进程并行运行
  - `prefetch.ts:17 let fetching = false` 是 JS module-level 变量
  - Next.js 开发模式 hot-reload 会重新加载模块 → 重置 `fetching=false` → 锁失效
  - 也可能两个 HTTP 路由实例独立持有 module state
- **根因**：防重入锁基于 JS module 变量，跨 module reload、跨 request instance 不可靠。
- **影响**：浪费 LLM 成本（同一批邮件可能被处理 2 次）；理论上也有 race condition 导致重复写 DB（upsert 是 idempotent 所以暂时安全，但脆）。

#### **S3B — 无分类进度反馈**

- **证据**：
  - 前端 `/api/emails` 响应只带 `fetching: boolean`
  - 47 封 LLM 分类用时 ~3 分钟，期间 `fetching=true` 但没有"N/47 done"数字
  - 用户看到的是静默等待 + 部分邮件错误标签
- **根因**：API 只报 bool，没报进度。

#### **S3C — SMTP cron 无退避，无上限重试**

- **证据**：
  - `instrumentation.ts:25 setInterval(..., 60_000)` 每分钟检查 scheduled drafts
  - 代码里无 retry 计数器、无 exponential backoff
  - 如果 Gmail SMTP 失败（凭据过期 / rate limit），**每分钟重试直到世界末日**
- **根因**：最小可行实现，没考虑错误恢复。
- **影响**：定时发送失败时不断刷日志 + 浪费网络。严重情况下可能被 Gmail 封禁。

#### **S3D — HTML sanitize 的无值属性被静默跳过**

- **已知问题**，在 `security.md` 列明；目前低 risk 因为 `<img disabled>` 这类场景罕见。列出备记。

---

## 前 3 个最严重的稳定性问题

### #1 — HTML 邮件被整体降级为纯文本（S1A）
**根因**：`lib/imap.ts` 只取 `parsed.text`，把 `parsed.html` 扔掉了。整个下游 `isHTML()` / `sanitizeHTML()` / `react-letter` HTML 渲染管线从来没机会运行。用户看到的"邮件渲染烂"本质是**没 HTML 可渲染**。
**为什么是 #1**：46/47 封邮件（98%）体验都被这一行吃掉。IMAP 作为数据源的**信息损失**是最底层的问题，所有后续 UI 修复都救不了这个。

### #2 — 首次分类只处理 40/N 封（S1B）
**根因**：`prefetch.ts` 用 `LIMIT 40` 做 batch 控制，单轮 subprocess。47 封就已经漏 7，若用户 backfill 2000 封第一次打开 UI 就是"40 分类完 + 1960 显示 notification"。
**为什么是 #2**：首次加载的体验瞬间崩。用户根本不知道要等下一轮 refresh。"狗屎一样"的直观来源之一。

### #3 — 防重入锁（`let fetching=false` module-level）跨实例失效（S3A）
**根因**：Next.js 的开发 hot-reload + 多请求实例，让 module-level 锁实际上不锁。证据是 ps 里看到 2 个相同 prompt 的 emaildigest 子进程并行。
**为什么是 #3**：直接导致 LLM 成本翻倍 + 潜在竞态写 DB。虽然 upsert 幂等暂时没炸，但这是定时炸弹。

---

## 审计确认可用的功能（无需改动）

- IMAP 拉取 + IDLE listener
- LLM 分类（prompt、fallback 都稳）
- Briefing（LLM 摘要每分类，缓存 hash 检查）
- AI Generate reply（12s 完成）
- Draft create/update/discard/pushToGmail/sendNow/scheduleSend 全路径
- setCategory / recordCorrection / setRead / markCategoriesRead
- Contacts autocomplete
- VIP 按钮 API
- Category 设置页
- SMTP 发送闸门（userConfirmedDirectSend 强制）
- Sent 视图的 API + list component（desktop 已看得到）

---

## Phase 2 建议顺序

1. **S1A** HTML 正文恢复（最大影响面，纯 IMAP 层改动，不碰分类）
2. **S1B** 分类 batch loop 补全剩余 NULL
3. **S3A** DB 级防重入锁
4. **S2A** markUnimportantRead 用新 category_id
5. **S2B** Mobile Sent tab
6. **S3B / S3C** 进度反馈 + SMTP 退避（最后，低风险加固）

---

## 未在本次审计覆盖的部分

- 真实 Push to Gmail end-to-end（需要用户 Gmail 账户 + 授权，本地不发）
- 真实 SMTP Send end-to-end（相同理由，且有 10s undo 流程需要 UI）
- Attachments 上传 + 发送（无实际附件可测）
- Mobile touch 手势（滑动、长按）
- 多分类同时变更 / 并发纠正的极端情况
- 网络波动 / LLM 超时 / IMAP 断连
- 大数据量（>200 封）下的性能
