# Signals of "Importance" for Already-Read Emails

**Purpose**: framework for deciding which already-read emails should resurface in UI elements like the Email Digest "Review" section, reminder badges, or future follow-up features.

**Design principle**: importance is not a mood, it's a set of **objective, structured DB signals**. Any "smart ranking" layer we add later sits on top of these — it does not replace them.

---

## The 5 signals

| Signal | Location in DB | Why it counts as "important" |
|---|---|---|
| **Un-expired TTL** | `emails.primary_until > now` | Verification codes / same-day assignments / RSVP — you've read it but the time window hasn't passed. |
| **Upcoming event** | `events.start_ts > now` | Interviews, lectures, office hours — you've read the email but the date hasn't arrived. |
| **Active job pipeline** | `applications.current_stage ∈ {interview_scheduled, interviewed, offer}` | The follow-up window after an interview — easiest stage to forget action items. |
| **Unfulfilled `needs_action`** | `job_emails.needs_action = 1 AND deadline > now` | The system has judged "this needs a response" and the deadline hasn't passed. |
| **Recent Primary** | `category_id = 'cat_primary' AND received_at > 48h` | Direct human communication — even after reading, the reply might still be pending. |

**All five conditions are evaluated against `is_unread = 0` emails** — the unread bucket is handled by the "New" pipeline separately.

---

## SQL reference

Union of all 5 signals — used by Daily Digest Review section:

```sql
SELECT DISTINCT e.*
FROM emails e
LEFT JOIN events ev        ON ev.email_id = e.id
LEFT JOIN job_emails je    ON je.email_id = e.id
LEFT JOIN applications a   ON a.id = je.application_id
WHERE e.is_unread = 0
  AND e.category_id != 'cat_junk'
  AND (
    (e.primary_until IS NOT NULL AND e.primary_until > unixepoch())
    OR (ev.start_ts > unixepoch())
    OR (a.current_stage IN ('interview_scheduled','interviewed','offer'))
    OR (je.needs_action = 1 AND je.deadline > unixepoch())
    OR (e.category_id = 'cat_primary' AND e.received_at > unixepoch() - 48*3600)
  )
ORDER BY e.received_at DESC
LIMIT 15
```

---

## What this catches vs what it doesn't

**Catches**:
- "Interview on Monday 2pm" email you read on Friday (event signal)
- "Verification code valid 30 min" read 5 min ago (TTL signal)
- An ongoing Company A / Company B application you're mid-interview (pipeline signal)
- Professor X's email you acknowledged but haven't replied to (Primary + 48h)

**Doesn't catch**:
- A casual but meaningful email from a friend (no time signal, not Primary-class)
- A course announcement you should remember but has no deadline
- Anything tagged by a human signal we don't track (starred, pinned, "important")

**Rationale for the miss**: if the system has no objective reason to flag it, reminding the user is noise, not signal. The user can find these by normal Inbox search — they don't belong in a resurface surface.

---

## Why structured-signal > LLM-judgment

| Approach | Reliability | Cost | Debuggable |
|---|---|---|---|
| **Structured signals (this doc)** | Deterministic — same DB state → same emails surfaced | ~1 SQL query | Every email has a reason it appeared |
| **LLM picks "important" from read emails** | Flips run-to-run | 10K+ input tokens per digest | Opaque — "why did this email NOT appear?" has no answer |
| **Hybrid (SQL filter → LLM ranks)** | Medium | Medium | Partial — you can explain SQL step, LLM step still opaque |

For a "don't forget things that matter" surface, **reliability beats cleverness**. LLM can write prose over the 15 candidates, but it should not decide the candidate set.

---

## Related design docs

- [email-pipeline.md](./email-pipeline.md) — how `primary_until` gets set via `ttl-rules.ts`
- [database.md](./database.md#events-表) — events table schema and population
- [architecture.md](./architecture.md) — jobs pipeline that produces `needs_action` / `applications.current_stage`

## Future extensions (not scoped now)

- **User-explicit flag**: add an `is_important` column + UI gesture (long-press or star icon) → becomes a 6th signal
- **Reply latency**: if user read a Primary email ≥ 24h ago and hasn't sent a reply, boost it — currently no `replied_at` tracking exists
- **Read frequency**: count how many times an email was opened; opened-repeatedly implies importance — requires `email_opens` log table (not built)
- **Semantic similarity to pending calendar events**: "this email mentions the same meeting" — requires event↔email linking beyond current `events.email_id`
