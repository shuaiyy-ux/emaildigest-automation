# 前端架构

## 技术栈

- Next.js 16（App Router）+ React 19 + TypeScript
- Jotai（轻量状态管理，4 个 atom）
- shadcn/ui + Tailwind CSS（深色主题）
- Framer Motion（分类详情弹窗 + 移动端 sheet 滑入动画）
- Lucide React（图标，**禁止 emoji**）
- `@huggingface/transformers`（浏览器端句向量，`Xenova/all-MiniLM-L6-v2`）
- `react-letter`（HTML 邮件渲染，DOM sanitize）
- nodemailer（SMTP 发送路径，可选）

> **⚠️ Next.js 版本**：`web/AGENTS.md` 警告"This is NOT the Next.js you know"。API、约定、文件结构可能与训练数据不同；修改前应读 `node_modules/next/dist/docs/` 的对应指南。

## 页面结构

| 路由 | 文件 | 说明 |
|------|------|------|
| `/` | `app/page.tsx` | 主邮件 UI（`<Mail />`） |
| `/settings/categories` | `app/settings/categories/page.tsx` | 分类管理（`<CategoryManager />`） |
| `/calendar` | `app/calendar/page.tsx` | 日历视图（FullCalendar + event sheet）|
| `/jobs` | `app/jobs/page.tsx` | Jobs 看板（桌面 kanban / 移动 accordion）|
| `/ask` | `app/ask/page.tsx` | Ask AI chat 页（本地 RAG + Sonnet 多轮流式）—— 详见 [ask-rag.md](ask-rag.md) |


## 双布局：桌面三栏 + 移动单栏

`mail.tsx` 是根组件，通过 `useIsMobile()`（`<768px`）切换两套布局。

### 桌面 (`>= 768px`)

```
┌──────────┬──────────────┬────────────────────────────┐
│  Sidebar │  Middle Col  │  Right Panel               │
│  (200px) │  (380px)     │  (flex-1)                  │
│          │              │                            │
│  MailNav │  按 view 切:  │  优先级:                    │
│  + Comp- │  inbox→MailList│ 1. composing→DraftEditor  │
│  ose btn │  jobs→ MailList│ 2. activeDraft→DraftEditor│
│          │  drafts→DraftList│3. selectedMail→MailDisplay│
│  + Link  │  ask→ (空)    │  4. 默认 → AIPanel          │
│  Settings│              │                            │
└──────────┴──────────────┴────────────────────────────┘
```

CSS：`grid h-full grid-cols-[200px_380px_1fr]`（不使用 ResizablePanel——历史 cookie/百分比问题让 grid 更稳定）。

### 移动 (`< 768px`)

```
┌────────────────────────┐
│  内容区 (flex-1)        │
│                        │
│  按 mobileTab 切:       │
│  dashboard → AIPanel   │
│  inbox     → MailList  │
│  jobs      → nav /jobs （独立页面，本 session 新增）│
│  calendar  → nav /calendar │
│  drafts    → DraftList │
│  ask       → navigate to /ask │
├────────────────────────┤
│ MobileTabBar (h-14)    │  6 tab + safe-area-pb
└────────────────────────┘

全屏 overlay（fixed inset-0 z-50）覆盖在内容区之上：
- selectedMail → MailDisplay（带 ArrowLeft Back 按钮）
- selectedDraft → DraftEditor（编辑已有草稿）
- composing → DraftEditor（compose=true）
- MailDisplay 内点 Reply/Forward → DraftEditor 二级 overlay
```

`mobileTab` 状态通过 `window.location.search` 持久化到 URL（`?tab=...`），刷新/分享链接保留位置。监听 `popstate` 还原。

## Inbox 三 Tab：Priority / Other / All

> **重要：两个正交轴**
> - **分类轴**（label）：Primary / Track / News / Junk —— 每封邮件归属一个 bucket
> - **视图轴**（filter）：Priority / Other / All —— 当前 tab 显示哪些 bucket 的邮件
>
> Priority 不是分类，是从分类 + TTL 派生出来的视图。

经典 Outlook-style 三 tab，**所有 tab 都显示未读计数**保证语义一致：

| Tab | 内容 | 未读计数 |
|-----|------|----------|
| Priority | `e.isUnread && isPriority(e)` — `cat_primary` 类 + `primary_until` 未到期的邮件 | `priorityUnread` |
| Other | `e.isUnread && !isPriority(e) && category_id!='cat_junk'` | `otherUnread` |
| All | 所有非 junk 邮件 | `allUnread` |

