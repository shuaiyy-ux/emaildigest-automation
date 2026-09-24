## Feature: 分类纠正与学习反馈

### Why
自动分类永远有错。招聘平台的推广邮件被分到 job，课程调查被分到 promotion，
这些错误会让用户每次看到同一发件人都要手动改一次——是积累挫败感的主要来源。
系统需要"记住"用户的纠正，下次同类邮件自动分对。

### What
在邮件详情页，分类 badge 点击展开下拉菜单，4 个 bucket 可选。邮件列表里右
键任一封邮件也能弹出相同菜单 + 已读/未读切换。用户选新类别后立即保存，且
这次纠正会触发 SetFit 4-way head 的 warm-start retrain，让下次同类邮件分对。

### Acceptance Criteria
- 用户改类别后立即写入数据库，刷新页面类别保留
- 每次纠正同时写入 `corrections` 表（记录 email_id, from_domain, ml_category,
  user_category），仅作为历史日志 + LLM few-shot 来源
- 用户纠正后 email embedding 作为 `user_correction` 样本（权重 50）加入新类
  别 `category_examples`；同一 embedding 从旧类别 `category_examples` 移除（防止
  warm-start 同时拿到该邮件的两份矛盾标签）。事务外触发
  `trainSetfitClassifyHead({warmStart:true})`，50 轮 LR retrain on cached
  `classify_embedding`。下次同类邮件 SetFit top1 上升、跳过 LLM
- 最近 10 条 corrections 作为 few-shot 示例注入 LLM 分类 prompt
  （`getRecentCorrections(10)` → `lib/llm-classify.ts`）
- 手动改过的邮件 `classifier` 字段标记为 `"user"`，该行被锁定，prefetch 永不
  覆写（`upsertEmails` ON CONFLICT + Step 2 skip set + Step 2b WHERE 子句
  三层保护）
- 右键菜单能同时改类别和切换已读/未读状态

### Out of Scope
- 不做跨设备同步纠正历史
- 不做"一键撤销最后一次纠正"
- 不允许用户直接删除 corrections 记录（只能通过再次纠正覆盖）
- 不做纠正次数 / 统计展示给用户看

### Open Questions
- ~~贝叶斯权重封顶 40% 是否合理？~~ → **已关闭**：域名贝叶斯先验机制
  （`getCorrectionBias`）已在 2026-04 移除。`minilm-classifier.ts` 整体已于
  2026-05-08 退役（lessons-learned §23）。纠正信号通过修改
  `category_examples` 直接驱动 SetFit head warm-start retrain，权重由
  `SOURCE_WEIGHTS.user_correction=50`（相对 `llm_high_conf=25` 2× / `llm_med_conf=5` 10×）保证用户主导。LLM low-conf 不回灌（trainable=false），见 [database.md SOURCE_WEIGHTS](../design/database.md#source-权重分类器用)。
