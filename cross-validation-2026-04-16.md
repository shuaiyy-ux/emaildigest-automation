# Cross-Validation Report — EmailDigest
Date: 2026-04-16 01:20
Team size: 4 validators
Files analyzed: 35 (all project source files)
Cross-boundary checks: 44
Data flows traced: 16

## Executive Summary

The codebase is well-structured with consistent API contracts and correct frontend-backend data flows. However, **2 critical bugs** were found in the classification feedback loop: the Bayesian correction feature is silently dead (wrong field passed for domain extraction), and user category corrections are destroyed on every prefetch refresh. These undermine the core "learning from user feedback" feature. Recommended immediate action: fix both critical bugs, then address the 4 major findings.

## Team Composition
| Validator | Scope | Files | Findings |
|-----------|-------|-------|----------|
| validator-1 | Data Layer & Classification | 6 (+4 cross) | 2 critical, 2 major, 4 minor |
| validator-2 | API Routes & Job System | 8 | 0 critical, 0 major, 5 minor |
| validator-3 | Frontend Components | 11 | 0 critical, 2 major, 3 minor |
| validator-4 | CLI, Security & Sanitization | 16 | 0 critical, 0 major, 2 minor |

## Critical Findings

### C1. Bayesian correction is silently a no-op
**Found by**: validator-1 | **Files**: `classifier.ts:104`, `prefetch.ts:54`

`classifyEmail()` receives `email.from` (display name like "John Smith") but tries to extract a domain from it. Since display names don't contain `@`, the fallback `from.split(" ").pop()` produces "Smith", which never matches `from_domain` in the corrections table (e.g. "uci.edu"). Result: `getCorrectionBias()` always returns `{bias: {}, total: 0}` — the entire Bayesian correction feature is dead.

**Fix**: Pass `email.fromEmail` to `classifyEmail()` as a 4th parameter, or change `prefetch.ts:54` to pass `fromEmail`.

### C2. Prefetch destroys user-corrected categories
**Found by**: validator-1 | **Files**: `prefetch.ts:36-41`, `db.ts:71-76`

