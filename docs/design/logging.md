# Logging

## 设计哲学

`console.log` 散在 lib/ 各处时，debug 必须靠 `grep logs/next.log` 一坨纯文本。本系统加一层结构化日志：

- **双写**：stdout（systemd / cloudwatch tail 习惯）+ SQLite（可查询历史）
- **异步 batch**：高频 info（每封邮件 classify、breaker tick）走 1s/100 行缓冲，不阻塞主线程
- **trace_id**：跨 step 关联同一逻辑流（一次 prefetch / 一次 batch extract / 一次 API 请求）
- **levels**：`debug` 仅 stdout，不入 DB，避免低价值日志撑大表
- **保留 7 天**：启动时一次性 `DELETE FROM logs WHERE ts < now - 7*86400`

落地到 SQLite 与本系统其他持久化保持一致——可以直接 `sqlite3 data.db` 查问题。

## API

```typescript
import { log, newTraceId } from "@/lib/logger";

// Top-level
log.info("prefetch", "Step 1 done", { emails: 200, ms: 1500 });
log.warn("imap", "parse error", { err });
log.error("auth", "Claude CLI auth failure", { snippet });

// Component-bound (recommended)
const plog = log.child("prefetch");
plog.info("Step 1 done", { emails: 200, ms: 1500 });

// Trace-bound (for cross-step correlation)
const traceId = newTraceId("p");          // "p_1717123456_a3f"
const lp = plog.trace(traceId);
lp.info("Step 1 done", { ms: 1500 });     // every line emitted via lp shares trace_id
```

### Levels

| Level | When | Persisted? |
|---|---|---|
| `debug` | 高频 verbose 调试，dev only | ❌ stdout only |
| `info` | 正常操作完成 / 状态变更 | ✓ |
| `warn` | 单封邮件失败 / fallback 路径 / breaker tick | ✓ |
| `error` | 真正的故障 / 数据丢失 | ✓ |

环境变量 `EMAILDIGEST_LOG_LEVEL=info`（生产默认）/ `debug`（开发调试）控制 stdout 阈值。

### ctx 参数

第三个 object 参数会被 `JSON.stringify`：
- `Error` 实例自动展开为 `{name, message, stack}`
- 循环引用 → `"[Circular]"`
- 函数被 strip
- 序列化失败 → `null`（不抛错）

## Component 命名约定

| component | 谁写 |
|---|---|
| `prefetch` | `lib/prefetch.ts` step 转换、计时 |
| `email-digest` | `lib/email-digest.ts` 重生成、push 触发判断 |
| `push-digest` | `lib/email-digest.ts triggerPushIfReady` push send |
| `imap` | `lib/imap.ts` parse 错误 |
| `idle` | `lib/imap.ts startIdleListener` 连接、IDLE 推送、断线重连 |
| `breaker` | `lib/circuit-breaker.ts` 状态变化 |
| `auth` | `lib/auth-status.ts` token 失败 / 恢复 |
| `startup` | `instrumentation.ts` |
| `scheduler` | `instrumentation.ts` scheduled draft cron |
| `digest-cron` | `instrumentation.ts` email-digest stale check loop |

新增 component 时直接用 `log.child("name")`，不需要中央注册。约定是 lowercase + dash，对应业务领域一个词。

## 查询样例

debug 第一步——查最近一次 prefetch 的所有 step：

```sql
-- 1. 找到最近一次 prefetch trace_id
SELECT DISTINCT trace_id FROM logs
WHERE component='prefetch' AND ts > unixepoch() - 3600
ORDER BY ts DESC LIMIT 1;

-- 2. 拉那次 prefetch 全部 log（按时间顺序）
SELECT ts, level, component, message, ctx FROM logs
WHERE trace_id='p_1717123456_a3f'
ORDER BY ts;
```

过去 24h 错误：

```sql
SELECT datetime(ts,'unixepoch','localtime') as time, component, message, ctx
FROM logs
WHERE level='error' AND ts > unixepoch() - 86400
ORDER BY ts DESC;
```

某 component 最近活动：

```sql
SELECT datetime(ts,'unixepoch','localtime'), level, message
FROM logs
WHERE component='email-digest' AND ts > unixepoch() - 7*86400
ORDER BY ts DESC LIMIT 50;
```

Breaker 在过去一周的状态变化：

```sql
SELECT datetime(ts,'unixepoch','localtime'), message, ctx
FROM logs WHERE component='breaker'
ORDER BY ts DESC;
```

## SQL Schema

参见 [database.md `logs` 表](database.md#logs-表)。要点：

- `id` autoincrement、`ts` unixepoch
- `level` CHECK constraint 限定 4 个值
- `component` / `message` 必填，`ctx` 可空 JSON 字符串，`trace_id` 可空
- 三个索引：`(ts DESC)` / `(component, ts DESC)` / `(level, ts DESC) WHERE level IN ('warn','error')`

## 不做（明确 scope）

- **远程聚合**（CloudWatch / Loki / Datadog）：单机部署 + SQLite 已经够用，未来需要再加 sink
- **Sentry**：`level='error'` + `ctx.err.stack` 已覆盖大部分需求
- **OpenTelemetry / W3C trace context**：跨进程分布式追踪 overkill
- **Profiler / metrics gauges**：不在 logging 范围；token-check.ts 算 spawn 数本身就是一种 metric

## 何时增加 log 调用

加：
- 任何 LLM spawn 起止 + 时长（含 trace_id）
- breaker 状态翻转
- IMAP 连接 / 断线 / 重连
- 单封邮件失败但整批继续（`level=warn`）
- 关键不变量违反（`level=error`）

不加：
- DB single-row CRUD（噪音 > 信号）
- 客户端事件（log 系统是 server-side only）
- API 路由的请求/响应（access log 由 Next.js 内置）
