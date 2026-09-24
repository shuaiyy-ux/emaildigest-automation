# Briefing staleness trigger — switch from unread-set hash to received_at watermark

**Date**: 2026-05-01
**Commit**: see git log for `fix(briefing): change stale trigger to received_at`

## Problem

The 2026-04-14 commit `031b216 feat: persistent briefing cache — skip LLM when emails unchanged` introduced a hash-based cache for category briefings:

```ts
// briefing.ts groupUnreadForBriefing
for (const e of all) {
  if (e.is_unread !== 1) continue;  // unread-only
  ...
}

// db.ts computeEmailHash
emails.map(e => e.id).sort().join(",") → hashCode → base36

// briefing.ts findStaleCategories (old)
const currentHash = computeEmailHash(emails);   // hash of unread set
const storedHash = getBriefingHash(cat);
if (currentHash !== storedHash) stale.push(cat);
```

Intent: skip the LLM when emails haven't changed. Real effect: the hash changes whenever the unread *set* changes, including the very common case of the user **reading an email**. Reading shrinks the unread set → hash differs → category marked stale → next prefetch fires merged-prefetch spawn.

## Empirical evidence

PROD measurement window 2026-04-30 20:57 UTC → 2026-05-01 05:30 UTC (8.8h):
- 12 merged-prefetch spawns
- Last new email: 01:27 UTC (4 hours before window end)
- 2 spawns fired *after* last_email (at 01:50 and 04:00 UTC)
- Those 2 spawns had nothing in `classifyEmails` or `jobsEmails` queues
  (caught up). Only `briefingStaleCategories` could have triggered them
  → user reading emails was the trigger.

Projected impact: ~50% of merged-prefetch spawns/day are read-driven (≈
15-20 of the projected 33/day). Switching the trigger to "max
received_at > last briefing time" eliminates this class of spawn
entirely.

## New trigger

```ts
export function findStaleCategories(groups): string[] {
  const stale = [];
  for (const [cat, emails] of Object.entries(groups)) {
    if (emails.length === 0) continue;
    const lastBriefingAt = getBriefingUpdatedAt(cat);
    if (lastBriefingAt === null) { stale.push(cat); continue; }
    const maxReceived = Math.max(...emails.map(e => e.received_at || 0));
    if (maxReceived > lastBriefingAt) stale.push(cat);
  }
  return stale;
}
```

Semantic: "is there an unread email that arrived AFTER we last
summarized this category?"

| Event | max received_at | briefing.updated_at | stale? | spawn? |
|---|---|---|---|---|
| New email arrives | bumps up | unchanged | yes | yes ✓ |
| User reads email | unchanged | unchanged | no | no ✓ |
| User marks unread | unchanged | unchanged | no | no (acceptable) |
| First run (no briefing) | any | null → treated stale | yes | yes ✓ |
| LLM spawn fails | unchanged | unchanged | yes (still) | retries ✓ |

## Trade-offs

**Acceptable degradation**:
- Briefing text may say "You got 5 bank notifications" when 4 are now
  read. That's a count drift, not a content drift. Same names, same
  topics — the briefing is still informative.
- User toggling read→unread (rare) doesn't refresh the briefing. They
  presumably toggled because they meant to come back; the existing
  briefing still mentions the email.

**Not acceptable, mitigated**:
- Briefing entirely missing a sender → would only happen if a sender
  is exclusive to one category and that briefing is older than that
  sender's first email AND was not regenerated (impossible: max
  received > last briefing → stale → regen).

## Schema decision

Keeping `briefings.email_hash` column populated via `upsertBriefing(cat,
summary, hash)`. The hash is no longer consumed by the staleness path
but stays in the table. A later cleanup PR can drop both the column and
`computeEmailHash` together; doing it now would mix a migration with a
behavior change.

## Acceptance test

Reproduce post-deploy:
1. Note current `briefings.updated_at` for some category.
2. POST `action=setRead` on an unread email in that category.
3. Wait ≥60s (UI polling) or trigger refresh.
4. Verify `briefings.updated_at` unchanged → no LLM spawn fired.
5. Wait for new email in that category.
6. Verify `briefings.updated_at` advances → spawn fired (intended).

## Future cleanup (optional)

- Drop `email_hash` column and `computeEmailHash` function once we're
  confident in the new trigger over a few weeks.
- Could add `briefings.last_max_received_at` column (write at upsert
  time) to make the staleness check faster and tolerate edge cases like
  tz jumps. Not needed for current correctness.
