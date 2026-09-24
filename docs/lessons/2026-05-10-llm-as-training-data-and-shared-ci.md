# Lessons from 2026-05-08/10 session

三件事，每件都暴露了一个能复用的 pattern。

---

## 1. Auto-label 训练数据有自己的 error rate；调权重前先盘点

### 上下文

PROD `category_examples` 长期失衡：

| source | 数量 | weight | effective signal |
|---|---|---|---|
| llm_high_conf | 167 | 10 | 1670 |
| user_correction | 2 | 50 | 100 |

`user_correction` weight=50 设计上"远高于 llm_high_conf"，但绝对数差距 80× 让 user 信号被淹没。SetFit head 在用户右键纠错之间几乎不更新——LLM 已经反复"教"过 head 同一批模式，再 retrain 也没新东西。

### 第一反应（错的）

把 llm_high_conf 权重 10 → 25 提到接近 user。理由：让 LLM 标签实际起作用。

### 真实结果

Retrain 后 22 个新样本：9 setfit / 13 llm（41% setfit），**比 retrain 前的 62% setfit 更差**。SetFit 9 个命中全部 cat_track——head 偏向 track。

### 机制

LLM 自己有 ~10% error rate。把它的权重 ×2.5 等于把它的错误也 ×2.5。167 个 llm_high_conf 里若有 ~17 个错标，weight 10 时它们对梯度的拉扯被 user 的 weight 50 边际压制；weight 25 时这压制力消失，错标得逞。

`train accuracy = 81.1%` 已经在告诉你这个——比 retrain 前的 ~95% 低了 14 个点。但当时只盯着"5 封问题邮件全部修复"就 declare success。

### Pattern

调任何 source 权重前：

1. **盘点训练池**——count by source，看 user vs auto 的真实比例
2. **预测梯度影响**：`new_weight × auto_count` vs `user_weight × user_count`。auto 一边数量级压倒 user 就是危险信号
3. **Train acc 是即时质量信号**——比 retrain 前掉超 5pp 不是"已知折衷"，是 warning
4. **观察窗口要在 retrain 后**——baseline 必须 mark 在变更**之后**，否则 50-sample 窗口里有一半是变更前的数据
5. **5 个 cherry-picked 邮件全部修复 ≠ 总体改善**——cherry-picked 邮件本来就是 weight bump 最容易改善的样本

### 不要做

- 看着 5 封问题邮件全 PASS 就 push baseline，宣布 retrain 成功
- 用 train accuracy 判断泛化（held-out / 真实流量才算）

### 后续修法（2026-05-14 ship）

§1 的根本问题"LLM 标签全部按 high-conf 看待"在 2026-05-14 被正式修：LLM 现在 JSON schema 多一个 `confidence: "high" | "medium" | "low"` 字段，每个 tier 走不同的 `source` (`llm_high_conf` w=25 / `llm_med_conf` w=5 / 不回灌)。详见 `docs/lessons-learned.md §25`。权重 25 没动——只是不再是"所有 LLM 标签都拿 25"，而是"LLM 自己说稳的才拿 25"。

---

## 2. Build 步骤抽 shell 脚本，CI 和本地 hook 共消费——无法漂移

### 上下文

`.github/workflows/deploy.yml` 历史上把 build 步骤（`npm ci`、`npm run build`、mcp-server 编译）写在 YAML 里。本地想做 pre-push hook 拦下 CI 失败，但"维护两份一样的 build 列表"是反模式——一边改另一边忘改是必然。

### Pattern

抽 build 步骤到 `scripts/build-verify.sh`（单一 source of truth），三处都调它：

```
.github/workflows/deploy.yml ────┐
                                 ├─→ scripts/build-verify.sh
web/package.json "ci-build" ─────┤    （仅一份，git 里 versioned）
                                 │
.git/hooks/pre-push ─────────────┘    （hook 本身不进 git，配置个人）
```

`deploy.yml` 只保留环境特定胶水（SSH、systemd 启停、smoke test）。环境差异（如生产服务器内存压力的 `NODE_OPTIONS=--max-old-space-size=512`）由调用方通过 env var 传入：

```bash
WEB_BUILD_NODE_OPTIONS="--max-old-space-size=1024" \
  bash scripts/build-verify.sh
```

本地不传，默认无限制。

### 收益（实测）

- 之前 20 次 deploy 中 2 次 fail（10%），都是 TS 编译错误（orphan import、stale module path）
- 这两类错 `npm run build` 本地秒抓
- Pre-push hook 装上后，这 10% 在 push 前就拦下，省每次 1m45s 的 CI deploy 失败 + ssh 救火

### 不要做

- 把 build 步骤复制粘贴到 pre-push hook 脚本（drift 必然发生）
- 让 pre-push 跑跟 CI 不一样的 subset（"本地只 tsc --noEmit"——抓不到 Next build 错）
- 用 husky 等第三方包做这件事（一个 4 行 shell 文件够了，加 dep 反而占代价）

---

## 3. SetFit "defer to LLM" 判定要看 softmax 全分布，不是只看 label

### 上下文

5 封 setfit-deferred 邮件，初看以为都是"真·边界"。

### 实际看 softmax

```
Email: Last chance | Up to 25% off  (明显 junk)
SetFit predict:
  top1: cat_track 0.61
  top2: cat_news  0.24
  top3: cat_junk  0.14
```

top1 离 0.80 阈值只差 0.19——**SetFit 接近高自信地错**。这是分类器漏洞，不是"边界"。

```
Email: Meeting Update (Hi [name], Thank you...)  (明显 primary)
SetFit predict:
  top1: cat_news    0.36
  top2: cat_primary 0.31
  top3: cat_junk    0.17
```

top1 错（应 primary），但 0.36 vs 0.31 几乎平手——**threshold 救了一次**，但说明 SetFit 对"人对人回复"模式识别力不足。

### Pattern

debug "为什么这些邮件落 LLM" 的标准动作：

```typescript
// 跑 predictClassifyFromEmbedding(emb)，输出完整 probs 数组
{
  label: "cat_track",
  top1: 0.61,
  top2: 0.24,
  margin: 0.37,        // ← 这个数字是真实信心
  probs: { 0: 0.14, 1: 0.61, 2: 0.24, 3: 0.01 },
  confident: false     // ← 真实门控决策
}
```

三种诊断结论：

| top1 / margin 模式 | 含义 | 应对 |
|---|---|---|
| top1 < 0.5, margin < 0.1 | **真·边界**（threshold 应当 defer） | 不动；LLM 接管是对的 |
| top1 0.5-0.75, margin > 0.2 | **SetFit 接近高自信地错**（threshold 险救） | 训练数据缺该 pattern；加 user_correction 种子 |
| top1 < 0.5 但 top1 跟 LLM 一致 | 真信号弱，正在学 | 多积累几条该类样本 |

### 不要做

- 只看 `pred.label` 跟 LLM 比，看像 vs 不像
- 假设"low confidence = SetFit 不会的事"——其实可能是"SetFit 会但 confidence 没爬上去"

---

## 文件清单（本 session 产出）

- `scripts/build-verify.sh` — 共享 build 脚本
- `.github/workflows/deploy.yml` — 重构调用共享脚本
- `.git/hooks/pre-push` — 本地 hook（不进 git）
- `web/package.json` — `ci-build` npm 入口
- ~~`docs/observations/setfit-weight-25-72h-check.md`~~ — 已删除（2026-05-13）；weight bump 不是根因，参见 lessons-learned §24 + `docs/observations/setfit-warmstart-coverage-24h-check.md`
- 本文件
