# Lesson: grep vs LSP empirical comparison on EmailDigest (2026-05-27)

> **Source**: subagent-driven empirical test in EmailDigest (TypeScript-dominant multi-language repo).
> **Use this when**: deciding whether to install / enable an LSP plugin for a project, justifying the migration away from grep for symbol lookup, or pushing back on "grep is fine".

## TL;DR

LSP eliminates **95–98%** of grep noise on symbol lookup in real multi-language repos. The biggest noise sources are not what you'd guess from a clean codebase — they are docs/changelogs, compound-name dilution, third-party builtins, and **dead ghost symbols** that still appear in markdown but no longer exist in code.

## Setup

- Repo: EmailDigest (this repository)
- Languages: TypeScript 103 files / 15,271 LOC (dominant) · TSX 44 / 8,475 · **Markdown 49 (no LOC count but heavy)** · Shell 9 / 518 · Python 4 / 498 (isolated SetFit training) · JS 1 / 309
- TS:Python ≈ 30:1 by LOC
- Toolchain: `web/node_modules/typescript` already present (tsserver immediately usable, zero new install)

## Three symbol tests

Symbols chosen because they stress grep specifically in **this** repo, not because they are generically common verbs.

| Symbol | Why it stresses grep | grep total | grep noise breakdown | LSP precise refs | Noise reduction |
|---|---|---|---|---|---|
| `classify` | Python ML concept + TS function family (`classifyEmail*`, `reclassify*`) + 9 path collisions + 133 markdown refs + dead ghost symbol | **325** | markdown 133 (41%), compound names ~110, Python (irrelevant for TS) 2, .ts comments ~44 | `classifyEmailsWithLLM` = **7** · `classifyEmail` = **0 (dead)** | **~98%** |
| `parse` | JS builtins (`JSON.parse`, `parseInt`, `parseFloat`) + library (`simpleParser`/`mailparser`) + many `parse*` locals + variable name `parsed` (106×) | **211** | builtins 29, libs 15, variable token-expansion 106, markdown 31 | `parseEmailBody` = 9 · `parseJsonObject` = 10 | **~95%** |
| `embed` | Three distinct concepts share prefix: `embedder` (model class, 139) + `embedding` (vector noun, 297) + `embed*` (functions). Compound names dilute past usefulness | **401** | `embedding` noun 315, `embedder` class 139, markdown 111 | `embedTextForClassify` = 15 | **~96%** |

## Most striking finding: dead ghost symbols

`classifyEmail` appears **4 times in markdown audit/changelog files** but **does not exist in the TypeScript codebase**. Grep sends the agent chasing a function that was renamed or removed. LSP `find_definition` returns 0 hits — instant truth.

**Implication**: Long-lived repos accumulate doc lag. Every renamed/removed symbol becomes a ghost in old PR descriptions, validation reports, decision logs. The longer the repo, the worse grep gets. LSP is the only mechanism that distinguishes "live symbol" from "name historically used".

## Noise sources, ranked (specific to multi-language repos)

1. **Markdown docs / changelogs / audit reports** — 30–41% of grep hits in EmailDigest. Docs accumulate; nobody scrubs them when symbols rename.
2. **Compound-name dilution** — `embedder` matches `embed`; `reclassify` matches `classify`; `parsed` matches `parse`. Word-boundary grep helps but doesn't fully solve.
3. **Variable name vs function name** — `const parsed = parser(...)` — grep can't tell variable usage from function usage; LSP can.
4. **Third-party library identifiers** — `JSON.parse`, `mailparser.simpleParser` show up under the same string but are stdlib/lib refs irrelevant to your codebase.
5. **Wrong-language collisions** — Python `process()` showing up when you grep for a JS `process()`.

## Decision framework: should this repo install LSP?

Yes if any of:
- Total LOC > 5K in any single statically-analyzable language (TS/Python/Go/Rust/Swift/Java/Kotlin/C#)
- Repo has > 30 markdown / doc files (= noise source)
- Repo has > 3 symbols sharing a prefix (= compound-name dilution)
- Repo is multi-language (= cross-language collisions)
- Repo is > 12 months old (= ghost symbol accumulation)

No / not worth if:
- Single-language, < 1K LOC, < 10 markdown files
- Language has no production-quality LSP (e.g. shell, plain config)
- A subset of files (e.g. 4 Python training scripts in EmailDigest) is isolated and rarely touched

## Cheaper alternative if you skip LSP

Add a default grep `--exclude` for noise:

```bash
grep -r "X" --exclude-dir={node_modules,.next,dist,build,.git} --include="*.{ts,tsx,js,jsx}" .
```

This removes 30–40% of EmailDigest noise (the markdown layer). **Does not solve** compound-name dilution or ghost-symbol detection — those require LSP.

## Practical install for EmailDigest specifically

- ✅ `typescript-lsp@claude-plugins-official` — zero install (tsserver in node_modules). Point at `web/tsconfig.json` and `mcp-server/tsconfig.json`.
- ❌ `python-lsp` — 4 isolated training files; pyright install + maintenance overhead > grep pain saved.

## Cross-project applicability

The 95–98% reduction is repo-specific. Other repos likely see:
- TypeScript-heavy with low doc volume: probably 80–90% reduction
- Python untyped legacy: lower (pyright in basic mode finds less)
- Single-language clean repo: lower (maybe 60–70%)

But **the dead-symbol problem is universal** — any repo > 12 months old benefits from LSP for this alone.

## Source

This lesson was produced by Claude running a subagent comparison in EmailDigest while updating a cross-project tooling methodology note (section "LSP") on 2026-05-27. The subagent's raw output is preserved in this file's table data.
