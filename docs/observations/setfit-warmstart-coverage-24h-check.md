# 24h checkpoint: SetFit warm-start coverage fix (§24)

**临时观察笔记。检查完成后删除整个文件。**

## Context

2026-05-13 调查发现 PROD SetFit pass rate 跌到 40%（ship 时 100% confident pass）。
根因不是 weight bump（10→25），而是 **warm-start 路径只能看到一半训练样本**：

- `getLabeledClassifySamples` SQL JOIN `emails.classify_embedding`
- SetFit ship 之前（2026-05-07）已分类的邮件该列 NULL → 244/504 个 category_examples invisible
- 2026-05-08 18:58 的 weight-bump retrain 只看到 169 样本 → train acc 从 97.8% 跌到 81.1%
- 此后 runtime head 一直没刷新

详见 `docs/lessons-learned.md §24`。

## Fix shipped

| 字段 | 值 |
|---|---|
| Commit (CI deploy) | `3566804` (this fix) |
| Backfill encoded (PROD, on-box run) | 243 / 244 (1 skipped — body too short) |
| Trainable / total (after backfill) | **463 / 464 (99.8%)** |
| Retrain location | **本地 M1** on PROD snapshot (per user feedback on PROD CPU saturation) |
| Retrain iterations | 4000 (sweep showed plateau at iter≥1000; final loss 9.39) |
| Retrain timestamp (PROD head write) — **T0** | `1778714983` (2026-05-13 23:29:43 UTC) |
| Head version | `v1778714902922` |
| Train accuracy (full retrain, 4000 iters) | **88.6%** (vs ship-time 97.8% on 354 samples; gap = `llm_high_conf` label noise) |
| Per-class distribution (trainable) | cat_primary 51 / cat_track 128 / cat_news 222 / cat_junk 62 |
| Pre-fix PROD pass rate | 40% (34 setfit / 51 llm, 99h window since 2026-05-08 retrain) |
| **Check date** | **T0 + 24h = 2026-05-14 23:29 UTC** |

## 24h 时应执行的命令

锚点：retrain 完成的 unixepoch 写入上表 T0，下面所有 SQL 把 `1778714983` 替换。

```bash
# 4.1 SetFit pass rate (核心指标)
ssh prod 'sqlite3 ~/emaildigest/data.db "SELECT classifier, COUNT(*) AS n FROM emails WHERE classified_at > 1778714983 AND classifier != '\''user'\'' GROUP BY classifier;"'

# 4.2 SetFit 命中的 category 分布
ssh prod 'sqlite3 ~/emaildigest/data.db "SELECT category_id, COUNT(*) FROM emails WHERE classified_at > 1778714983 AND classifier='\''setfit'\'' GROUP BY category_id ORDER BY 2 DESC;"'

# 4.3 LLM 兜底的 category 分布
ssh prod 'sqlite3 ~/emaildigest/data.db "SELECT category_id, COUNT(*) FROM emails WHERE classified_at > 1778714983 AND classifier='\''llm'\'' GROUP BY category_id ORDER BY 2 DESC;"'

# 4.4 SetFit 平均 top1 confidence
ssh prod 'sqlite3 ~/emaildigest/data.db "SELECT ROUND(AVG(confidence),3) FROM emails WHERE classified_at > 1778714983 AND classifier='\''setfit'\'';"'

# 4.5 Head version (应只看到一次写入)
ssh prod 'sqlite3 ~/emaildigest/data.db "SELECT key, datetime(updated_at,'\''unixepoch'\'','\''localtime'\''), substr(value,1,40) FROM app_state WHERE key IN ('\''setfit_classify_head_version'\'','\''setfit_classify_head_runtime'\'');"'

# 4.6 Token spawn rate
ssh prod 'cd ~/emaildigest/web && npx tsx scripts/token-check.ts'

# 4.7 Backfill 是否被再次触发（应该 0，全部在 T0 前就跑完）
ssh prod 'grep -c "classify embedding backfill ran" /var/log/emaildigest.log 2>/dev/null || journalctl -u emaildigest --since "24 hours ago" | grep -c "classify embedding backfill ran"'
```

## 决策矩阵（24h 后）

