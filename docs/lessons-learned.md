# EmailDigest — Lessons Learned

工程实践经验集。每条都是在这个 repo 上真踩过的坑，按影响从高到低排序。新 session 开工前值得扫一眼。

---

## 1. 删 feature = 同步删文档

**坑**：VIP 功能被移除（数据表 drop、组件删、API 去）但设计文档里仍有 VIP 段落。CLAUDE.md 用 `@docs/design/*.md` 自动注入，每次 session 的 AI 都继续相信 VIP 还在；真跑 `SELECT FROM vip_senders` 时才报 "no such table"。

**机制**：只删代码是半成品。`CLAUDE.md` 通过 `@` 语法把 docs/design/*.md 加载进每次对话上下文。stale doc = stale context = wrong AI output。

**规则**：

```bash
# 删任何 feature 前跑一次（同一 commit 里完成）
grep -rn "<FeatureName>\|<table_name>\|<component-name>\|/api/<path>" \
  docs CLAUDE.md README.md
```

**只要 grep 还有命中，删除就没完成。**

同样适用：重命名组件、API 迁移、schema 改动、依赖库切换。

---

## 2. 跨语言 RAG：query-time 翻译，不是 embedding-time

**第一版错法**：用户要中英混合检索，我切换到多语言 embedder（`paraphrase-multilingual-MiniLM-L12-v2`）。

**踩坑**：
- 多语言模型对英文 in-domain 精度**比单语言英文模型差**
- 下载 465MB 模型文件
- 所有已有 embedding 都要重算（触发 Step 2a 跳过 + Step 1.5 补丁问题，见 #4）
- 引入多语言模型的"宇宙里什么都稍微会一点"的平庸表现

**正确做法**：embedder 保持单语言（英文），**让 Sonnet 在调 search_emails tool 之前翻译 query**。例如 `"毕业礼服"` → `"graduation gown regalia commencement"`。

**Why**：Sonnet 的翻译能力远超 MiniLM 的跨语言嵌入精度；且这个翻译是一次性成本（每 query 一次），不是 embedding-time 成本（每封邮件一次）。

**规则**：embedding 层要特化（最好用户语种专门的），其他语言在 query-time 由 LLM 处理。

---

## 3. Agentic retrieval > 强制前置 RAG

**第一版错法**：`/api/chat` 无条件先跑 `retrieveRelevant()`，把 hits 塞进 prompt，然后才调 Claude。

**踩坑**：
- 闲聊（"你好"、"谢谢"）也吃 RAG token
- 不需要 inbox 的问题（"帮我写段代码"、"什么是 OAuth"）被无用邮件污染
- 单次问答固定路径，Claude 无法多轮深挖（调 search → 再调 search with different query）

**正确做法**：Claude 自主决定何时调 `search_emails` MCP 工具。系统 prompt 明确"闲聊直接答；要 inbox 数据就调工具；首次命中 < 3 就换英文 synonym 再搜一次"。

**规则**：**让 LLM 决定是否检索**，而不是替它决定。只在明确的分类任务上用强制 RAG。

---

## 4. `embedding` 列自愈：Step 2a 不会覆盖已分类行

**坑**：切 embedder 模型时写了 `UPDATE emails SET embedding = NULL` 迁移。以为下次 prefetch 会自动重算。

**真相**：`prefetch.ts` Step 2a 只处理 `WHERE category_id IS NULL AND classifier NOT IN ('user','llm')` 的邮件。你 78 封已分类邮件永远不会被碰——它们的 embedding 永远是 NULL，Ask AI 的 `search_emails` 看不见它们。

**修复**：加 **Step 1.5** 无条件扫 `WHERE embedding IS NULL AND body != ''` 并补算（只写 embedding，不改其他字段）。上限 50/run，下次 prefetch 继续补。

**规则**：**embedding 字段要有幂等自愈路径**，不能假设业务逻辑路径会触发。

---

## 5. 项目级 MCP server 在 `claude -p` 模式下默认不被信任

**坑**：`.mcp.json` 项目级配置要求首次使用时交互式 approval（"do you trust this server?"）。`claude -p` 非交互模式默认拒绝，MCP server 进入 `failed` 状态，Claude 没有工具可调 → **瞎编说"需要授权访问本地邮件数据库"**。

**诊断难点**：Claude 的幻觉消息看起来像真实的权限请求，用户以为是系统设计问题。stream-json 输出里 `mcp_servers: [{status:"failed"}]` 是唯一的真实信号。

**修复三联**：

```
--mcp-config .mcp.json          # 显式路径加载，绕过信任提示
--strict-mcp-config             # 只用我们的配置，忽略全局 MCP
--permission-mode bypassPermissions   # 允许非交互模式调工具
```

**规则**：生产代码调 `claude -p` + 项目级 MCP 时，上面三个 flag 缺一不可。

---

## 6. AI SDK v4 ≠ v5：协议完全不同

**坑**：以为 `ai` v5 的 `useChat` 和 v4 的 data-stream 协议兼容。v4 用 `0:"text"\n` / `9:{...}` 格式，v5 用真正的 SSE (`data: {json}\n\n`) + typed parts (`text-delta`, `tool-input-available`, etc)。

**我们做过的错**：v4 协议发给 v5 `useChat` → 空白消息、无报错。

**规则**：

- v5 headers：`Content-Type: text/event-stream` + `x-vercel-ai-ui-message-stream: v1`
- v5 part types：`start` / `start-step` / `text-start` / `text-delta` / `text-end` / `tool-input-available` / `tool-output-available` / `data-<name>` / `finish-step` / `finish` / `[DONE]`
- v5 自定义数据：用 `data-<name>` part type，前端 `onData` 回调接收
- `@ai-sdk/react` 的版本决定了哪版 `ai` peer 兼容（v3.0.170 要 `ai@6`）

---

## 7. Dead code / 死文件 / 孤儿资源累积比你想的快

**60 天里攒出来的债**：

| 类别 | 例子 |
|---|---|
| 废弃模型 | `Xenova/bart-large-mnli` 1.5GB + `paraphrase-multilingual-MiniLM-L12-v2` 465MB |
| 废弃 UI 库 | `@schedule-x/*` 切到 FullCalendar 后未 uninstall |
| 废弃工具 | `chrono-node` / `ical-generator` / `react-resizable-panels` |
| 废弃函数 | `getCorrectionBias`, `deleteCentroid`, `getBaseCentroid` 等 |
| 废弃文件 | `lib/ask/prompt.ts`（agentic 迁移后）、`lib/job-classify.ts` stub |

**单次手动清理收益**：1.95GB → 1.5GB，即 **23% 磁盘 + 无数条死代码**。

**工具链**：

```bash
cd web && npx knip                  # 扫未用 files/exports/deps
find . -size +50M -not -path '*/node_modules/*' -not -path '*/.git/*'  # 磁盘孤儿
du -sh node_modules/@*/...          # 大包审计
```

**规则**：每次切库 / 删 feature / 升主版本后跑一次。HF 模型 cache + puppeteer Chromium 这类大 binary 不会自动清理，`find -size +50M` 是最低成本的兜底。

---

## 8. 单用户部署：本地是 source of truth

**多端 IMAP IDLE 的幻觉**：本地 Mac 和生产服务器都跑 IMAP IDLE 各自入库，以为"同步"。

**真相**：两边的 `data.db` 会在任意时刻不一致（分类结果、user corrections、maybe_work 标签）。没有 CRDT / 冲突解决。

**单用户接受的事实**：承认本地是权威，deploy 时整包覆盖云端 data.db + code。5 秒 downtime 换简单性。

**规则**：不要假装双向同步；多机架构的复杂性对单用户部署是纯负收益。

---

## 9. CLI 多轮对话：用官方 `--resume SESSION_ID`，别自己造轮子

`claude --resume <sid> --output-format stream-json --include-partial-messages`：
- Session 持久化在 `~/.claude/projects/*/sessions/<sid>.json`
- `--include-partial-messages` 给更细粒度的 text delta
- 前端存 sid 到 URL `?sid=xxx`，刷新保留

**规则**：有现成的 session 机制就别自建 history array 传递逻辑。

---

## 10. Cloudflare tunnel：不同 environment 开不同 tunnel，别复用

**坑**：想把测试域名从本地已有的 tunnel 切到生产服务器，试图让 cloudflared overwrite CNAME 失败（因为现有 CNAME 已指向 tunnel，CF 拒绝覆盖）。

**正确做法**：起第二个 tunnel（生产专用），分配一个新子域。原测试域名继续指向本地作 dev / 测试，新子域指向生产服务器作 prod。两条完全解耦。

**规则**：hostname 和 tunnel 是 1:1 绑定；想换 origin 最简洁的方式是新 hostname。

---

## 11. 阈值要经验校准，不要拍脑袋

MiniLM 在小样本（~70 邮件）池上 cosine 均值 0.30-0.40。拍脑袋定 0.35 → 大部分 query 命中 < 4 封。

**正确做法**：写个 `scripts/validate-rag.ts` 跑 15 条 diverse query，报每阈值的命中分布 + top-10 人工 sanity check → 数据说话定 0.30。

**规则**：任何涉及阈值 / 权重 / margin 的参数，**先跑一次 distribution 分析**，别信直觉。脚本留在 repo 里做审计轨迹。

---

## 12. SQLite WAL + 热备份：用 `.backup` 不要 cp

```bash
# ❌ 错：WAL 未 checkpoint，快照不一致
cp data.db /tmp/snap.db

# ✓ 对：online backup，WAL 合并，一致性保证
sqlite3 data.db ".backup /tmp/snap.db"
```

任何同步 / 备份数据库的部署脚本都必须用 `.backup`，尤其 next-server 在写 WAL 时。

**规则**：WAL 模式 DB 不要 `cp`。

---

## 13. Secrets 双通道隔离

测试域名 (dev) 和生产域名 (prod) **必须用不同 token**。

**Why**：
- dev 泄露不影响 prod
- 本地代码 bug 打错环境不会撞生产
- 轮换 prod token 不影响本地调试

**实现**：两份 `.env.local`（各自不同 `EMAILDIGEST_AUTH_TOKEN`）—— 一份在本地 Mac，一份在生产服务器。两端都 `0600` + git-ignored。

**规则**：多 environment 就多套 secret，别图省事共用。

---

## 14. 工具调用的边界：narrow > general

MCP 工具暴露给 Claude 的**故意只有 3 个**：`search_emails`、`read_full_email`、`get_application`。**不暴露** `list_emails / query_db / execute_sql`。

**Why**：
- 通用查询让 Claude 绕过语义搜索做全表扫描 → 看到本该被 relevance 过滤掉的邮件
- 无界查询容易稀释回答质量
- 安全边界模糊（Claude 能写任意 WHERE）

**规则**：MCP 工具设计默认**狭窄**。每个工具只做一件事，参数尽量少。需要通用查询时单独加对应工具，别给 Claude 一个 `sql_query(x)` 万能口。

---

## 15. `/api/internal/*` 走 localhost gate，不走 bearer auth

MCP server 是本地 subprocess，调 Next.js API 不方便传 bearer token。但外部不能访问这些内部端点。

**解法**：middleware 检查 `Host` header：

```ts
if (path.startsWith("/api/internal/")) {
  const host = req.headers.get("host")?.split(":")[0];
  if (["127.0.0.1", "localhost", "::1"].includes(host)) return NextResponse.next();
}
```

外部请求通过 CF tunnel 进来时 Host 是公网域名，落到正常 auth 链路 → 401。内部 MCP 直连 `127.0.0.1:3000` → 豁免。

**规则**：本机内部服务调用用 loopback + Host header 判断，不要发明新 auth 机制。

---

## 16. 静默失败 — UI 隐含承诺，后端偷偷不做

2026-04-21 一次审查抓出 9 个同类错误。都是一个母模式：**UI 文案 / 结构让用户以为系统在做 X，实际代码不做 X（或做了但失败被吞）**。不是偶发 bug，是结构性陷阱。

**共同机制**：成功路径闭环，**失败路径 / 时序路径没闭环**。代码实现了 happy path，忘了把 "失败" 或 "还没到时间" 接回 UI。

### 7 种反模式

#### 16.1 Lazy-stale 冒充 scheduled

UI 显示 `updated 4h ago`，用户以为系统会自己 refresh。实际只有用户访问时才触发 regen。用户不看 → 永远 stale。

- **触发**：加了"固定时间刷新"的需求，只改了 staleness 判据，没加真正的定时器
- **例**：daily digest 定 9/15/21 PT → 只改 `isStale()` → 早上 9 点到了也不自己跑
- **修**：要么加 `setInterval` 定时检查并触发 regen，要么 UI 文案改成 `next refresh at 3:00 PM PT`（让用户知道要自己来看）

#### 16.2 Cron 无限重试没 UI 上报

后台 cron 每 60s 重试失败操作，但失败状态从不冒泡到 UI。用户不知道东西坏了。

- **例**：scheduled drafts SMTP 凭据失效 → cron 每 60s 重试直到进程重启；UI 一直显示 "scheduled for 2 PM"
- **修**：
  - DB 加 `send_attempts` + `last_error` 字段
  - 连续 N 次（如 5）失败 → 断路（`status='send_failed'`）
  - UI 把失败项目醒目列出 + Retry 按钮

#### 16.3 健康 probe 间隔 >> 调用者失败延迟

probe 每 30min 一次。token 在两次 probe 之间失效 → 30min 内每个调用者都静默失败，UI banner 还显示 `ok`。

- **例**：Claude CLI auth probe 30min；IMAP IDLE 纯靠 5s 重连 loop，没有认证判别
- **修**：**调用者失败时立刻更新健康状态**，probe 只是兜底。

```ts
// subprocess 错误回调里
if (code !== 0 && /auth|login|unauthor|session expired/i.test(stderr)) {
  setAppState("claude_auth_status", "failed");
  setAppState("claude_auth_error", stderr.slice(0, 200));
}
```

#### 16.4 Exit code 0 ≠ 副作用发生

Subprocess 正常退出但实际没干事。盲信 exit code → UI 标 "完成"，后端可能根本没写。

- **例**：Push to Gmail 走 Claude CLI → subprocess 退 0 但可能没真调 `gmail_create_draft`；代码照样 `markPushed`
- **修**：解析 stdout 找显式成功标记（draft id / "created" 字样）再 mark。无标记 → 当失败处理。

#### 16.5 API handler 里同步 CPU 工作

ML 训练 / 大计算 await 在 handler 里。用户点一下卡几秒没反馈。

- **例**：Jobs 看板 remove → 同步 `trainWorkClassifier({warmStart:true})` 50 epoch → 请求挂 ~1s
- **修**：fire-and-forget，handler 立刻返回。

```ts
// before
trainWorkClassifier({warmStart: true});   // sync, 1s
return Response.json({ok: true});

// after
queueMicrotask(() => {
  try { trainWorkClassifier({warmStart: true}); }
  catch (e) { console.error("[retrain] failed:", e); }
});
return Response.json({ok: true});
```

#### 16.6 多步 DB 变更无事务包裹

A / B / C 三步改 DB，中间一步 throw → 半 done 状态。

- **例**：setCategory B 路径 "旧 cat 删 example → recompute 旧 centroid → 加到新 cat → recompute 新 centroid → 改 `email.category_id`"；中间 throw 邮件从两个类别都掉出去
- **修**：`db.transaction(() => { ... })()` 包整条链。better-sqlite3 的 transaction 会自动 BEGIN/COMMIT/ROLLBACK。

#### 16.7 异步 regen 错误被吞，UI 轮询死循环

`regenInFlight = heavyOp()` 的 Promise 异常只 console.log，不进 state。API 一直返回 `{refreshing: true}`，UI 每 8s 轮询，永远转圈。

- **修**：state 留错误槽；API 把 error 也返回；UI 看到 error 停止轮询 + 展示 Retry。

```ts
let lastError: { message: string; at: number } | null = null;
regenInFlight = heavyOp()
  .catch((e) => { lastError = { message: String(e), at: Date.now() }; throw e; })
  .finally(() => { regenInFlight = null; });

// API
return Response.json({ digest, refreshing, error: lastError });
```

### 自查清单

改动涉及下面任一项时对照过一遍：

- [ ] 加"固定时间刷新"：真有 `setInterval` / 真 cron 吗？还是只改了 staleness 判据？
- [ ] 加 cron 重试：失败能被 UI 看见吗？有断路器吗？
- [ ] 健康检查 probe 间隔 > 5min：调用者失败时有"立刻上报"路径吗？
- [ ] Subprocess / 外部 API："成功" 只看 exit code 还是验证了 side-effect？
- [ ] API handler 里有 > 200ms 同步工作：能 fire-and-forget 吗？
- [ ] 多步 DB mutation：`db.transaction()` 包了吗？
- [ ] 返回 `{refreshing: true}` 的 API：错误时 UI 怎么跳出轮询？

**元规则**：做改动时不只想 happy path。问自己 "失败路径怎么回到 UI"、"时间没到时 UI 看到什么"。想不出答案就是漏了。

---

## 17. 两个系统各自维护"同一件事"的正则 → 必然漂移

**坑**（2026-04-24）：`ttl-rules.ts` 和 `event-extractor.ts` 各自维护"这段文字有没有日期"的判断。TTL Rule 3 内联 `MONTH_RE` 字符串；event_extractor 当时完全没有前置 gate（86% LLM 调用返回 `[]` 烧 token）。一旦一侧要加 pattern（例如 ISO `YYYY-MM-DD`），另一侧不同步，行为就漂移：TTL pill 认得、gate 放进 LLM 但解不出；或反过来 gate 过、TTL 没升级。

**机制**：两个系统在语义上做同一件事（"这是不是一个时间/日期"），却各写各的。概念单一来源被拆成两份 = 必然漂移。

**修法**：抽共享常量到 `web/lib/time-patterns.ts`，所有消费者 import 同一组 `TIME_RE / EXPLICIT_DATE_RE / MONTH_DAY_RE / CHINESE_DATE_RE`。**专属部分**（TTL 的验证码、同日紧急、deadline 关键词）留在 `ttl-rules.ts` 自己的文件。只把"通用日期识别"这一层共享，不把整个 rule pipeline 合并。

**不能直接塞进 gate 的 pattern**：weekday-only（`Mon / Thu`）在子串位置会误触发 "mon"/"Thu" 噪声，本地测出 3-10 天日期漂移。weekday 识别归 `ttl-rules.ts parseDateClause` 的精确解析路径（那里有上下文约束），不进"这是不是日期"的粗筛。

**元规则**：当两个地方"听起来在做一样的事"，在写第二个之前先抽第一个。等漂移发生再修，成本比预防高 10 倍。

---

## 18. LLM scope invariant：哪些邮件 LLM 永远不该看，要显式断言

**坑**：event_extractor 对所有 primary/track/... 邮件跑 Sonnet 子进程，但 News（newsletter / 新闻流）和 Junk（营销）按定义不含用户日历事件。SQL 里混了 legacy OR 条件（`category IN ('primary','track','academic','assignment','job')`）— 所有行 category_id 都已补齐后这条 OR 是死代码，但读代码的人摸不清意图。

**修法**（本 session）：
1. **SQL 硬约束收窄**：`category_id IN ('cat_primary','cat_track')`，去掉 legacy OR
2. **写断言脚本**验证不变量：`SELECT COUNT(*) FROM events ev JOIN emails e ON e.id=ev.email_id WHERE e.category_id IN ('cat_news','cat_junk')` 必须 = 0
3. **入口处再 gate 一次**：`event-extractor.ts extractEventsForBatch` 起手也对每封 candidate 调 `hasTimeSignal`。防外部脚本 / API 绕过 SQL gate 直接喂邮件进来

**元规则**：LLM 成本是指数级的。定义**显式的负向集合**（News/Junk 永不看）+ 写 invariant 检查 + 在 SQL 和函数入口都 gate，三层保险。不要只靠"当前调用者都走 SQL"这种弱隐含契约。

---

## 19. 多规则 ranker：specific > generic fallback

**坑**（2026-04-24 replay 抓到）：把"快递/账单"兜底 24h 规则（1b）放在"今天到期"（Rule 2）和"显式日期"（Rule 3）之前，一封 "Reminder: your payment is due today" 会被 1b 的 `payment` 关键词抢成 anchor+24h，而不是 Rule 2 的"今天 EOD"。Rule 1b 是没更好信号时才用的默认，不能先于精确语义。

**修法**：优先级 **1a > 2 > 3 > 1b**。1a（strict OTP）30 分钟永远赢；精确语义（"today" / 具体日期）必须先于 generic 兜底。

**元规则**：多规则 ranker 里，**越具体的信号优先级越高，越 generic 的越靠后**。兜底规则存在的意义是"前面都没命中时给一个合理默认"，一旦它在前面，就变成"抢占所有人"。通过 replay test（跑 DB 里所有 `primary_until>0` 的邮件对比 before/after）可以一次抓出这类反序。

---

## 20. email body 里藏着上一轮对话 → 多个 LLM 消费者同时中毒

**坑**（2026-04-24）：`simpleParser(msg.source).text` 只剥最外层 MIME wrapper，**不剥 inline 引用**。Outlook 风格用 `________________________________` + `From:/Sent:/To:/Subject:` 头块把上一轮对话回显在 body 里；Gmail 风格用 `> ` 前缀或 `On <date>, <name> wrote:` 尾块。实测 5-封 thread 的末封 body 4326 字节，真·新内容只有 162 字节（96% 是历史引用）。

**后果是广谱的**：所有直接读 `emails.body` 的 LLM / embedder / chunker 都跟着中毒：
- Daily Digest Sonnet 把 Professor X 上周的原话当成新内容复述
- event-extractor 在 N 封同 thread 邮件里各抽一次同一事件 → calendar UI 重复
- jobs-pipeline 对 stage 判断被旧对话回响干扰
- embedder 向量被 boilerplate 引用稀释，分类质心飘

**修法**：写一个共享 `stripQuotedReply(body)` 放 `web/lib/reply-quote.ts`，5 条 pattern（"On X wrote:" 尾块 / `_{10,}` 分隔 / inline `From:\nSent:` 块 / 晚出现的 `Subject:` 行 / `> ` 前缀块）+ 安全阀（过剥 >90% 且 <40 字回退原文）。先应用到最痛的消费者（本次 Daily Digest），其它消费者按出问题的先后顺序各自接入 —— **共享一份函数，避免各消费者自写一套漂移**（§17 的同类教训）。

**Daily Digest 配套修法**：thread dedup（`ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY received_at DESC)`）保证一个 5-封 back-and-forth 只占 section 名额里的 1 个 slot，prompt 里用 `(5-msg thread)` 标记 + 明确 instruction 告诉 Sonnet"这是一个对话，一句话总结"。strip（body 级）和 dedup（row 级）是两个正交问题，都要做才彻底。

**验证方法**：写一个 replay 脚本（`/tmp/reply-strip-validate.js`），跑 DB 里所有多邮件 thread 对比 before/after 字节；同时跑 solo-email safety check 确认 regex 不过剥。一次脚本跑完，both positive (thread 缩减) and negative (solo 保持) 都有数据支持。

**元规则**：当数据有"主体内容 + 随附元数据"的结构（body + 引用历史、email + 签名、HTML + style 标签、PDF + 水印），预处理阶段要把二者分开，不要把"看起来像内容的元数据"喂给下游 LLM/向量。每个下游消费者各自判断成本高、漂移多。

---

## 21. 平行实现漂移：四层防御

**§17（regex 漂移）/ §20（多消费者读 body）/ briefings vs daily-digest prompt 漂移（briefings 已于 2026-05-02 整体退役，避免再漂）/ API briefing 路径绕过 prefetch merged 路径** 都是同一个 meta 问题的实例：**同一规则被复制到两个以上的地方实现，改一处忘记另一处**。这个 §21 把方法论显式列出来，下次写新代码 / 改老代码时按层走。

### Meta 现象

代码里有两段语义上做"同一件事"的逻辑（同一个 SQL where、同一个 boolean condition、同一个 magic string、同一段 prompt 规则），分散在不同文件里。改其中一处，**永远会忘**另一处，结果：
- 单个 commit 看着是 fix，实际只盖了一半
- 用户测出来的 bug 是"还有 X 处没改"
- 下次 grep 出第二处时，是事故复盘，不是预防

**信号**：用户说"还有 X 处也要改"或"为什么 Y 还没生效" → 你之前漏了平行实现。

### 4 层防御（从最根本到最务实）

#### Layer 1：结构（DRY）— 一个规则只能有一个实现

不靠纪律，靠类型/抽象不让平行存在。

**正例（已做）**：
- `applyClassifyResults` / `applyJobsLLMResults` / `applyBriefingResults` — merged 路径和 fallback 路径都调它们，行为漂移不可能发生（commit `72cb7ba`）。
- `time-patterns.ts` 共享 regex（§17 的修法）— `ttl-rules.ts` 和 `event-extractor.ts` 共用同一组日期 pattern。
- `stripQuotedReply` 共享函数（§20 的修法）— Daily Digest / event-extractor / 其他消费者都调同一份。
- `groupUnreadForBriefing` — briefings 的"哪些邮件入组"唯一来源，不会有两个版本。

**应该做但还没做（截至 2026-05-01）**：
- `isJunkCategory(cat)` 应该抽进 `lib/category-helpers.ts`。现在 `cat.id === "cat_junk" || (cat.name || "").toLowerCase() === "junk"` 这个 check 至少在 `ai-panel.tsx` 和 `briefing.ts` 各写一份。
- `lib/prompts/shared-format.ts` — briefings + daily-digest 共用的 density rules / aggregation 模板 / 缩写白名单 / good/bad examples 应该抽出来。今天（2026-05-01）刚因为漏改 daily-digest 又漂了一次。
- `CategoryIds` 常量 — magic string `"cat_junk"` / `"cat_primary"` / `"cat_news"` / `"cat_track"` 散在十几个文件，应该 `CategoryIds.JUNK` 等。

**抽取的判断标准 — Rule of Two**：看到第二处复制就抽，**不等到第三处**。等第三处出现时，你已经把第一个 bug 寄到生产了。

#### Layer 2：类型 / 测试 — 让漂移当场报错

如果一时不能合二为一（不同模块、不同生命周期），让两份代码"绑在一起"：

- **TypeScript 判别联合 + 强制 exhaustive switch**：加新分类时编译器逼你处理每个 case，漏一个直接编译失败。
- **共用类型签名**：两条路径都接受 `MergedInputs` 等类型，加字段时两边都要改（type error 顶在前面）。
- **小型对比测试**：关键的两条路径写最低限度的 invariant 测试。例：classify 单 spawn 和 merged classify 段，给同一批邮件应该产出相同 categoryId set。
- **Snapshot 测试**：prompt 输出 / SQL 生成的 query 字符串等可以走 snapshot，diff 即漂移。

EmailDigest 项目目前测试覆盖率低。最低成本的添加点：每个 helper（`isJunkCategory` / `applyBriefingResults`）写一行 expect。

#### Layer 3：流程 — 改之前先 grep

不能完全消除平行的情况下，至少要**主动找出**所有平行实现。改任意一处涉及"通用契约"的代码前，**必须**先 grep：

```bash
# 改 prompt 内容
grep -rn "<某关键短语>" web/lib/    # 例如 "You got N" / "AGGREGATE BY TYPE"

# 改 helper / 函数
grep -rn "functionName" web/

# 改 SQL / 表 / 列
grep -rn "<table_name>\|<column_name>" web/

# 改 LLM 入口
grep -rn "spawn.*claude\|execCommand.*inquiry" web/

# 改 magic string
grep -rn "'cat_junk'\|\"cat_junk\"" web/
```

看到 N 个 hit 就一次改 N 个，**一个 commit 收尾**。看 PR diff 时如果只动了 1 个 hit 但 grep 说有 3 个，你的 PR 不完整。

#### Layer 4：工具兜底 — 自动化捕捉常见模式

- **Custom ESLint rules**：禁止 magic string `"cat_junk"` 出现在 `category-helpers.ts` 之外。
- **`knip` / `ts-prune`** 找 dead code（已经用过一次，commit `16b9f7e`）— dead code 是漂移的前兆，没人用的代码会跟活代码慢慢分叉。
- **Pre-commit grep hook** for known parallel-prone patterns。

### Decision doc 的角色

每个具体的"平行规则"（如 §17 的 time pattern、§20 的 reply-quote）应该有自己的 doc 列出 **Files this rule lives in**。当用户后续改这条规则时，doc 是 ground truth：

```markdown
# <rule name>
Files implementing this rule (must stay in sync):
- web/lib/time-patterns.ts (canonical)
- web/lib/ttl-rules.ts (consumer)
- web/lib/event-extractor.ts (consumer)
```

`docs/design/issues/briefing-density-redesign.md` 已经列了文件清单 — 那是这条 doc 模板的具体应用。

### 元规则

> 看到第二处复制 → 抽。  
> 抽不动 → 写共用类型 + 一行 invariant test。  
> 测不动 → 改之前 grep 全 repo。  
> Grep 漏了 → 添新 ESLint rule。  
> 都漏了 → 用户测出来 → 下次再多加一层 ESLint。

**用户说"还有 X 处没改"是上一层防御失败的信号，不是道歉的时机。直接进下一层。**

---

## 22. 错误的工具 vs 错误的用法 —— SetFit 替代 raw MiniLM 的二次复用

**症状**：merged-prefetch 一天 spawn 20 次。诊断发现是 MiniLM 主分类 35% pass rate（设计内）+ 65% 邮件落到 LLM。先后推过 sender memo / IDLE debounce / production app 多信号架构，加起来削减 50% 撑死。

**根因**：raw MiniLM-L6-v2 是 2019 年通用句子相似度模型，邮件 4-way 分类不是它的本职任务。News/Track 在它的 embedding 空间里 cosine 0.6-0.7 互相重叠，centroid 是糊掉的平均，cosine 距离方差大到无法做可靠决策。35% pass rate 不是阈值调出来的是模型上限。

**正解**（套 is_work SetFit 的成功路径）：用 412 个 LLM 标注样本对 MiniLM body 做 contrastive fine-tune，4-way LR head，θ=0.80 confident gate。held-out eval 34/35 = 97.1%，其中唯一"错"是模型修了 LLM 的 mislabel。JS smoke test 80/80 都过 confident gate，median top1=0.97。

**关键洞察**：
- "MiniLM 不行"和"用 MiniLM 不行"不是同一件事 —— Ask AI 的 chunk retrieval 仍然用通用 MiniLM 工作得很好，因为那确实是语义相似搜索任务
- 推荐工具时要分清：是这工具不行（换工具）还是这场景错（换策略）—— 是后者就只换分类层用法、保留 RAG 的用法
- SetFit-work 的 FPR 71% → 0.4% 是同一个证据，但当时被 narrow 化（"只做 is_work，不动其他"），没及时外推到主分类。**指标好的工具横向迁移到第二个场景前要主动评估，不要等用户问第二次**

**反模式（已加入小结）**：用通用 embedder 做特定分类 → centroid 互相覆盖 → 高 LLM fallback 率 → 高 spawn → 用周边补丁治标。正解：fine-tune 同一 body 把任务对应的簇挤开。

**遗留 v1.1 项**：用户 setCategory 路径目前只 retrain centroid（已是 fallback），没 warm-start retrain SetFit head。is_work 那边有 `setfit-head.ts` 做这件事，主分类需要对称的 `setfit-classify-head.ts`。当前用户纠错样本仅 3 个，影响近零；但长期需要补，否则系统不能从用户纠错学习。

---

## 23. 新分类器 ship 后的旁路审计 —— `reclassifyUnclassified` 绕过 SetFit 一周

**症状**：SetFit 4-way ship 后第二天用户报"junk 里有大量明显误分"。汇报发现 cat_junk 里 47/48 是 LLM 0.9 硬编码 confidence、且把课程资料订单确认 / 快递柜包裹通知 / Company A 求职申请提醒等明确属于 Track 的邮件全判进 junk。

**诊断追问**：用户立刻拒绝了"先讨论 LLM prompt 怎么收紧"的方向，要求查"为什么这些邮件根本没经过 SetFit"。

**根因**：SetFit 部署后 24h 内 211 次 Inbox 分类，仅 7 次走 setfit 路径（3.3%）。其余 201 次（98%）`classify_embedding IS NULL`，意味着 SetFit 编码器从未被调用。证据集中在 `2026-05-07 21:22:53` 单批 195 行：156 LLM + 38 minilm + 1 user，全部 NULL classify_embedding。
- prefetch.ts Step 2a 是正常的（incremental 路径每次有日志显示 "Step 2a: classify done confident=1"）
- 杀手是 `/api/emails action=reclassifyUnclassified` —— 一条独立的 API 路径，UI 上的 "Classifying N emails…" 按钮触发，**直接 `classifyEmailsWithLLM(pending, ...)`** 把整批送 LLM，硬写 `classifier='llm', confidence=0.9`。SetFit 不在 import 列表里、`isClassifyEmbedderAvailable` 不被调用、`classify_embedding` 不被缓存
- 这是 SetFit 引入时只改了 prefetch 主路径、没 grep 整个 repo 找 "其他直接调 LLM 的入口" 的疏忽

**反模式**：新分类器 ship 时假定"自己只需修主路径"。实际上每条独立的"直接 LLM"调用点都在悄悄绕过新模型 —— `reclassifyUnclassified` / `reclassify`（specific ids）/ 任何 dev 脚本 / 任何 webhook。这些 path 在 metric 上看起来"正常工作"（返回成功 JSON、邮件被分类），但**承诺给用户的"95% 跳过 LLM"完全没兑现**。

**正解**：
1. 修 `reclassifyUnclassified` 走和 prefetch Step 2a 完全相同的 SetFit→LLM 链（缓存 classify_embedding、按实际路径写 `classifier='setfit'` 或 `'llm'`）
2. 删 `action="reclassify"`（specific ids）—— grep 确认无 UI 调用方，是死代码
3. **干脆把 generic-MiniLM 质心 fallback 从 prefetch.ts Step 2a 也删掉**，统一为 SetFit→LLM 两层 —— 多一层兜底听起来安全，实际让"不走 SetFit 也能命中"成为可能，把这次事故从"概念上"变成"路径上"
4. 删 `lib/minilm-classifier.ts` + `category_centroids` 助手函数 + 8 个 centroid eval/bootstrap scripts。schema 表保留（SQLite drop 烦），数据冻结
5. `setfit-classify-head.ts` 的 `SOURCE_WEIGHTS` 注释从 "mirrors minilm-classifier" 升级为 "sole source of truth" —— 平行实现一拆，剩下那份必须主动认领权威语义（§21 教训）
6. 加结构化日志 `log.info("reclassify", "done", { setfit, llm, unknown, ms })`，免得下次同类事故再隐 95% 流量绕过

**自检 checklist**（新 ML 模型 ship 时必跑）：
1. `grep -rn 'classifyEmailsWithLLM\|<新模型 import>' web/app web/lib web/components` —— 列出所有调用方，每个都看一眼是否走新链
2. `grep -rn '<旧分类器 import>' web/scripts` —— scripts 目录的依赖最容易被忽视
3. ship 后 24h 用 SQL 验证：`SELECT classifier, COUNT(*), SUM(CASE WHEN classify_embedding IS NULL THEN 1 ELSE 0 END) FROM emails WHERE classified_at > <ship_ts> GROUP BY classifier` —— 任何 setfit 占比远低于 held-out eval 预期都是旁路信号
4. 写"模型不应被调用次数 < N%"的 metric，让旁路在监控上立刻露出来

**最深的教训**：用户问 "为什么这些没经过 SetFit" 而不是 "为什么 LLM 判错"。**当一个 ML 系统宣称信心高于阈值就跳过 LLM，调试时第一问应该是"它有没有被调用"，而不是"它判错了什么"** —— 这两个问题答案完全不同，混淆它们能让 50% 的精力花错地方。

## 24. Warm-start 训练数据可见性 bug —— TS 路径只能看 SQL JOIN 命中的样本

**症状**：SetFit 4-way ship 后 6 天（2026-05-13）PROD 调查发现 pass rate 跌到 40%（ship 时 held-out eval 97.1%，smoke test 100% confident pass，top1 p50=0.97）。LLM 兜底里 cat_news 占 63%（32/51）—— SetFit 对当前 news 邮件几乎失能。同时 SetFit 命中里 cat_track 占 59%，单类偏置严重。

**诊断追问**：用户拒绝"温度阈值不合适 / encoder 偏置"的方向，要求"读所有文档+开发记录，找根因"。

**根因**（数据可见性，非模型质量）：
- `getLabeledClassifySamples` SQL JOIN `emails.classify_embedding`
- 该列 2026-05-07 SetFit ship 时加入 schema；ship 前已分类的邮件该列 NULL
- 504 个 category_examples 里 **244 个 orphan**（49%）—— email 行存在但 classify_embedding NULL
- TS warm-start 只能看到剩下的 **220 个** trainable，2026-05-08 weight bump 触发的 retrain 当时甚至只看到 169 个 → train accuracy 从 ship 时 Python 的 **97.8%（354 样本）跌到 81.1%（169 样本）**
- 此后没有 user_correction 触发新的 retrain（PROD 全周期 user_correction 累计 5 条）→ runtime head 一直停在退化版本

**关键证据**：
1. `classifier='setfit'` 行 `classify_embedding` 全部非 NULL（说明编码器在跑、缓存在写）—— 不是 §23 那种调用旁路 bug
2. SetFit 命中行 avg confidence = 0.896（接近 0.80 阈值），ship 时是 0.97 → 模型不是"判错"，是"不自信"
3. Disk `head.json` 完好（Python 2026-05-07 训练，4×384 shape，97.8% acc），但 `app_state.setfit_classify_head_runtime` 优先级更高 → PROD 实际跑的是 169-sample 退化版

**为什么 ship 时没发现**：ship 的 Python 训练 (`training/setfit-classify/train.py`) **当场算 embedding**，不依赖 cached column —— 看得见全部 354 样本。Held-out eval / smoke test 都基于这个完整训练的 head 跑。TS warm-start 是后加的（user correction 触发用），ship 时没人压测过"warm-start 在 retrain 时能看到多少样本"。两条路径 silently 不等价。

**反模式**：**Python 训练和 TS warm-start 走两条不等价路径却共享同一份 head 文件**。Python 看 source-of-truth (category_examples)；TS 看 JOIN 后的过滤子集。当 weight bump / 用户纠错触发 TS retrain 时，TS 默默盖掉 Python 的高质量 head，从此跑在子集训练版本上 —— 而且**没有任何告警**（trainSetfitClassifyHead 只看到 169 行，认为"这就是全部数据"）。

**正解**：
1. 加 `web/lib/embed-backfill.ts ensureClassifyEmbeddingsBackfilled()` —— 启动时 fire-and-forget 扫 orphan 并补 classify_embedding
2. 加 `web/scripts/backfill-classify-embedding.ts --retrain` —— 一次性补完所有 orphan + 全量重训 head
3. `trainSetfitClassifyHead` 入口加 **coverage invariant check**：`getLabeledClassifySamples().length / countTrainableCategoryExamples() < 0.7` 时 console.warn —— retrain 在子集上跑必然留下日志痕迹
4. 删除 `docs/observations/setfit-weight-25-72h-check.md` —— weight bump 不是根因，那份检查 plan 失效

**与 §23 的关系**：§23 是"模型调用旁路"（`reclassifyUnclassified` 不调 SetFit），§24 是"模型训练数据旁路"（warm-start 看不到全部 examples）。两者形态不同但教训相通——**新 ML 模型 ship 后用 SQL 验证所有承诺是否兑现**：
- §23 验证"模型被调用次数 / 应被调用次数"
- §24 验证"模型训练时见到的样本数 / source-of-truth 样本数"
- 任何一项远低于 100% 都是 bug

**自检 checklist**（新 ML 训练路径加入时必跑）：
1. `grep -rn '<新训练函数>' web/` —— 列出所有 retrain 触发点
2. 对每个触发点回答："这次 retrain 看到了多少 source-of-truth 样本？" 用 SQL 直接 count，不要相信 `samples=N` 的日志（N 已经是 JOIN 后的）
3. 如果 TS retrain 和 Python retrain 的 sample 数不一致，**写 invariant test 验证两者必须相等**（或差异有明确 schema 解释）
4. ship 后 7 天用 `classified_at > ship_ts` 跑分类质量 SQL（pass rate / 单类偏置 / avg confidence），任一项偏离 ship eval ≥10pp 是退化信号

**最深的教训**：**ML 系统的两条训练路径必须读完全相同的数据，否则一条会 silently 退化另一条的成果**。这次的 weight bump 看起来"应该让模型更尊重 LLM 标签"（合理 hypothesis），实际却同时无意触发了 retrain → 子集化训练数据 → 整个 head 退化。决策矩阵讨论的 "70-89% 保留 / 30-49% 回滚" 全是在错误的修复方向上打转，因为压根没意识到是数据子集问题而不是权重问题。**当一个 ML 修复"理论上应该改善"却没有改善时，先检查训练时见到的数据，再讨论训练算法/超参**。

---

## 25. LLM confidence 硬编码 0.9 —— 同时坏掉三件事

**症状**：用户问"llm 的 confidence 是从哪里来的"，看 `prefetch.ts:202` 发现是 SQL 字面量 `confidence = 0.9`，与 LLM 实际信心无关。同时所有 LLM 标签都 `source='llm_high_conf'`（weight 25），不论邮件是显然的 textbook example 还是 LLM 自己也犯嘀咕的边界样本。

**三处坏掉**：

1. **Active learning 横幅永远不显示**：`needsUserConfirm = 0.4 ≤ conf ≤ 0.7`，所有 LLM 邮件 conf=0.9 永远在区间外。被 SetFit 判错却落入 setfit 信心区间的邮件能触发"AI 信心不足"横幅；被 LLM 兜底（SetFit 都认输）的邮件反而被静音——刚好相反。

2. **训练池被噪声污染**：167 个 `llm_high_conf` 里若有 ~17 个错标（LLM ~10% error rate），weight 25 让这些错标对梯度的拉扯没被任何东西抵消。`docs/lessons/2026-05-10-llm-as-training-data-and-shared-ci.md §1` 已经看到 weight 10→25 后 train acc 从 97.8% 跌到 81.1%——但当时只把 weight bump 理解为"作用面变大"而没意识到根因是"没区分 LLM 自己说稳的样本和 LLM 自己说猜的样本"。

3. **诊断能力丢失**：T0+5.34h 看到 cat_news LLM fallback 3/3 时，没法回答"这 3 封是 SetFit 边界 + LLM 也猜的，还是 SetFit 不行但 LLM 很稳"。没有 confidence 信号 → 没法把 LLM 兜底分成"已学但 SetFit 没爬到 threshold"和"LLM 也是边界"两类 → encoder 是否需要重训的决策只能拍脑袋。

**根因模式**：placeholder 值（0.9, "TBD", -1 等）随时间被忘是 placeholder，变成事实。下游消费者按真值用，逻辑漏洞被 placeholder 的"合理样子"掩盖（0.9 看起来像个合理的高信值，没人去 grep 它从哪来）。

**修法（2026-05-14 ship）**：

| 改动 | 文件 |
|---|---|
| LLM JSON schema 加 `confidence: "high" \| "medium" \| "low"` 字段，prompt 解释三档语义 | `web/lib/llm-classify.ts buildClassifyPrompt` + `merged-prefetch-llm.ts buildClassifySection` |
| `mapLLMConfidence(raw)` 单点把字符串映射到 `{numeric, source, trainable}` | `web/lib/llm-classify.ts` |
| 两个写库 SQL 把 `confidence = 0.9` 参数化 | `prefetch.ts:202` + `app/api/emails/route.ts:305` |
| `applyClassifyResults` 用 tier 决定是否回灌 + 用什么 source | `prefetch.ts` + `app/api/emails/route.ts` |
| `SOURCE_WEIGHTS` 加 `llm_med_conf: 5`；`llm_low_conf` 不进表（不回灌 = 跳过 addCategoryExample） | `setfit-classify-head.ts` |

**三档的语义**：

| Tier | numeric | source | trainable | 含义 |
|---|---|---|---|---|
| high | 0.9 | `llm_high_conf` (w=25) | ✓ | 教科书级（sender/subject/body 一致） |
| medium | 0.55 | `llm_med_conf` (w=5) | ✓ | 类别合理但至少一信号模糊 → 落入 needsUserConfirm 区间 → UI 显示横幅 |
| low | 0.3 | — | ✗ | 自承猜测；写入路由但不进训练池 |

默认 fallback（LLM 漏字段 / 拼写错）→ medium。永远不默认 high——把不确定洗成高信是错误方向。

**Pattern**：

- **Placeholder 永远是技术债**：任何字面量值（不论是 0.9 还是 "TBD"）写进 DB 都要在 PR description 注明退路。回避不了的情况下，至少把 placeholder 值选在所有下游 gate 的尴尬位置（如果 0.9 选在 0.5 = needsUserConfirm 中间，bug 第一周就会被发现）
- **Self-rated confidence 不是 calibrated 但够用**：LLM 的 0.7 跟 SetFit 的 0.7 含义不同，无法直接比较数值。但三档（high/medium/low）让 LLM 用语义判难度——这层信号比固定常量强，比强行要求 calibrated probability 容易 elicit
- **训练 trainability 是一等关键字**：每个 auto-label source 都该有 `trainable: bool`，要么进训练池要么不进，不要在 weight 里塞一个 0.5 假装"半个进"
- **下游 gate 的常量必须能在 grep 里追溯**：`0.4 ≤ conf ≤ 0.7` 这条 needsUserConfirm 规则不能凭运气覆盖所有写入路径，新加的写入路径若不在区间里，要在 PR 里说清楚（或者改成"非 setfit 全部进区间"这种更强的规则）

**复用性**：这一类"placeholder 静默坏掉的下游 gate"在 Jobs pipeline 里很可能也存在——`recomputeApplicationFromEmails` 写 `current_stage` / `current_priority` 等聚合字段，看着像快照但是 LLM raw output，没有信心 tier 区分。下次审 Jobs 的"为啥这个 application 一直显示 'interviewed' 不更新"时记得带这个 lens。

---

## 反模式小结

| 反模式 | 后果 | 正解 |
|---|---|---|
| 删代码不删 docs | AI 踩地雷 | grep repo 关键字，同 commit 清理 |
| 为了多语言切 embedder | 精度下降 + 重 embed 成本 | query-time 翻译 |
| 强制前置 RAG | 闲聊也烧 token | Agentic retrieval |
| embedding 字段手动迁移 | 已分类行卡住 | 幂等自愈 step |
| 复用 tunnel hostname | CF CNAME 冲突 | 新 hostname |
| 拍脑袋定阈值 | 召回全错 | 合成 query + distribution 分析 |
| `cp data.db` 备份 | WAL 不一致 | `sqlite3 .backup` |
| 多 env 共用 token | 泄露全炸 | 一环境一 token |
| MCP 暴露通用查询 | 绕过语义门槛 | narrow 工具 |
| Lazy-stale 冒充 scheduled | 定时刷新没发生 | 真的加 `setInterval` |
| Cron 重试无 UI 上报 | 用户看不到失败 | DB 加 attempts + 断路器 + UI 列出 |
| Probe 间隔 >> 调用延迟 | 错误期静默失败 | 调用者失败时立刻更新健康键 |
| Exit 0 盲信 | subprocess 没真干事 | 解析 stdout 验 side-effect |
| API handler 同步 ML | 请求卡住 | fire-and-forget |
| 多步 DB 无事务 | 半 done 状态 | `db.transaction()` |
| Regen 错误被吞 | UI 轮询死循环 | state 留 error 槽，API 上报 |
| 两系统各写"同一件事"的 regex | 定义漂移，行为不一致 | 抽 `time-patterns.ts` 共享常量 |
| LLM 看不该看的邮件（News/Junk） | 86% 调用返回空烧 token | SQL 硬约束 + 入口 gate + invariant 查询 |
| Generic fallback 规则排在精确规则前面 | 兜底抢占了所有命中 | specific > generic；replay test 验 |
| body 含 inline 引用历史喂给 LLM | 把老内容当新内容复述 | 共享 `stripQuotedReply`；相应消费者按出问题顺序接入 |
| 同一规则在 ≥2 处实现（prompt / SQL / boolean / magic string） | 改一处忘另一处，行为漂移 | §21 四层防御：Rule of Two 抽取 → 共用类型/测试 → 改前 grep → ESLint 兜底 |
| 通用 embedder 做特定分类（MiniLM raw 4-way） | centroid 互相覆盖 → 35% pass rate → LLM fallback 满负荷 → spawn 爆 | 同一 body 做 task-tuned fine-tune（SetFit / contrastive），把目标类簇挤开 |
| 工具在 A 场景成功后没主动外推到 B 场景 | 同样的瓶颈在 B 场景继续存在，绕周边打补丁 | A 场景指标改善 ≥10x 后立刻评估 B 场景能否复用同方法 |
| 新 ML 模型 ship 后没 grep "其他直接调 LLM 的入口" | reclassify API / dev scripts 沉默旁路新模型，承诺的 X% 跳过 LLM 完全没兑现 | ship 后 24h 用 SQL 验证新 classifier 占比；旁路 = bug，不是优化空间 |
| 调试 ML 误分时第一反应"为什么模型判错" | 实际可能根本没被调用，50% 精力花错方向 | 先验证模型被调用次数 + embedding 缓存填充率，再讨论判断质量 |
| Python 训练和 TS warm-start 走不等价数据路径却共享 head 文件 | TS retrain 看不到 SQL JOIN 不命中的样本，盖掉 Python 的高质量 head 后悄悄退化 | startup 自动 backfill 缺失缓存 + retrain 入口加 coverage invariant check + 两条路径的 sample 数必须 SQL 验证相等 |
| Placeholder 常量（confidence=0.9, status='TBD'）随时间被忘是 placeholder，下游 gate 按真值用 | active-learning gate 永远不触发；训练池被未分级标签污染；诊断能力丢失 | 任何 placeholder 值在写入下游消费点前必须分级（tier / source 字段），下游 gate 必须 grep 全部写入路径覆盖 |

---

## 下次开工前的 checklist

1. `cat MEMORY.md` + 扫一眼本文
2. `cd web && npx knip` — 现状健康度
3. `find . -type f -size +50M -not -path '*/node_modules/*' -not -path '*/.git/*'` — 磁盘
4. `git log --oneline -20` — 最近 context

**改任意一处涉及通用契约（prompt 内容、SQL where、共用 helper、magic string、subprocess 入口）的代码前**，按 §21 跑：

```bash
grep -rn "<关键短语 / 函数名 / 字符串字面量>" web/
```

> N 个 hit 就一次改 N 个，一个 commit 收尾。Grep 漏了 → 用户会替你 grep；那就太晚了。
5. 如果要删 feature：先 `grep -rn <keyword> docs CLAUDE.md README.md` 列清单
