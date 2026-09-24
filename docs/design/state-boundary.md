# State boundary — backend owns long-task state

> Adapted from a state-boundary note written for a sibling project. Same principle, mapped to EmailDigest's specific surfaces.

## Principle

**Backend = source of truth; frontend = projection.**

Any state that **only the backend can know authoritatively** — a long task in flight, a lock occupied, a session alive, a resource being generated — must NOT be owned solely by `useState`. Frontend mounts pull + poll/SSE-derive it.

Violating this means F5 mid-task → UI lies → user re-clicks → duplicate spawn → wasted Anthropic quota.

## 5-question judgment for any piece of state

| # | Question | yes → owned by |
|---|---|---|
| 1 | Survives page refresh? (user F5 still wants to see it) | **backend** |
| 2 | Multi-tab / multi-device shareable? | **backend** |
| 3 | Born from a backend subprocess / >3s LLM/IO task? | **backend** |
| 4 | Unsubmitted user input (form / textarea draft)? | **frontend** |
| 5 | UI-local interaction (hover / focus / dropdown)? | **frontend** |

Mixed states (some persistable + some local): **split** them.

## EmailDigest applications

### Already compliant
- `prefetch.fetching` exposed via `GET /api/emails`'s `fetching` flag → `mail.tsx` 60s poll
- `email-digest.refreshing` exposed via `GET /api/emails/digest`
- Drafts content (to/subject/body) auto-saved every 2s
- Schedule send: `scheduled_at` in `drafts` table, cron drains
- Ask AI: SSE session + `?sid=` URL param, CLI-side `--resume`

### Fixed in this branch
- **AI Generate (120s LLM job)** — anchored to `drafts.ai_generating_started_at` + `drafts.ai_generating_job_id`. Frontend mount checks marker, resumes polling the same `jobId` instead of double-spawning.
- **Scan Inbox (240s Haiku batch)** — anchored to `app_state.event_scan_started_at`. /calendar mount polls `GET /api/events?scanStatus=1`; if running, shows progress and waits instead of letting user re-click.

### Not (yet) compliant
- **Push to Gmail (60s)** — same shape as AI Generate; not done in this branch (was deferred). Same fix applies: add `drafts.push_started_at` + `drafts.push_job_id`.
- **forceClassifyAsJob right-click** — short (~10s); F5 race rare. Tolerable.

## Implementation pattern

### "Anchor to a stable resource ID"

For long tasks tied to a specific row (draft, application, email):
- DB column: `<task>_started_at INTEGER` + optionally `<task>_job_id TEXT`
- API entry point: marks the row at start; rejects with 409 + the existing job_id if a fresh marker exists; clears (try/finally for sync; explicit `ackAi` action for async via jobs.ts)
- Component mount: hydrates from row; if marker fresh, resume polling

### "Anchor to a global lock"

For singleton long tasks (Scan Inbox, future "rebuild centroids"):
- `app_state` key: `<task>_started_at`
- API exposes `?xxxStatus=1` query that returns `{isRunning, startedAt}`
- API rejects new triggers with 409 if running

### Freshness window

`SCAN_FRESHNESS_SEC = task_timeout + 10s` grace. Anything older = process died, treat as cleared. This survives unclean shutdowns without leaving permanent locks.

## Anti-patterns to fix on sight

- `useState(loading)` for a >3s backend task with no DB column backing it
- Toast / Notification as *only* progress feedback for a long task
- Synchronous POST that holds the connection but exposes no in-progress signal to other clients / refreshes
- Stale lock with no timeout — once stuck, the user must restart the backend to clear it