TTL 升级机制：Track/News 邮件如被 `inferPrimaryUntil` 打上 `primary_until`（验证码/当日截止/即将到来的 event），在到期前临时进入 Priority；到期后下次 render `isPriority(e)` 返回 false，自动退回原 bucket。无需后台 cron。

Inbox tab state 现在 canonically 为 `"priority" | "other" | "all"`；`utils.ts` 只保留 `isPriority()`，`isFocused()` 已随单信号化删除。

Junk（`category_id === "cat_junk"` 或 `category === "junk"`）**永远不进这三个 tab** — 用户要看 Junk 需从 AIPanel 点 Junk 分类卡片。

**分类 pill 过滤**（搜索栏下方）：动态生成当前 tab pool 中每分类的数量，按数量降序；Jobs 视图不显示。过滤选中 cat 时 `list.filter((e) => e.category === catFilter)`。

## 状态管理

### Jotai Atoms (`components/mail/use-mail.ts`)

```typescript
selectedAtom: string | null            // 选中的邮件 ID
viewAtom: "inbox"|"jobs"|"drafts"|"sent"|"ask" // 桌面视图
categoriesAtom: DynamicCategory[]      // 缓存的动态分类
categoriesLoadedAtom: boolean          // 加载状态
```

`useCategories()` 在 `loaded=false` 时 fetch `/api/categories` 一次，全局共享；`refresh()` 供设置页强制刷新。

### 组件本地 state

| 组件 | 关键 state | 说明 |
|------|-----------|------|
| `mail.tsx` | `emails, search, catFilter, selectedDraft, draftRefresh, mobileTab, composing, inboxTab` | 数据 + 过滤 + 草稿管理 + 移动导航 |
| `ai-panel.tsx` | `digest, digestRefreshing, digestError, digestOpen, expanded, openCategory, cardCtx, askInput` | email-digest 顶部摘要 + 4 张分类卡片（每张前 8 封邮件，无 AI 摘要）+ Ask AI 入口 + 分类详情 modal |
| `mail-display.tsx` | `full, error, composing, retryCount, confirming, confirmDismissed` | 完整邮件 + Reply/Forward + Active Learning 横幅 + Gmail-style thread stack（`threadEmails.length>1` 时切 Conversation 视图，倒序：最新在顶） |
| `mail-list.tsx` | `ctx, SwipeableItem 内部: dx, pressIntent, pulseFired` | 列表 + 右键/长按菜单 + 触屏滑动 |
| `draft-editor.tsx` | 表单字段 + `aiLoading, aiRemaining, pushing, pushRemaining, pushed, confirmOpen, sending, undoSecondsLeft, scheduled, attachments, saveStatus, fullscreen` | 完整编辑器 |
| `draft-list.tsx` | `drafts, loading, discarding` | 列表 + 删除状态 |
| `category-picker.tsx` | `saving` | 纠正中 Loader2 + "Saving" 文字 |
| `category-manager.tsx` | `categories, modalOpen, form, editing, saving, error` | 分类 CRUD |

## UX 契约（不可妥协）

4 条规则（来自用户 memory），在所有相关组件中执行：

1. **倒计时不计时**：所有 ≥ 3s 的 AI 任务显示 `Generating · {remaining}s` 剩余时间。超时立即显示 inline alert，禁止 silent spinner
2. **UI 透明**：AI Generate 显示阶段+倒计时；Push 显示倒计时；CategoryPicker saving 状态 Loader2+Saving 文字；移动端长按 200ms 加 `ring-2 ring-primary/40 ring-inset`，触发瞬间 `animate-pulse` 一次
3. **Lucide 图标，零 emoji**：所有 header 用 Lucide 或纯文字
4. **组件复用**：badge 颜色用 `getBadgeVariant`；倒计时用 `formatCountdown`；job 轮询用 `pollJob` helper

## 组件职责

### `mail.tsx` — 根组件

- **初始化**：
  - mount 时 fetch `/api/emails`
  - 每 60s 自动 `POST action=refresh` + GET（IDLE 推的邮件在 1 分钟内可见）
