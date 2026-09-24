## Feature: 邮件自动分类

### Why
学校邮箱一天几十封，混杂着课程通知、作业截止、招聘推广、广告、newsletter。
手动扫一遍要十几分钟，真正重要的（教授、招聘 offer）容易被广告淹没。
用户需要打开邮箱就能看到每封邮件属于哪个 bucket。

### What
4-bucket 分类法（MECE，按用户意图划分）：

- **Primary** — 真人直接沟通；时效性 action-required
- **Track** — 因你的账号/行为生成的专属记录（订单、shipping、成绩、确认、验证码）
- **News** — 订阅/广播内容流（newsletter、digest、平台公告）
- **Junk** — 营销 + spam，30 天自动 prune

分类在邮件入库后自动完成：SetFit 任务专属 4-way 头优先（top1 ≥ 0.80 免 LLM），信
心不足走 LLM 精细分类。用户无需手动触发。**urgency 字段已于 2026-04-17 移除**（只
做 UI 装饰不驱动任何行为，且稀释 LLM 注意力），DB 列仍存但不再写入。时效性由
`ttl-rules.ts` 独立抽取 `primary_until`，在 SetFit 和 LLM 两条路径后各跑一次。

### Acceptance Criteria
- 每封入库邮件最终都得有 `category_id`（4 选 1）
- LLM 分类的 `confidence` 字段（emails.confidence）来自 LLM 自评 tier 映射：`high`→0.9 / `medium`→0.55 / `low`→0.3（详见 [email-pipeline.md Step 2b](../design/email-pipeline.md#step-2b-llm-精细分类--回灌训练样本)）。`medium` 落入 `needsUserConfirm` 0.4-0.7 区间，自动触发 active learning 横幅。≤ 2026-05-13 是硬编码 0.9（参 lessons-learned §25）
- classifier 字段三种活跃值：`setfit`（SetFit 头命中）/ `llm`（LLM 精细分类）/ `user`（手动纠正）。`minilm` 是历史 row 的旧值（generic-MiniLM 质心 fallback 已于 2026-05-08 退役）
- `classifier='user'` 行被锁定，prefetch 永不覆写
- 分类失败的邮件不中断批次（保留 category_id=NULL，下次 prefetch 不重试，因为
  `classifier IS NULL OR NOT IN ('user','llm')` 条件已被满足）
- 邮件内容含 prompt injection 模式不会污染 LLM 分类（sanitizeForPrompt 截断 200 字 +
  移除 injection pattern，详见 security.md）
- 校园活动广告 → News（广播）或 Junk（纯营销）
- 招聘平台批量邮件 → News；招聘者真人邀约（真实 HR/recruiter 地址）→ Primary

### TTL 临时升级（正交于分类）
优先级 **1a > 2 > 3 > 1b**：
- **1a** 严格 OTP/2FA 验证码 → `primary_until = now + 30min`
- **2** 同日紧急（`expires today / last chance / due today / by EOD`）→ `primary_until = today 23:59`
- **3** 显式 deadline（`due Oct 15 / deadline Friday / by 10/15`）→ 解析日期的 end-of-day
- **1b** 快递 / 账单兜底（`package / pickup / bill / invoice / payment due`）→ `primary_until = now + 24h`（前三条都没中时）
- 详见 `web/lib/ttl-rules.ts` 的 `inferPrimaryUntil` 和 [email-pipeline.md](../design/email-pipeline.md#primary-ttl-规则ttl-rulests)
- 升级后该邮件**不改变 category_id**，只是在 Priority 视图中临时显示

### Out of Scope
- 不支持用户自定义新类别（4 类固定为 default；用户可在 settings/categories 增加自定义类，
  但 Priority/Other/All 视图判定仍按上述规则）
- 不做基于关键词的硬编码规则引擎（纯 LLM 概率分类）
- 不做多标签分类（每封只有一个 category）

### 实现锚点
- LLM 分类：`web/lib/llm-classify.ts` 的 `classifyEmailsWithLLM`，由 `prefetch.ts` Step 2 调用
- 4-bucket 默认 seed：`web/lib/db.ts` 的 `DEFAULT_CATEGORIES`
- 用户纠正反馈：`corrections` 表 → `getRecentCorrections(10)` 注入下次 LLM prompt 的 few-shot
