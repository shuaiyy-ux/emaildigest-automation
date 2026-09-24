# EmailDigest

基于 Codex CLI subprocess 的学校邮件自动化工具。

## 系统设计文档（自动注入）

以下 6 份设计文档描述了完整的系统架构、功能逻辑和安全模型。新 session 无需阅读源码即可理解系统全貌。

@docs/design/architecture.md
@docs/design/email-pipeline.md
@docs/design/draft-system.md
@docs/design/frontend.md
@docs/design/security.md
@docs/design/database.md
@docs/design/ask-rag.md

## 工程经验集

`docs/lessons-learned.md` — 21 条踩过的坑，按影响排序。**不自动注入**（避免每次都加载几百行历史）；以下情境主动 Read 它：

- 改任何 prompt / SQL where / 共用 helper / magic string 之前 → 至少看 §21 "平行实现漂移：四层防御"，按 grep-before-edit 流程走
- 写新的 cron / retry / async / 多步操作 → 看 §16 "静默失败 — UI 隐含承诺，后端偷偷不做" 的 self-check 列表
- 用户问 "还有 X 处也要改" → 这是 §21 上一层防御失败的信号，按下一层走（不是道歉）
- 触碰任何"两个系统看起来在做同一件事"的代码（regex / prompt / 判定 boolean）→ 必看 §17 / §20 / §21

## 搜索约束

所有搜索必须包含 `label:UCI-Mail` 以限制范围，避免读取个人邮件。

## 安全规则

- **绝不直接发送邮件**，只创建草稿
- 不删除邮件
- 只操作 `label:UCI-Mail` 下的邮件
- 不访问或显示密码、密钥或敏感凭证信息
- AI Generate（只读模式）不允许调用 `gmail_create_draft`
- 使用中文回复，除非邮件原文是其他语言

## 部署通道 / Secrets 位置

两套独立部署，**共享同一份代码（git），但各自 `.env.local` 持有不同 token，互相隔离**：

| 通道 | 部署位置 | `.env.local` 路径 | 用途 |
|---|---|---|---|
| **TEST** | 本地开发机（`localhost:3000`） | repo 内 `web/.env.local` | 开发 / 测试 |
| **PROD** | 生产服务器（systemd 服务 `emaildigest`） | `~/emaildigest/web/.env.local` | 生产 |

**Secrets 永不进 git**：`web/.env.local` 和 `.env.local` 均在 `.gitignore` 里。密钥只保留在各环境自己的 `.env.local` 里，仓库不保存任何 secrets。

**轮换流程**：新 token 用 `openssl rand -base64 33 | tr -d '=+/' | cut -c1-43` 生成；写入对应环境的 `.env.local`；重启 Next.js（生产服务器上 `sudo systemctl restart emaildigest`，本地重启 `next start` / `next dev`）生效。旧 token 在重启后立刻失效（middleware 只比对当前 env 值）。

**重要**：TEST 和 PROD 的 token 必须不同 — 防止本地代码误 hit 生产，或生产 token 泄露时不影响本地。

## Build 校验

`scripts/build-verify.sh` 是 build 步骤的**唯一 source of truth**（封装 web + mcp-server 的 `npm ci/install` 和 `npm run build`）。本地用 `cd web && npm run ci-build` 调它；只验 web 时等价于 `cd web && npm ci && npm run build`。push 前想拦下大部分 build 失败，可加 `.git/hooks/pre-push` 调它。任何部署流程都调用同一份脚本，不在别处复制 build 步骤 — 脚本只有一份，无法漂移。

内存受限的环境通过 env var 传参，例如 `WEB_BUILD_NODE_OPTIONS="--max-old-space-size=1024" bash scripts/build-verify.sh`；本地不传即无限制。

**代码与数据分离**：部署只同步代码，不同步 `data.db`。schema 变更走代码里幂等的 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`。

## Logging / Debug

结构化日志双写到 `logs/next.log`（stdout）+ `data.db` `logs` 表。debug 第一步：

```bash
# 最近一次 prefetch 全部 step（trace_id 关联）
sqlite3 data.db "SELECT DISTINCT trace_id FROM logs WHERE component='prefetch' AND ts > unixepoch() - 3600 ORDER BY ts DESC LIMIT 1;"
sqlite3 data.db "SELECT datetime(ts,'unixepoch','localtime'), level, message FROM logs WHERE trace_id='<paste>' ORDER BY ts;"

