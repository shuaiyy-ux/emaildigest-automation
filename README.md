> **Anonymized sample data. Names, addresses, IDs, phone numbers and amounts are replaced; dates are shifted.**

# EmailDigest

An email automation system I built for my own university inbox and ran on a small cloud server during spring 2026. New mail arrives over IMAP push, a local classifier sorts it in about 21 ms per message and hands only the uncertain cases to an LLM, and the app then tracks job applications, pulls calendar events out of messages, drafts replies for review, and answers questions about the whole mailbox through an agent with its own MCP tools.

Stack: Next.js 16, React 19, SQLite in WAL mode, transformers.js with MiniLM and fine-tuned SetFit models on ONNX, the Claude CLI as the LLM runtime, and a custom MCP server.

A hosted demo, running on an anonymized copy of 407 real messages from April and May 2026 with dates shifted to the present, is available on request.

## What it automates

| Stage | How it works |
|---|---|
| Intake | IMAP IDLE keeps a connection open, so a message is fetched seconds after it lands. A one-year backfill runs on an empty database. |
| Classification | A SetFit model, MiniLM fine-tuned on my labels plus a logistic head, sorts mail into four categories. Only messages with top-1 confidence below 0.80 go to the LLM. My corrections become new training examples and the head can retrain at runtime. |
| Job tracking | A second SetFit model flags recruiting mail. Flagged threads are grouped into applications with a stage, deadline and next action on a kanban board. |
| Calendar | An extraction step turns invitations and announcements into calendar events with RSVP deadlines. |
| Drafts | Reply, forward and compose drafts are generated on request, edited locally, then sent over SMTP, scheduled, or pushed to Gmail drafts. Nothing is sent without a click. |
| Digest | A periodic summary of what changed, pushed to the phone at fixed times. |
| Ask AI | An agent answers questions about the mailbox through three read-only MCP tools, `search_emails`, `read_full_email` and `get_application`, backed by chunked MiniLM embeddings. |

The Automation page in the app replays a sample day of this pipeline, message by message, next to the figures below.

## Results in production

- Moving routing off the LLM cut CLI calls from 464 a day to 131 to 155 a day, and tokens from 69.5M to 22 to 28M a day (`docs/analysis/2026-04-27-token-usage.md`).
- The SetFit classifier reached 97.1% on 35 held-out messages and 97.8% on its 354 training samples, with every one of the 80 most recent messages clearing the 0.80 confidence gate, at 21 ms per message (`docs/changelog/2026-05-04-setfit-4way-classify.md`). The same change was projected to bring model spawns from about 30 to about 11 a day.
- A circuit breaker and a stability audit came out of an outage day when a retry loop made 1,213 CLI calls (`web/lib/circuit-breaker.ts`, `stability-audit.md`, same token-usage table).

## My contribution

I am the only developer. I designed the pipeline, trained the classifiers (`training/`), built the Next.js app, the MCP server and the deployment, and ran it daily on my own mail.

## How it was built

I wrote the feature specs in `docs/specs/` and the design docs in `docs/design/`, and implemented them with Claude Code as the coding agent. `AGENTS.md` is the brief the agent works from. Evaluation scripts in `web/scripts/` (`eval-classifier.ts`, `eval-job-classifier.ts`, `validate-rag.ts` and others) are the acceptance checks. Most design docs are written in Chinese, my working language.

## Run locally

```bash
cd web
npm ci
npm run build
npm run start        # http://localhost:3000, or npm run dev
```

Live mail needs `GMAIL_USER`, `GMAIL_FROM_ADDRESS` and `GMAIL_APP_PASSWORD` in `web/.env.local`, and a logged-in Claude CLI. `scripts/build-verify.sh` builds both the web app and the MCP server.

## Public demo mode (`DEMO_MODE=1`)

The public demo runs on a static, anonymized mailbox behind a separate gateway that handles access tokens, quotas and visitor logs. In this mode the app itself:

- skips its own token check and leaves authentication to the gateway, and answers `/api/internal/*` only for loopback requests without gateway or Cloudflare headers;
- does no IMAP backfill or IDLE, and answers the page's 60-second refresh with `{"status":"static"}`;
- simulates sending, scheduled sending and Push to Gmail, so drafts show as sent or pushed while nothing leaves the server;
- returns 403 on `/api/run`, sends no web push, and turns off attachment uploads;
- regenerates the digest only when a visitor asks;
- loads the embedding model only from `EMAILDIGEST_MODEL_CACHE` and never downloads at runtime;
- keeps Ask AI sessions, chat history, drafts and profile names separate per visitor, using the `X-Demo-User` header the gateway sets;
- reports model usage to the gateway, as a final `demo_usage` SSE event for Ask AI and an `X-Demo-Usage` header on the other AI endpoints;
- shows a fixed banner, corner watermarks, and a note on the jobs page that company names are anonymized on purpose.

Every `claude` process starts through `web/lib/claude-cli.ts` with `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands` and `--permission-mode dontAsk`, in an empty working directory, with the prompt on stdin and an allowlisted environment. Ask AI also gets `--mcp-config` for the local read-only `emaildigest-db` server and `--allowedTools` for its three tools, and the runner checks the tool list in the `system/init` event and kills the process if anything else appears.

Start, listening on 127.0.0.1:8602:

```bash
cd web
npm ci && npm run build
EMAILDIGEST_DIR=/srv/emaildigest-demo \
EMAILDIGEST_MODEL_CACHE=/srv/emaildigest-demo/models \
npm run start:demo
```

Populate the embedding model cache once, on a machine with network access and without `DEMO_MODE`:

```bash
cd web
EMAILDIGEST_MODEL_CACHE=/srv/emaildigest-demo/models npx tsx scripts/fetch-embedder-model.ts
```

The SetFit ONNX weights in `web/models/setfit-*/onnx/model.onnx` are not in git and have to be copied to the server. Without them reclassification falls back to the LLM for every message.

## Further reading

`AGENTS.md` and the seven design docs in `docs/design/`: architecture, email pipeline, draft system, frontend, security, database, and Ask AI retrieval.