Every prefetch upserts emails with `category: "notification"`. The ON CONFLICT clause unconditionally overwrites: `category = excluded.category`. If a user corrected a category via CategoryPicker, the next refresh resets it to "notification" before ML re-classifies (potentially to something different from the user's choice).

Compare: `body` and `from_email` have `CASE WHEN` guards to preserve existing values — `category` should too, or better: skip `category` on conflict entirely and let only classification steps set it.

## Major Findings

### M1. Intermediate stale state visible during prefetch
**Found by**: validator-1 | **File**: `db.ts` upsertEmails

Between Step 1 (upsert with `category="notification"`, `urgency="fyi"`) and Step 2 (ML classification), a GET request would return all emails with wrong categories. The upsert resets urgency to default since `urgency` isn't in the INSERT column list.

### M2. LLM confidence hardcoded to 0.9
**Found by**: validator-1 | **File**: `prefetch.ts:98`

LLM reclassification sets `confidence = 0.9` for all results. This synthetic score is higher than many genuine ML scores, making LLM results appear more confident than they are. If any downstream logic uses confidence thresholds, this will produce incorrect behavior.

### M3. Briefing useEffect dependency on object reference
**Found by**: validator-3 | **File**: `ai-panel.tsx:119`

The briefing fetch effect depends on `[emails.length, briefing]`. Since `briefing` is an object, React uses reference equality. The early return prevents infinite loops in practice, but the dependency is fragile — should use a `hasFetched` ref instead.

### M4. Briefing polling loop lacks cancellation between awaits
**Found by**: validator-3 | **File**: `ai-panel.tsx:93-115`

The polling loop checks `cancelled` in the loop condition but not between async operations. After `setBriefing()`, the code continues to POST `cacheBriefing` even if the component unmounted. The `setBriefing` call on unmounted component is suppressed by React 18+, but the `cacheBriefing` POST fires regardless (acceptable as a server-side write, but not clean).

## Minor Findings

| # | Source | Finding |
|---|--------|---------|
| 1 | V1 | `toResponse()` in emails routes omits `received_at`/`fetched_at` — data lost at API layer |
| 2 | V1 | `EmailRow.category` is `string` but `Email.category` is `EmailCategory \| undefined` — no runtime validation |
| 3 | V1 | `CATEGORY_LABELS` keys and `EmailCategory` union defined independently — could diverge |
| 4 | V1 | `computeEmailHash` uses weak Java hashCode — collision possible but benign |
| 5 | V2 | Duplicate `toResponse` mapping in `emails/[id]/route.ts` vs `emails/route.ts` |
| 6 | V2 | `drafts/route.ts:toResponse` can return null in array — defensive but dead code |
| 7 | V2 | `pushToGmail` frontend doesn't check `saveDraft()` success before proceeding |
| 8 | V2 | `/api/run` endpoint never sets `EMAILDIGEST_READONLY` — AI panel inquiries run with full tools |
| 9 | V2 | `recordCorrection` stores previous category as `ml_category` even if it was user-set |
| 10 | V3 | `unreadCount` computed globally, not per-view |
| 11 | V3 | `draft-editor.tsx` emailId fallback when initialDraft.emailId is null |
| 12 | V4 | `sanitizeForPrompt` 200-char truncation may lose classification signal on long subjects |
| 13 | V4 | `stripLLMContamination` suffix patterns could false-positive on legitimate Chinese content |

## Cross-Boundary Issues

### XB1. `/api/run` missing readonly (V2) ↔ useJob hook (V3)
The `useJob` hook (used by AIPanel's Ask AI and Quick Actions) calls `POST /api/run` which spawns subprocess without `EMAILDIGEST_READONLY=1`. The inquiry and digest commands run with full tool access including `gmail_create_draft`. In contrast, the internal briefing/reclassify/aiGenerate paths in the API routes correctly set readonly.

### XB2. `recordCorrection` semantic mismatch (V1 + V2)
Both validators independently identified: `insertCorrection` stores the previous category as `ml_category`, but when a user re-corrects an already-corrected email, the "ml_category" is actually the previous user correction. This degrades feedback loop accuracy over multiple corrections.

## Confirmed Cross-Boundary Bugs

### CB1. Bayesian correction dead due to wrong field crossing prefetch→classifier boundary
Validator-1 found that `prefetch.ts:54` passes `email.from` (display name) to `classifyEmail()`, and `classifier.ts:104` tries to extract domain from it. Validator-4 confirmed the READONLY chain and category sync work correctly — the bug is specifically at the data handoff between prefetch and classifier.

### CB2. Category reset crossing upsert→classification boundary
Validator-1 found the upsert resets category. Validator-2 confirmed the ON CONFLICT SQL in their db.ts function analysis. Validator-3 confirmed the CategoryPicker correctly calls setCategory+recordCorrection. The bug is that the prefetch pipeline's Step 1 undoes Step 2's work from the previous run.

## Observations

- Job store is in-memory — server restart loses all in-flight jobs (V2)
- `setInterval` cleanup in jobs.ts runs as module side effect (V2)
- `parseJsonArray` greedy regex could over-match with footnoted text (V1)
- All 18 frontend fetch() paths verified correct against API routes (V3)
- All 12 CLI/security cross-boundary checks pass (V4)
- Categories synchronized across all 4 sources: config.sh, classify.txt, classifier.ts, types.ts (V4)
- EMAILDIGEST_READONLY env var chain complete from subprocess.ts through common.sh (V4)
- HTML sanitizer processing order correct for security (V4)

## Recommended Actions (Priority Order)

1. **Fix C1**: Pass `fromEmail` to `classifyEmail()` in prefetch.ts — restores Bayesian correction
2. **Fix C2**: Add `CASE WHEN` guard on `category` in upsertEmails ON CONFLICT — preserves user corrections
3. **Fix XB1**: Add `{ readonly: true }` to `runCommand` call in `/api/run/route.ts` (or add a readonly field to RunRequest)
4. **Fix M3/M4**: Refactor briefing useEffect with `hasFetched` ref and add cancellation checks
5. **Fix Minor #9**: Rename `ml_category` to `old_category` in corrections table (or track classifier source)
6. **Fix Minor #5**: Extract shared `toResponse` for emails routes
7. **Fix Minor #7**: Check `saveDraft()` response before proceeding to pushToGmail
