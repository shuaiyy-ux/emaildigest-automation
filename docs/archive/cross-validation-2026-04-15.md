# Cross-Validation Report (Round 3) — EmailDigest
Date: 2026-04-15
Team size: 4 validators
Files analyzed: 42
Cross-boundary checks: 26
Data flows traced: 8

## Executive Summary

All Task 1-3 fixes verified correct. One new actionable bug found: `prose` Tailwind classes in mail-display.tsx require `@tailwindcss/typography` plugin which is not installed, meaning HTML email bodies render without typography reset and dark-mode text colors. No critical issues. All cross-boundary checks pass.

## Team Composition

| Validator | Scope | Files | Findings |
|-----------|-------|-------|----------|
| v1 | Data Models & Sanitize | 6 | 0 critical, 0 major |
| v2 | API Routes & Jobs | 8 | 0 critical, 0 major |
| v3 | Pipeline & Shell | 17 | 0 critical, 0 major |
| v4 | Mail UI | 11 | 0 critical, 1 major |

## Critical Findings

None.

## Major Findings

### 1. `prose prose-invert` classes require uninstalled `@tailwindcss/typography` [v4]
`web/components/mail/mail-display.tsx:148` — HTML email rendering uses `prose prose-invert max-w-none` Tailwind classes, but `@tailwindcss/typography` is not in package.json. These classes have zero effect — HTML emails render without typography reset (no margins/spacing on p, h1, blockquote, table) and without dark-mode text inversion (black text invisible on dark background).
**Fix**: Install the plugin or replace with manual CSS.

## Minor Findings

- 3 dead API endpoints: `delete` draft, `reclassify` emails, `refresh` emails (no UI callers) [v2]
- `DANGEROUS_TAG_REGEXES` lastIndex reset is redundant with `String.replace()` (safe, unnecessary) [v1]

## Cross-Boundary Consistency — All Pass

- EmailRow ↔ CREATE TABLE: 16 columns match
- Email type ↔ toResponse() in both API routes: all fields match
- Draft type ↔ DraftRow ↔ drafts toResponse(): all 14 fields match
- EmailCategory across 5 sources (types.ts, classifier.ts, classify.txt, config.sh, category-picker.tsx): all 9 match
- Urgency across 3 sources (types.ts, classifier.ts, digest.txt): all 4 match
- Command type ↔ emaildigest case ↔ VALID_COMMANDS: all 5 match
- Job/StatusResponse lifecycle: consistent end-to-end
- sanitize.ts exports ↔ mail-display.tsx imports: all 3 functions match
- SAFE_TAGS ↔ isHTML detection ↔ sanitizeHTML allowlist ↔ closing tag filter: all in sync
- All 15 UI fetch calls match API endpoint handlers

## Confirmed Cross-Boundary Bugs

None — all boundaries are consistent.

## Known Issues (deferred, unchanged from round 2)

- digest.sh:11 Chinese urgency labels
- draft.sh no EMAILDIGEST_READONLY
- askResultSnapshot dead code
- Duplicate getBadgeVariant
- Unread tab non-functional
- isCommandRunning guard missing on drafts
- reclassify/briefing missing readonly

## Recommended Actions

1. **Install `@tailwindcss/typography`** or replace prose classes with manual CSS (Major #1)