- **搜索**：实时客户端过滤 `from / subject / snippet`
- **Priority Inbox**：三 tab，都显示未读计数，切换保留 `catFilter`
- **markUnimportantRead**：搜索栏旁 MailCheck 按钮，`POST action=markUnimportantRead` 把 promotion/newsletter/social/notification/spam 标记已读（legacy 名称硬编码）
- **右栏优先级（桌面）**：composing > activeDraft > selectedMail > AIPanel
- **handleCategoryChange / handleToggleRead / handleMarkCategoriesRead**：本地 patch + API 调用
- **Auto-mark-read on selection**：`useRef<Set<string>>` once-per-session dedupe — 选中某邮件且未在 ref 中时，加入 ref 并若 `isUnread` 自动 `handleToggleRead([id], false)`。匹配 Gmail / Outlook 默认行为，避免每封都手动 mark。Once-per-session 设计保证用户在右键菜单 / 长按里手动改回 Unread 后再次选中**不会**再被 auto-marked。

### `mail-nav.tsx` — 桌面侧边栏

- Compose 按钮（PenSquare）—"frosted glass pill"样式
- 4 个视图：Inbox / Jobs / Drafts / Ask AI
- Settings link（`<Link href="/settings/categories">`）
- 支持 `isCollapsed`（icon-only）模式

### `ai-panel.tsx` — Dashboard

- **Greeting**：时间段问候 + unread / in-inbox pill
- **分类卡片网格**：`sortedCategories` 从 `useCategories()`（按 sortOrder，filter out `cat_spam`）
  - `emailCategoryId(e)`：先看 `categoryId`，否则 `"cat_" + (e.category || "notification")` 回退
  - `groupEmails(emails)` 按 categoryId 分组（过滤 `e.category === "spam"`）
  - 每卡片 3 状态：
    - **无邮件**（`all.length===0`）：opacity-40 紧凑卡，`self-start` 防拉高
    - **有未读**：显示数量 badge + AI 摘要 line-clamp-3 + 前 3 封未读（+N more 展开）
    - **仅已读**：opacity-60 + "无新邮件" + 最近 5 封已读
  - 右键菜单 `cardCtx`：frosted-glass `Mark all as read`
  - 点击 → `setOpenCategory(cat.id)` → Framer Motion 弹窗（移动 bottom sheet，桌面 centered modal）
- **Email digest 流程**（dashboard 顶部）：
  1. mount 时 GET `/api/emails/digest` → `{digest, refreshing, error}`
  2. 显示 `digest.generated_at` 相对时间 + "next ~Xh" 估算
  3. 若 `refreshing=true` 则 setTimeout 8s 轮询直到 `refreshing=false`
  4. Regenerate 按钮：POST `/api/emails/digest`（强制立即重生成）
- **Briefings 已退役**（2026-05-02）：之前每张分类卡片底部有一段 AI 摘要（如"You got 5 UCI campus updates: ..."），通过 `briefings` 表缓存。stale-trigger 让 merged-prefetch 几乎每个 IMAP IDLE 都 fire spawn，是 spawn 数主要来源。删除后卡片只展示前 **8 封邮件 subject**（替代之前 3 封 + AI 摘要的密度），UX 总结由 dashboard 顶部统一 email-digest 承担
- **Quick actions**：Deadlines（`digest` 命令 180s）、Follow-ups（`inquiry` 命令 120s）
- **Ask AI**（本 session 重构）：Dashboard 顶部的 "Ask anything..." 输入框和移动 Tab `Ask AI` 都 **跳转到独立 `/ask` 页**（不再内嵌单次问答）。
- Dashboard 输入框 `onSubmit` → `router.push('/ask?q=' + encodeURIComponent(q))`，`/ask` 页面用 query param 作为首条 user message 自动发出
- 移动 Tab `Ask AI` → `router.push('/ask')`
- `/ask` 独立页详见 [ask-rag.md](ask-rag.md) — 本地 RAG + Sonnet 流式多轮 chat
- **Compose 入口（移动）**：右上角 PenSquare 按钮触发 `onCompose()`

### `mail-list.tsx` — 邮件列表 + 双交互

渲染 `ScrollArea` + 邮件列表。每项：

- 未读蓝点
- 发件人名（未读 `font-semibold`）
- `HelpCircle`（`needsUserConfirm` 时）
- 日期（`formatEmailDate(receivedAt, date)`）
- 主题 + snippet（`cleanSnippet()`）
- 分类 badge（`getBadgeVariant(category)`）
- **TTL 胶囊**（本 session）：`item.ttlHint`（来自 `formatTtlHint(primary_until)`）存在时显示 amber pill "valid for Nm/h/d"；过期自动返回 null，胶囊消失