| 4.1 pass rate | 4.3 cat_news LLM 数 | 结论 | 行动 |
|---|---|---|---|
| **≥ 90%** | ≤ 3 | 彻底修复 | 删除本文件 + lessons-learned §24 末尾加 "✅ 修复验证 X% pass rate" |
| 70–89% | ≤ 5 | 部分修复 | 保留 24h 后再检（最多两个 cycle）|
| 50–69% | 6–15 | encoder 失效 | **跑 `training/setfit-classify/train.py` 重训 encoder** + scp ONNX |
| **< 50%** | > 15 | 训练数据本身坏了 | **回滚到 disk head.json** (`DELETE FROM app_state WHERE key='setfit_classify_head_runtime'` + 重启) + 审查 llm_high_conf 标注质量 |

## 额外回滚信号

- SetFit 命中分布 > 70% 集中在单类 → encoder 本身偏置
- 4.5 出现非预期 head version → 用户在 24h 内做了 category 纠正触发 warm-start；不一定异常但需排查触发时点
- Token spawn `merged-prefetch` > 8/day → SetFit 通过率不达标的间接信号

## 执行笔记（2026-05-13）

执行过程中暴露两个二级问题：

1. **脚本 while-loop 无限循环 bug**：`backfill-classify-embedding.ts` 的退出条件原写为
   `if (r.encoded === 0 && r.skippedNoText === 0) break` —— 当某个 orphan 的 subject+snippet 拼接
   `text.trim().length < 5` 时，永远进入 skippedNoText 分支，循环永不退出。PROD t2.medium 上
   244 个 orphan 编完后剩 1 个 stuck 行，脚本在那个 row 上死循环跑了 ~15min 0-ms SQL 反复扫，
   CPU 99% 一直挂着直到我 kill。修法：退出条件改为 `if (r.encoded === 0) break;`，承认
   skippedNoText 是永久状态。

2. **PROD CPU 抢占 → 切本地训练 + 推回 pattern**：原脚本在 PROD 跑 `npx tsx ... --retrain`，
   ONNX 在 t2.medium 单 vCPU 上单条 encode ~3-4s，244 个跑了 ~15min 期间 PROD Next.js 共享 CPU 卡顿。
   用户指出"为什么不在本地训练好了再发上去"。正确做法：
   ```bash
   ssh prod 'sqlite3 ~/emaildigest/data.db ".backup /tmp/data.db.bak"'        # WAL-safe
   scp prod:/tmp/data.db.bak /tmp/prod-snapshot/data.db
   cd web && EMAILDIGEST_DIR=/tmp/prod-snapshot npx tsx scripts/backfill-classify-embedding.ts --retrain
   # 提取 snapshot 的 app_state.setfit_classify_head_runtime
   sqlite3 /tmp/prod-snapshot/data.db "SELECT value FROM app_state WHERE key='setfit_classify_head_runtime';" > /tmp/new_head.json
   sqlite3 /tmp/prod-snapshot/data.db "SELECT value FROM app_state WHERE key='setfit_classify_head_version';" > /tmp/new_head_version.txt
   scp /tmp/new_head.json /tmp/new_head_version.txt prod:/tmp/
   # 用 readfile() 在 PROD 写入
   ssh prod 'sqlite3 ~/emaildigest/data.db <<EOF
     UPDATE app_state SET value=readfile("/tmp/new_head.json"), updated_at=unixepoch() WHERE key="setfit_classify_head_runtime";
     UPDATE app_state SET value=trim(readfile("/tmp/new_head_version.txt"), char(10)), updated_at=unixepoch() WHERE key="setfit_classify_head_version";
   EOF
   sudo systemctl restart emaildigest  # 失效 in-process headCache'
   ```
   本地 M1 跑 retrain 700ms（PROD 同等动作 ~50s）。

**未来 ML retrain 默认走这条 pattern**，除非操作只读 DB 没编码需求（纯 SQL 类 op）。

## Cleanup SOP

24h 后无论结果如何：
- 通过率 ≥ 90% → `rm docs/observations/setfit-warmstart-coverage-24h-check.md` + lessons-learned §24 末尾加成功标记
- 介于 70–89% → 保留 + 再加一行 24h checkpoint
- 需回滚 → 删本文件 + lessons-learned §24 更新为"修复无效原因"+ 引出后续 plan
