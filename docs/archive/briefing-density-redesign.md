# Briefing & Daily-Digest density redesign

**Date**: 2026-04-30
**Author**: with the project owner
**Commits**: see git log around this date for `fix(briefing)` / `fix(daily-digest)` / `feat(junk)` entries.

## Problem

The dashboard had three issues with summarized text, all surfaced from real screenshots:

1. **Briefing summaries (the 4 category cards) were verbose narrative prose.**
   Example NEWS card: *"The UCI Campus Recreation office has sent a reminder email regarding important updates to summer facility hours and membership renewal for students."* — 22 words, ~3 facts. Filler ratio ~50%.

2. **Daily-digest was bullets**, after commit `3fb27bb fix(daily-digest): replace narrative paragraphs with terse bullets`. Bullets felt choppy + repeated context per item; user explicitly rejected the format on visual inspection.

3. **Junk card** had a summary like every other category, and showed read/unread distinction. User mental model: Junk is spam-adjacent — just confirm it's not important. AI summary effort + visual states were both wasted on it.

## Decision

Single design principle for *all* AI-generated text on the dashboard:

> **Complete English paragraphs. NEVER bullets. Maximum information density.**

Per-category shape differs:

| Category | Shape | Why |
|---|---|---|
| Primary | Specific narrative — name senders, concrete actions, key dates | Real-person interactions; user needs to know *who said what* |
| Track / News / custom user categories | Aggregate by type + count: `"You got N <type> from <senders>, M <type>, ..."` | Systems / broadcasts; user only needs *what types and how many* |
| Junk | NO summary at all; card always grayed; no read/unread distinction | Low-attention bucket; effort wasted on AI inference |
| Daily digest Primary / Review | Same as briefing Primary | Same reason |
| Daily digest Track / News | Same as briefing Track / News | Same reason |

## Density rules

Applied at prompt level (system + user) so the model does the work, not the renderer:

**Cut**: filler verbs ("has sent", "regarding", "various", "wanted to share", "is prompting you to", "noting", "in order to"); auto-replies; bare "thanks"; redundant confirmations.

**Use**: strong verbs (locked, flagged, requested, scheduled, posted, cleared, processed); chain facts with commas; preserve verbatim dates/times/$ amounts/course codes/person names/locations.

**Allowed acronyms**: UCI, well-known organization and bank abbreviations, course codes (e.g. COURSE 101). **Forbidden**: invented contractions like "Intl", "Ctr", "Mgmt".

**Empty sections** in daily-digest: return `"(No activity)"`, not empty string (UI treats empty as missing data).

## Examples (calibration)

### Briefing — Primary
- Before: *"Your primary inbox includes UCI Capstone Project updates from Mentor A and Mentor B at Company A, an external thank-you message from Recruiter A, a professionalism reminder from Advisor X, and a document request from Staff Member Y."* (38 words)
- After:  *"Company A's Mentor A and Mentor B pushed UCI Capstone updates plus an interview thank-you, Advisor X flagged professionalism ahead of the on-site visit, Staff Member Y requested your enrollment document."* (31 words, all factual)

### Briefing — Track
- Before: *"You have several track emails including a bank notification about adding an authorized user, a payment app transfer confirmation, and a student club registration confirmation."* (25 words, 3 facts)
- After:  *"You got 2 bank notifications, 1 student club registration confirmation, and 1 COURSE 101 grade post."* (16 words, 4 facts)

### Daily-digest — Track (paragraph, not bullets)
- Before (bullets):
  ```
  - Campus office: enrollment docs received +2 (4/29 + 4/30)
  - Bank: payment sent to Classmate A; new recipient added
  - COURSE 102: Assignment #5 grade posted
  - Utility company: bill now available
  - LinkedIn: 7 new connection invitations
  ```
- After (paragraph): *"You got 2 campus office document receipt confirmations (14:38 today and 4/29), 2 bank alerts (Classmate A added as payment recipient, payment sent), 1 student club registration pending approval, 1 COURSE 102 Assignment #5 grade post, 1 utility bill now available, 7 LinkedIn invitations (5 on 4/29, 2 on 4/28)..."*

## Why paragraph not bullets

Cited by the user explicitly:
- **Bullets repeat context.** Every line redundantly establishes who/what; comma-chained paragraphs share context across facts.
- **Bullets feel choppy.** A scan-friendly UI doesn't need bullets if the paragraph is dense — punctuation does the work.
- **Density > brevity.** A paragraph forces the model to commit to every word; bullets let the model pad each item to "look balanced".

The earlier bullets attempt (commit `3fb27bb`) was a *reaction* to overly long narrative. The correct solution wasn't bullets — it was *denser narrative*. This redesign reverts the format but keeps the density target.

## Junk card design

User: *"JUNK can delete summary feature, and not show read/unread status, always grayed"*

Implementation in `web/components/mail/ai-panel.tsx`:

```ts
const isJunk = cat.id === "cat_junk" || (cat.name || "").toLowerCase() === "junk";
const hasUnread = !isJunk && unread.length > 0;     // never true for junk
const visibleEmails = isJunk
  ? all.slice(0, 5)                                  // mix of read+unread, always 5
  : hasUnread ? unread.slice(0, 3) : readRecent;
```

UI consequences for Junk:
- No AI summary block (skipped at render).
- No unread-count badge.
- No "Mark all as read" button.
- No blue dot on email rows.
- All email rows rendered with muted text (no read/unread visual delta).
- Card gets `opacity-60` (same as other categories' "no unread" state — the card is *always* in that state).

Briefing-pipeline consequences for Junk:
- `lib/briefing.ts groupUnreadForBriefing` filters out `category === "junk"` *before* hitting `findStaleCategories`, so junk never enters the merged-prefetch prompt.
- One less category in the LLM prompt → smaller prompt → cheaper spawn.

## Implementation files

| File | Change |
|---|---|
| `web/lib/merged-prefetch-llm.ts` | `buildBriefingsSection` prompt rewritten with density rules + per-category shape |
| `web/lib/briefing.ts` | `buildPrompt` (legacy fallback path) same prompt rewrite; `groupUnreadForBriefing` filters out junk |
| `web/lib/daily-digest.ts` | `buildPrompt` rewritten to demand single-paragraph strings per section; `SYSTEM_PROMPT` updated; `toBullets` → `toParagraph` (joins legacy arrays with ", " for graceful regression) |
| `web/components/mail/ai-panel.tsx` | Junk-special render path: no badge / no summary / no Mark-All / no blue dots / show all 5 emails muted |

## Acceptance test

Reproduction sequence used:
1. `DELETE FROM briefings; DELETE FROM app_state WHERE key='daily_digest';`
2. `POST /api/emails action=briefing` → poll until done
3. `POST /api/emails/digest` → poll until done
4. Inspect both DB tables.

Verified:
- Briefings have ≥4 entries (one per non-junk active category), each is a single dense paragraph.
- No `briefings` row for `category='junk'`.
- `app_state.daily_digest` JSON has Primary/Track/News/Review as paragraph strings (no `\n-` bullet markers).
- Dashboard screenshot confirms Junk card has no badge / no summary / muted email list.

## Future calibration

If the model regresses (e.g. starts padding "You got" lines with `"various promotional offers"`), the prompt-level fix is to *add the offending phrase to the DROP list* — keep the calibration in the prompt, not in post-processing. Don't add a "fix-up" regex layer.

If the LLM emits arrays again for daily-digest sections (legacy contract), `toParagraph` joins them with `", "` — the user-visible text becomes a paragraph, just less natural. That's acceptable as a short-term fallback; the long-term fix is to keep the system prompt strict.