**桌面**：`<button>` + onClick 选中 + `onContextMenu` 弹 frosted-glass 菜单（`280×480` clamp 到视口）

**移动**：`SwipeableItem` 包裹：
- **右滑（蓝色）**：≥ 80px 触发 mark read/unread；≥ 180px 全屏滑出；触发后 200ms reset
- **左滑（橙色）**：≥ 80px 打开菜单
- **长按 500ms**：打开菜单。**长按 200ms 起加 `ring-2 ring-primary/40 ring-inset`**；触发瞬间 `animate-pulse` 一次
- **角度锁定**：`< 75°` 走横向 swipe，否则走纵向 scroll（`SWIPE_LOCK_ANGLE = 15` → 90-15=75）

**菜单内容**（桌面 popup + 移动 bottom sheet 共享）：
- 头部：subject + from（truncate）
- "Reclassify" section（Tag 图标）+ `CATEGORIES` from types.ts（4 个 bucket：Primary/Track/News/Junk），当前分类标 "current"
- 分隔线
- **"Classify as Job related"**（Briefcase 图标）— 点击 POST `/api/jobs action=forceClassifyAsJob`，绕过 is_job LLM gate，立即走字段抽取 + `resolveApplication`。底部浮 toast："Classifying as Job…" → "Added to Jobs — {company} · {role} · {stage}" + View board 链接（4s 自动消散）；错误态 6s
- 分隔线
- "Mark as read/unread" toggle

**关闭**：click-outside / Escape。

**Desktop swipe 禁用**：Web wheel API 无法可靠检测手势结束，trackpad swipe 不做（等以后桌面应用版本）。

### `mail-display.tsx` — 邮件详情

- **懒加载**：`useEffect` 监听 `mail.id` 变化 → fetch `/api/emails/{id}` 拿完整 body；`fetchingRef` 防过期 race
- **工具栏**：
  - Back（仅 `onBack` 时）— 移动 `h-10` 大触控
  - **GoldLabelPicker**（仅桌面 + `NEXT_PUBLIC_DEV_TOOLS === "1"`）
  - Reply / Forward（桌面右侧；移动底部 action bar）
- **Active Learning 横幅**：`needsUserConfirm` 且 `confirmDismissed !== id` 时显示 amber 横幅：
  - 文案 "AI 信心不足。这封邮件应该分到 **{currentCat.name}** 吗？"
  - Confirm → POST `/api/categories/{categoryId}/examples` action=`add` source=`user_correction` → 喂给分类器
  - X dismiss → `setConfirmDismissed(display.id)`
- **Conversation 视图（thread stack）**：当 `threadEmails.length > 1` 时切到 Gmail-style 会话栈。
  - 数据源：`mail.tsx` 用 `emails.filter(threadId === selectedMail.threadId).sort(receivedAt DESC)` 组装（**倒序**：最新的在数组头部，index 0）
  - 顶部 banner：subject + `"{N} messages"`；**不渲染**单邮件的 Avatar / from header（避让给每张卡片各自的 header）
  - 每项走 `<ConversationEmail>`：idx=0（= 最新）默认展开并带 `isLatest` 蓝色高亮边；其余折叠显示一行 snippet。点击 header 切展开；展开时 lazy fetch `/api/emails/{id}` 拿完整 body
  - 设计意图：打开线程立即看到最新回复（在顶部），往下滚动按**时间逆序**回溯历史，与 Gmail / Outlook 现代会话视图一致
- **Header**（非 threaded 视图）：Avatar + from + fromEmail + `formatEmailDate` + subject + CategoryPicker + TTL 胶囊（本 session，若 `display.ttlHint` 非 null，显示 amber bordered pill "valid for Nm/h/d"，tooltip 解释临时升 Priority 原因）
- **Body 渲染**：
  1. `stripLLMContamination(body)` 清洗
  2. 优先取 `bodyHtml`；非空则 `<Letter html={bodyHtml} />`（`react-letter` 内部 permissive sanitize：移除 `<script>` / `on*` / `javascript:` URL，保留 `<style>` 和 inline style 以维持营销邮件视觉）。外层容器 `bg-card text-card-foreground [&_a]:text-primary [&_a]:underline [color-scheme:light] dark:[color-scheme:dark]` —— `color-scheme` 告知 UA 用深色 scrollbar/form 控件
  3. 纯文本 → `parseEmailBody(cleaned)` → `<EmailBodyView parsed={parsed} />`（URL 高亮 / CTA / 签名折叠 / disclaimer 折叠）
  4. 无 body → 降级显示 snippet

  > **注**：旧版 `sanitize.ts` 的 `isHTML()` / `sanitizeHTML()` 自家 allowlist sanitizer 在切到 `react-letter` 后已删除（dead code）。XSS 防御完全依赖 react-letter 上游。
