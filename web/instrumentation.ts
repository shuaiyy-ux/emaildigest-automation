export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { isDemoMode } = await import("./lib/demo");
    // DEMO_MODE (public demo on a static, anonymized mailbox): keep the local
    // boot steps (body cleanup, model warmups, embedding backfill) and skip
    // everything that talks to the outside world or runs a model on a timer:
    // IMAP backfill + IDLE, the SMTP schedule-send worker, the 2h digest
    // regeneration (and the web push it triggers).
    const demo = isDemoMode();
    const { getEmailCount, cleanExistingBodies, getScheduledDraftsDue, markDraftSent, getAttachments, recordDraftSendFailure, markDraftSendFailed } = await import("./lib/db");
    const { stripLLMContamination } = await import("./lib/sanitize");
    const { startPrefetch, startBackfill } = await import("./lib/prefetch");
    const { sendEmail, isSmtpConfigured } = await import("./lib/smtp");
    const { startIdleListener, isImapConfigured } = await import("./lib/imap");
    const { log } = await import("./lib/logger");
    const slog = log.child("startup");
    const sched = log.child("scheduler");
    const dcron = log.child("digest-cron");
    if (demo) slog.info("DEMO_MODE on: IMAP, SMTP, Gmail connector, web push and digest timer are off");

    const cleaned = cleanExistingBodies(stripLLMContamination);
    if (cleaned > 0) slog.info("Cleaned contaminated email bodies", { count: cleaned });

    // Embedder model version check — if the model id changed (e.g. switch from
    // English-only to multilingual), prior embeddings are incompatible. Wipe
    // them; next prefetch re-embeds lazily per email.
    {
      const { getAppState, setAppState } = await import("./lib/db");
      const { MODEL_ID } = await import("./lib/embedder");
      const stored = getAppState("embed_model");
      if (stored !== MODEL_ID && demo) {
        // Static demo DB: there is no prefetch to re-embed, so never wipe.
        slog.warn("Embedder model id differs from the DB's; DEMO_MODE keeps stored embeddings", { stored: stored || "none", current: MODEL_ID });
      } else if (stored !== MODEL_ID) {
        const dbMod = await import("./lib/db");
        const wiped = dbMod.default.prepare("UPDATE emails SET embedding = NULL WHERE embedding IS NOT NULL").run();
        slog.info("Embedder model changed; wiped stale embeddings — will re-embed on next prefetch", { from: stored || "none", to: MODEL_ID, wiped: wiped.changes });
        setAppState("embed_model", MODEL_ID);
      }
    }

    // Ensure Jobs-pipeline work-seed centroid is ready (one-time compute from 10 canonical texts)
    const { ensureWorkSeed } = await import("./lib/work-seed");
    ensureWorkSeed().catch((e) => slog.error("ensureWorkSeed failed", { err: e }));

    // Warm up MiniLM so the first Ask AI / classification query doesn't pay
    // the ~2-3s model-load cost. Fire-and-forget; singleton caches the pipeline.
    (async () => {
      const t0 = Date.now();
      const { embedText } = await import("./lib/embedder");
      try {
        await embedText("warmup");
        slog.info("Embedder warm", { ms: Date.now() - t0 });
      } catch (e) {
        slog.error("Embedder warmup failed", { err: e });
      }
    })();

    // Warm up SetFit work-encoder so prefetch Step 2a's first email doesn't
    // pay the model-load cost (~2-3s). Fire-and-forget; if model files are
    // missing, log a warning and prefetch will silently fall back to legacy
    // raw-MiniLM work-classifier.
    (async () => {
      const { isWorkEmbedderAvailable, embedTextForWork } = await import("./lib/work-embedder");
      if (!isWorkEmbedderAvailable()) {
        slog.warn("SetFit work-classifier model files missing — prefetch will use legacy raw-MiniLM LR fallback");
        return;
      }
      const t0 = Date.now();
      try {
        await embedTextForWork("warmup");
        slog.info("SetFit work-encoder warm", { ms: Date.now() - t0 });
      } catch (e) {
        slog.error("SetFit warmup failed — prefetch will fall back per-email", { err: e });
      }
    })();

    // Warm up SetFit 4-way Inbox classifier (separate model, separate weights).
    // If files missing, prefetch falls straight through to LLM (no centroid
    // fallback as of 2026-05-08, lessons-learned §23).
    //
    // After warmup, kick off classify_embedding backfill — fills the column
    // for pre-ship orphans so future warm-start retrains see the full training
    // set (§24).
    (async () => {
      const { isClassifyEmbedderAvailable, embedTextForClassify } = await import("./lib/classify-embedder");
      if (!isClassifyEmbedderAvailable()) {
        slog.warn("SetFit 4-way classifier model files missing — prefetch Step 2a will skip SetFit; every pending email falls to LLM");
        return;
      }
      const t0 = Date.now();
      try {
        await embedTextForClassify("warmup");
        slog.info("SetFit classify-encoder warm", { ms: Date.now() - t0 });
      } catch (e) {
        slog.error("SetFit classify warmup failed — prefetch will fall back per-email", { err: e });
        return;
      }
      try {
        const { ensureClassifyEmbeddingsBackfilled } = await import("./lib/embed-backfill");
        const r = await ensureClassifyEmbeddingsBackfilled({ batchSize: 50 });
        if (r.encoded > 0 || r.remaining > 0) {
          slog.info("classify embedding backfill ran", { encoded: r.encoded, remainingHint: r.remaining, skippedNoText: r.skippedNoText });
        }
      } catch (e) {
        slog.warn("classify embedding backfill failed", { err: e });
      }
    })();

    // Auth health: NO periodic probe. Reactive detection only —
    // lib/auth-status.ts flagAuthFailureIfMatch is called by every direct-spawn
    // path (subprocess.ts, event-extractor, daily-digest, draft-gen) on
    // non-zero exit. UI red banner surfaces the moment any real LLM call
    // hits auth error. See lib/auth-status.ts for trade-offs.

    // Every claude spawn runs in an empty dedicated directory (lib/claude-cli.ts).
    {
      const { ensureClaudeWorkdir } = await import("./lib/claude-cli");
      try {
        slog.info("Claude working directory ready", { dir: ensureClaudeWorkdir() });
      } catch (e) {
        slog.error("Claude working directory unusable — model calls will fail", { err: e });
      }
    }

    const count = getEmailCount();
    slog.info("Database initialized", { emailCount: count });

    if (demo) {
      // Freeze the recorded pipeline timestamps once, so the /automation
      // replay is unaffected by what visitors click later.
      const { ensurePipelineSnapshot } = await import("./lib/automation");
      try {
        const created = ensurePipelineSnapshot();
        if (created) slog.info("Pipeline snapshot created for /automation replay");
      } catch (e) {
        slog.error("Pipeline snapshot failed", { err: e });
      }

      // Scheduled sends are simulated: at the due time the draft is marked
      // sent with a fake message id. No SMTP, nothing leaves the machine.
      setInterval(() => {
        const due = getScheduledDraftsDue(Math.floor(Date.now() / 1000));
        for (const draft of due) {
          markDraftSent(draft.id, `<demo-scheduled-${draft.id}@example.com>`);
          sched.info("Simulated scheduled send", { draftId: draft.id, user: draft.demo_user, to: draft.to_address, subject: draft.subject });
        }
      }, 60_000);
      return;
    }

    if (count === 0) {
      slog.info("DB empty, starting 1-year backfill");
      startBackfill();
    }

    // Real-time push: IMAP IDLE triggers prefetch on new mail
    if (isImapConfigured()) {
      startIdleListener(() => startPrefetch());
    }

    // Background: check scheduled drafts every minute. Circuit breaker at
    // MAX_SEND_ATTEMPTS — persistent failure (auth, network, rejected
    // recipient) trips status → 'send_failed' so the cron stops hammering
    // and the user sees the error in the UI instead of a silent retry loop.
    const MAX_SEND_ATTEMPTS = 5;
    setInterval(async () => {
      if (!isSmtpConfigured()) return;
      const now = Math.floor(Date.now() / 1000);
      const due = getScheduledDraftsDue(now);
      for (const draft of due) {
        try {
          const attachments = getAttachments(draft.id).map((a) => ({ filename: a.filename, path: a.path }));
          const result = await sendEmail({
            to: draft.to_address, cc: draft.cc, bcc: draft.bcc,
            subject: draft.subject, body: draft.body,
            attachments, includeSignature: true,
          });
          markDraftSent(draft.id, result.messageId);
          sched.info("Sent scheduled draft", { draftId: draft.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          recordDraftSendFailure(draft.id, msg);
          const attempts = (draft.send_attempts ?? 0) + 1;
          if (attempts >= MAX_SEND_ATTEMPTS) {
            markDraftSendFailed(draft.id);
            sched.error("Draft tripped circuit; user must retry manually", { draftId: draft.id, attempts });
          } else {
            sched.warn("Draft send failed", { draftId: draft.id, attempts, max: MAX_SEND_ATTEMPTS, err: msg });
          }
        }
      }
    }, 60_000);

    // Background: auto-regenerate email digest. Stale = (≥ 2h since last
    // gen) AND (new mail arrived since). Push notifications are independently
    // gated to 9/15/21 PT slots inside email-digest.ts, so digest can refresh
    // up to 12x/day without spamming the user. Idle inboxes never regen.
    // The `regenInFlight` lock inside email-digest.ts dedupes with on-demand
    // regens.
    {
      const { ensureEmailDigest, isEmailDigestStale } = await import("./lib/email-digest");
      const tick = () => {
        if (isEmailDigestStale()) {
          try {
            ensureEmailDigest();
            dcron.info("stale → triggered regen");
          } catch (e) {
            dcron.error("tick failed", { err: e });
          }
        }
      };
      tick();                       // catch stale on boot
      setInterval(tick, 60_000);    // every minute: cheap staleness check
    }
  }
}