# 过去 24h 错误
sqlite3 data.db "SELECT datetime(ts,'unixepoch','localtime') t, component, message, ctx FROM logs WHERE level='error' AND ts > unixepoch() - 86400 ORDER BY ts DESC;"

# 某 component 最近活动
sqlite3 data.db "SELECT datetime(ts,'unixepoch','localtime'), level, message FROM logs WHERE component='email-digest' ORDER BY ts DESC LIMIT 50;"
```

设计 / API / component 命名见 `docs/design/logging.md`。新代码加日志：`import { log } from '@/lib/logger'` → `log.info('prefetch', 'msg', { ctx })`。环境变量 `EMAILDIGEST_LOG_LEVEL=debug` 开 verbose。

## Health check（含 token usage）

**用户说 "检查 / 状态 / spawn / 看看 / token / health / 怎么样" 时的标准动作**：

1. 本地和生产服务器（`ssh prod 'cd ~/emaildigest/web && npx tsx scripts/health-check.ts'`）各跑一次 `scripts/health-check.ts`
2. 比对两端 4 个 section 的差异，重点看：spawn 日分布是否 < 30/day、SetFit pass rate 14d 趋势、最新 ship 的 schema/backfill 是否落地、MCP/auth/logs 错误
3. 报告完如果 token 那段需要 reset，跑 `npx tsx scripts/token-check.ts --mark` 重置 baseline

**不要凭记忆挑维度查**。health-check.ts 是 single source of truth — 加了新维度直接改脚本，不要在脚本之外另跑 ad-hoc SQL（除非脚本输出指引你深挖具体行）。

| 脚本 | 用途 |
|---|---|
| `scripts/health-check.ts` | 4 section 综合：spawn 日分布+cost / SetFit pass rate 14d / Gmail 特性落地 / MCP+logs |
| `scripts/token-check.ts` | 仅 spawn cost 维度（health-check section 1 复用其 classifyPrompt 逻辑）|
| `scripts/token-check.ts --mark` | 重置 token baseline（health-check 不会自动重置 — 调查完手动跑）|

Caller 检测靠 prompt 前 400 字 regex 匹配（event-extract / email-digest / draft-gen / ask-ai / jobs-confirm / merged-prefetch / llm-classify）。新增 caller 需在两个脚本的 `classifyPrompt` 同时加 pattern（grep 一下别漏，见 lessons-learned §21 平行漂移防御）。Briefing 已于 2026-05-02 退役，auth probe 已于 2026-04-29 删除。

Baseline 写在 `app_state.token_check_baseline_at`（local + PROD 各自独立）。已于 2026-04-29 06:33 UTC 两端 plant 初始 baseline。**新增维度时改脚本**：不要往这个 doc section 堆 SQL — 脚本是 source of truth，doc 只指 "跑 health-check"。

## 应急关停 / Emergency stop

**Event-extractor** 自 2026-05-01 起改为 `/calendar` Scan inbox 按钮手动触发 + 单 spawn 批量，天然受控。下面 env 仍保留作 belt-and-suspenders：

```
echo "EMAILDIGEST_DISABLE_EVENT_EXTRACT=1" >> ~/emaildigest/web/.env.local
sudo systemctl restart emaildigest
```

`extractEventsForBatch` 入口 short-circuit 返回 0，**不 spawn**。用于 Anthropic rate-limit / 账号 ban 等场景（按钮按下也不会触发）。删除 env + 重启即恢复。已存在的 events 仍可读。

**Codex CLI auth probe 已删除**（2026-04-29）。改走 `lib/auth-status.ts` 被动检测：每个直 spawn 路径在非零 exit 时调 `flagAuthFailureIfMatch` 扫 stderr 关键词染色 `claude_auth_status`；下次成功调用 `clearAuthFailure` 翻回 ok。无需主动 probe。