- **Error 状态**：destructive 文字 + "Retry" 按钮（`setRetryCount(c+1)` 触发 re-fetch）
- **`<AttachmentsList>` 底部**：调 `/api/emails/{id}/attachments` 拿列表，`isInline=false` 的才显示；下载走 `/api/emails/{id}/attachments/{attachmentId}`

### `draft-editor.tsx` — 草稿编辑器

详见 [draft-system.md](draft-system.md)。3 种初始化：

| Props | 用途 |
|-------|------|
| `emailId + type` | Reply / Forward 自动填充 |
| `initialDraft` | 编辑已有草稿（DraftList） |
| `compose: true` | 从零写新邮件 |

关键 constants（draft-editor.tsx 顶部）：
- `AI_TIMEOUT_SEC = 120`
- `PUSH_TIMEOUT_SEC = 60`
- `PUSHED_AUTO_CLOSE_MS = 5000`
- `AUTOSAVE_MS = 2000`
- `UNDO_SEND_MS = 10000`
- `ATTACH_WORDS_RE` — 检测 "attachment / 附件 / see the attached" 触发 forgot-attachment 警告

### `draft-list.tsx` — 草稿列表

- 渲染所有 `status='draft'` 的草稿
- 每项：类型 badge（Reply/Fwd/New）、收件人、`timeAgo(updatedAt)`（just now / Nm ago / Nh / Nd）、主题、body 首行前 80 字
- Trash2 删除：`onClick + stopPropagation()` → POST `discard` → 乐观更新（`drafts.filter`），无回滚
- 空状态：PenLine + "No drafts" + "Reply or forward an email to create one"
- `refreshKey` prop 变化时 re-fetch

### `category-picker.tsx` — 分类选择器

- Badge 触发 `DropdownMenu`
- 分类列表来自 `useCategories()`（DB-driven，按 sortOrder）
- 每项 `value = cat.id.slice(4)` 或 `cat.name.toLowerCase()`（legacy 短名，兼容 emails.category 字段）
- **Saving 状态**：Loader2 + "Saving" 文字 + `<Hint>` tooltip "Saving correction…"（取代之前不易识别的 `"..."`）
- 选择新分类：`changeCategory()`（types.ts，**并行** setCategory + recordCorrection）→ `onChanged` 回调

### `gold-label-picker.tsx` — **dev-only**

- 研究用：把邮件标记为 gold-standard，写入 `eval_set` 表，用于 classifier 回归测试
- 在 `mail-display.tsx` 工具栏中渲染，**仅 `process.env.NEXT_PUBLIC_DEV_TOOLS === "1"` 可见**
- API：`/api/emails` action=`addEvalLabel / removeEvalLabel / listEvalSet`
- UI：Bookmark / BookmarkCheck 图标 + DropdownMenu 分类选择

### `email-body-view.tsx` — 纯文本邮件渲染

渲染 `ParsedEmailBody`（来自 `lib/email-body.ts`）：

| 段 | 渲染 |
|----|------|
| CTAs | 顶部 chip 排，`<ExternalLink>` + label，`target="_blank"` |
| Paragraphs | `whitespace-pre-wrap break-words`，`renderInline` 区分 text / link |
| Signature | 折叠（`<ChevronDown/Right> <FileSignature>`），展开显示 `border-l-2 pl-3` 引用块 |
| Disclaimer | 折叠（`<Shield>` 图标），展开显示小字 `max-h-40 overflow-y-auto` |

`renderInline(part)`：`text` → `<span>`；`link` → `<a href>` primary 色 + underline。

### `attachments-list.tsx` — 邮件附件

- mount 时 fetch `/api/emails/{emailId}/attachments`
- 过滤 `a.isInline` 为 true 的（内联图片在 HTML body 里渲染）
- `iconFor(mime)`：image/* → ImageIcon；pdf/document/text → FileText；else → File
- 列表 chip：icon + filename + `humanSize` + `<Download>`（hover 显示）
- `href = /api/emails/{emailId}/attachments/{id}`，`target="_blank"`（触发浏览器下载）

### `settings/category-manager.tsx` — 分类 CRUD

- 列表渲染所有 categories：icon + name + `isDefault` badge + `exampleCount` badge（>0 显示 "N examples"，否则 "no examples"）+ Edit/Delete 按钮
- `is_default=1` 的分类**不能删除**（`disabled` + title "Cannot delete default"）
- 删除前 `confirm()` 弹窗

**`<CategoryEditModal>`**：
- Name（必填）+ Description + Icon 选择（`ICON_NAMES` from `lib/category-icons.tsx`）
- **Emails 选择**（`<EmailPicker>`）：fetch 最近 200 封，filter by 发件人/主题，checkbox 多选
- **Edit 模式额外**：`<ExistingExamples categoryId>` 列出已有 examples（过滤 `public_dataset` source，按 source 标签：`user` / `public` / `seed`），每个可单独 remove

创建：POST `action=create` with `{name, description, icon, exampleEmailIds}`，后端 seed 每个 email embedding 写入 `category_examples.source='user_correction'`，全部写完后 `trainSetfitClassifyHead({warmStart:true})` 让 SetFit head 吸收新种子。

更新：先 POST `action=update`，然后对新增 examples POST `/api/categories/{id}/examples action=addBulk`（source=`user_correction`）。

## API 路由汇总

### `/api/emails`

| 方法 / Action | 用途 |
|--------------|------|
| GET | 列表 + `fetching` 状态 + `count`；每封邮件派生 `isPriority/needsUserConfirm/primaryUntil` |
| POST `refresh` | `startPrefetch()`（增量） |
| POST `backfill` | `startBackfill()`（365 天 / 2000 封） |
| POST `markUnimportantRead` | 批量标 promotion/newsletter/social/notification/spam 已读（legacy 类名硬编码） |
| POST `markCategoriesRead` | 指定 categories 数组标已读 |
| POST `setRead` | 单封 toggle |
| POST `briefing` | 获取/生成分类摘要（见 AIPanel） |
| POST `cacheBriefing` | 缓存摘要 |
| POST `setCategory` | 批量改分类 + classifier='user' |
| POST `recordCorrection` | 记 corrections 表 |
| POST `reclassify` | 对指定 ids 重新 LLM 分类 |
| POST `addEvalLabel/removeEvalLabel/listEvalSet` | dev-only eval 集管理 |

### `/api/emails/[id]`
GET 完整邮件（含 body）。

### `/api/emails/[id]/attachments` + `/api/emails/[id]/attachments/[attachmentId]`
入站邮件附件列表 + 下载。

### `/api/drafts` + `/api/drafts/[id]/attachments`

详见 [draft-system.md](draft-system.md)。Actions: `create / update / discard / delete / pushToGmail / markPushed / markSent (legacy) / sendNow / scheduleSend / cancelSchedule / getSignature / aiGenerate`。

### `/api/categories` + `/api/categories/[id]/examples`

| 方法 / Action | 说明 |
|--------------|------|
| GET | 列出 `DynamicCategory`（含 `exampleCount`） |
| POST `create` | 新建分类 + 可选 seed examples（自动 embed + SetFit head warm-start retrain） |
| POST `update` | 改名/icon/color/sortOrder |
| POST `delete` | 删除（`is_default=1` 拒绝 400；事务内先清 emails.category_id 再删行） |
| `/examples` POST `add` | 单个 example（用户 confirm 时调用） |
| `/examples` POST `addBulk` | 批量（category manager 用） |
| `/examples` POST `remove` | 删单个 example |

### `/api/emails/digest`

GET/POST：4-section 叙事摘要（Primary / Track / News unread + Review 已读-仍活跃）。cadence = Pacific time 9/15/21 点三个 slot；客户端请求时若缓存早于最近 slot 则返回 stale 副本并触发后台 regen。`fetchCategoriedEmails` 用 `ROW_NUMBER() OVER (PARTITION BY thread_id)` 做 thread-dedup，一个 N-封来回对话只占 section 名额 1 slot 并带 `(N-msg thread)` 标记；`formatEmailLine` 通过 `stripQuotedReply` 剥掉 inline quoted history 防 Sonnet 把老内容当新内容复述。

### `/api/jobs/applications` + `/merge` + `/[id]` + `/[id]/split`

applications 聚合 CRUD：
- `/applications` GET 列表；POST `merge` 合并两张卡片
- `/[id]` GET 单卡详情 + emails；PATCH rename / 改 stage
- `/[id]/split` POST 把指定 email_id 从当前 application 剥出成新 application

### `/api/app-state`

- GET `?key=user_profile_name` → 返回 value
- POST `{key, value}` → upsert
- `ALLOWED_KEYS` 白名单（`Set(["user_profile_name"])`），其它 key 400 拒绝。Server-only keys（`embed_model`、`work_classifier_*`、`claude_auth_*`）由 instrumentation 写，不暴露给 HTTP。

### `/api/contacts`
GET 历史发件人列表（emails 表 GROUP BY from_email），DraftEditor `to` autocomplete 用。

### `/api/run` + `/api/status/[jobId]`
Subprocess job 启动 + 状态轮询。`StatusResponse = {jobId, status, result?, error?, elapsed}`。

## Hooks

### `useJob()` (`lib/hooks/useJob.ts`)

```typescript
const job = useJob();
job.run("inquiry", [q], { timeoutSec: 120 });
job.isRunning      // boolean
job.elapsed        // 后端计算的秒数
job.remaining      // timeoutSec 设置时的剩余秒数（null 否则）
job.result / job.error
```

- POST `/api/run` 后立即 `setInterval(2s)` 轮询 `/api/status/[jobId]`
- `status !== "running"` 时自动 clearInterval
- 组件卸载 useEffect cleanup 清
- `clearPolling()` 在 `run()` 开头调用，确保新 job 取消上一个

### `pollJob(jobId, opts)`（同文件，standalone）

供已拿到 jobId 的调用方（DraftEditor / AIPanel）：

```typescript
const result = await pollJob(jobId, {
  timeoutSec: 90,
  intervalMs: 3000,
  signal: ctrl.signal,   // AbortSignal
  onTick: ({ elapsed, remaining }) => setBriefingRemaining(remaining),
});
// result.status: "done" | "error" | "timeout" | "cancelled"
```

### `formatCountdown(secs)`

`60` → `"1m 00s"`, `45` → `"45s"`, `null` → `""`。

### `useIsMobile()` (`lib/hooks/useMobile.ts`)

Match media `(max-width: 767px)`，SSR safe（初始 `undefined`），mount 时设值并监听 `change`。

### `useMail()` / `useCategories()` (`components/mail/use-mail.ts`)

Jotai atom hooks；`useCategories` 在 `loaded=false` 时自动触发一次 `/api/categories` GET。

## 共享工具 (`lib/utils.ts`)

- `cn(...inputs)` — clsx + tailwind-merge
- `getBadgeVariant(category)` — assignment→destructive, job/academic→default, else→secondary（legacy 分类仍适用）
- `isPriority(e, nowSec?)` — `cat_junk` short-circuit false；`cat_primary || primary_until>now` → true
- `isOther(e, focusedIds?)` — `!isPriority && !cat_junk`

## `lib/category-icons.tsx`

- `ICON_NAMES`：Lucide 图标名白名单（for CategoryManager 选择）
- `getCategoryIcon(name)`：name → Lucide 组件；未知回退到 `Tag`

## `lib/email-body.ts` + `email-date.ts`

- `parseEmailBody(text)` → `ParsedEmailBody { paragraphs, ctas, signature, disclaimer }`（解析 URL / CTA 按钮 / 签名 / 法律声明）
- `cleanSnippet(text)` → 去掉不可见字符后截断
- `formatEmailDate(receivedAt, fallbackDateStr)` → 同日 `HH:mm`，本周 `Mon`，异年 `M/D/YY` 等

## `parseJsonObject / parseJsonArray` (`lib/parse.ts`)

清洗 markdown 围栏 + 正则匹配 JSON 后 `JSON.parse`，失败返回 `null` / `[]`，**绝不抛出**（防止 LLM 输出污染断链）。

## Subprocess 通信


## 截图验证（约定）

每次 UI 改动后用 `capture-website` 双尺寸截图：

```bash
capture-website http://localhost:3000 --width 1440 --height 900 --dark-mode --delay 3 --output /tmp/desktop.png
capture-website http://localhost:3000 --width 375 --height 667 --dark-mode --delay 3 --output /tmp/mobile.png
```

然后用 `Read /tmp/*.png` 视觉验证。Memory 规则：未截图前不允许 commit。
