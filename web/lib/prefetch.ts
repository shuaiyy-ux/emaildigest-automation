import {
  upsertEmails,
  updateEmailThreadId,
  updateEmailEmbedding,
  listCategories,
  addCategoryExample,
  setMaybeWork,
  listJobThreadIds,
  getMaybeWorkEmails,
} from "./db";
import { fetchRecent } from "./imap";
import { classifyEmailsWithLLM, mapLLMConfidence, type ClassifyResult } from "./llm-classify";
import { buildEmbedText, embedText, embeddingToBlob, blobToEmbedding } from "./embedder";
import { isMaybeWork } from "./work-seed";
import { runJobsPipeline, applyJobsLLMResults, newPipelineStats } from "./jobs-pipeline";
import { inferPrimaryUntil } from "./ttl-rules";
import { parseLLMTimestamp } from "./parse-time";
import { runMergedPrefetchLLM } from "./merged-prefetch-llm";
import {
  isWorkEmbedderAvailable,
  embedTextForWork,
  predictIsWorkFromEmbedding,
  workEmbeddingToBlob,
  WORK_PREDICT_THRESHOLD,
} from "./work-embedder";
import {
  isClassifyEmbedderAvailable,
  embedTextForClassify,
  predictClassifyFromEmbedding,
  classifyEmbeddingToBlob,
} from "./classify-embedder";
import { computeSenderFeatures } from "./sender-features";
import { updateWorkEmbedding, updateClassifyEmbedding } from "./db";
import { log, newTraceId } from "./logger";
import db from "./db";

const plog = log.child("prefetch");

let fetching = false;

// Wall-clock timezone for parsing tz-less LLM timestamps (see parse-time.ts).
// The production server runs in UTC; user is in PT. Override via env if user moves.
const USER_TZ = process.env.EMAILDIGEST_USER_TZ || "America/Los_Angeles";

export function isPrefetching() {
  return fetching;
}

/**
 * One-shot deep pull: last 365 days, up to 2000 emails. Used on first boot
 * (empty DB) and on explicit user request to sweep historical rows — re-upsert
 * triggers `unwrapForwarded` on stored bodies, correcting mis-attributed
 * senders from Outlook auto-forwards.
 */
export async function startBackfill() {
  return startPrefetch({ days: 365, max: 2000 });
}

export async function startPrefetch(opts: { days?: number; max?: number } = {}) {
  if (fetching) return;
  fetching = true;

  // trace_id correlates every log line emitted during this prefetch run.
  // Query: SELECT * FROM logs WHERE trace_id='p_...' ORDER BY ts.
  const traceId = newTraceId("p");
  const lp = plog.trace(traceId);

  try {
    // Step 1: Fetch via IMAP (headers + body) — no LLM overhead
    const days = opts.days ?? 30;
    const max = opts.max ?? 200;
    lp.info("Step 1: Fetching via IMAP", { days, max });
    const t0 = Date.now();
    const emails = await fetchRecent({ label: "UCI-Mail", days, max });

    if (emails.length === 0) {
      lp.info("No emails");
      fetching = false;
      return;
    }

    upsertEmails(emails.map((e) => ({
      id: e.id,
      from: e.from,
      fromEmail: e.fromEmail,
      subject: e.subject,
      snippet: e.snippet,
      body: e.body,
      bodyHtml: e.bodyHtml,
      date: e.date,
      receivedAt: e.receivedAt,
      isUnread: e.isUnread,
      category: "notification",
      listUnsubscribe: e.listUnsubscribe,
      listId: e.listId,
      autoSubmitted: e.autoSubmitted,
      precedence: e.precedence,
    })));
    for (const e of emails) {
      if (e.threadId) updateEmailThreadId(e.id, e.threadId);
    }
    lp.info("Step 1 done", { emails: emails.length, ms: Date.now() - t0 });

    // Step 1.5: self-heal missing embeddings. Runs every prefetch regardless of
    // whether Step 1 found new mail. Covers the case where emails.embedding was
    // wiped (model change / DB migration) but emails already have a category_id,
    // so Step 2a's WHERE category_id IS NULL skips them forever.
    //
    // Only writes emails.embedding — never touches category_id, classifier, or
    // any other classification state. Bounded at 50 per run so the IDLE loop
    // stays responsive; remaining emails heal on subsequent prefetches.
    try {
      const missingEmb = db.prepare(
        `SELECT id, from_name, from_email, subject, snippet
         FROM emails
         WHERE embedding IS NULL AND body != ''
         ORDER BY received_at DESC
         LIMIT 50`
      ).all() as { id: string; from_name: string; from_email: string; subject: string; snippet: string }[];
      if (missingEmb.length > 0) {
        const h0 = Date.now();
        let healed = 0;
        for (const e of missingEmb) {
          try {
            const vec = await embedText(buildEmbedText({
              fromEmail: e.from_email, fromName: e.from_name, subject: e.subject, snippet: e.snippet,
            }));
            updateEmailEmbedding(e.id, embeddingToBlob(vec));
            healed++;
          } catch (err) {
            lp.warn("Step 1.5: embed error", { emailId: e.id, err });
          }
        }
        lp.info("Step 1.5: self-heal done", { healed, total: missingEmb.length, ms: Date.now() - h0 });
      }
    } catch (err) {
      lp.error("Step 1.5: self-heal error", { err });
    }

    // Step 1.6: chunk embeddings for Ask AI retrieval (orthogonal to Step 1.5's
    // single-vector path). Scans emails with body but no rows in email_chunks,
    // splits body into ~400-char chunks, embeds each, and writes atomically.
    // See docs/design/ask-rag.md for why.
    try {
      const { chunkText } = await import("./chunker");
      const { listEmailsNeedingChunks, replaceChunksForEmail } = await import("./db");
      const needsChunking = listEmailsNeedingChunks(30);
      if (needsChunking.length > 0) {
        const c0 = Date.now();
        let chunked = 0, totalChunks = 0;
        for (const e of needsChunking) {
          try {
            const parts = chunkText(e.body || "");
            if (parts.length === 0) continue;
            const rows = [];
            for (let i = 0; i < parts.length; i++) {
              const vec = await embedText(parts[i]);
              rows.push({ chunk_idx: i, chunk_text: parts[i], embedding: embeddingToBlob(vec) });
            }
            replaceChunksForEmail(e.id, rows);
            chunked++;
            totalChunks += rows.length;
          } catch (err) {
            lp.warn("Step 1.6: chunk error", { emailId: e.id, err });
          }
        }
        lp.info("Step 1.6: chunking done", { chunked, total: needsChunking.length, totalChunks, ms: Date.now() - c0 });
      }
    } catch (err) {
      lp.error("Step 1.6: chunking error", { err });
    }

    // Step 2: LLM classification for unclassified rows only.
    // Design principle: one decision per email, never re-classified on refresh.
    //   - classifier='user' or 'llm' → skip (already decided, locked forever)
    //   - category_id IS NULL → needs classification
    // Max 40 per batch to keep LLM prompt focused and parseable.
    const pending = db.prepare(
      `SELECT id, from_name, from_email, subject, snippet, thread_id,
              list_unsubscribe, list_id, auto_submitted, precedence
       FROM emails
       WHERE category_id IS NULL AND (classifier IS NULL OR classifier NOT IN ('user', 'llm'))
         AND id IN (${emails.map(() => "?").join(",")})
       ORDER BY received_at DESC
       LIMIT 40`
    ).all(...emails.map((e) => e.id)) as {
      id: string; from_name: string; from_email: string; subject: string; snippet: string; thread_id: string;
      list_unsubscribe: string; list_id: string; auto_submitted: string; precedence: string;
    }[];

    if (pending.length === 0) {
      lp.info("Step 2: nothing to classify (all rows already decided)");
      lp.info("Done");
      fetching = false;
      return;
    }

    lp.info("Step 2: classifying pending (SetFit-first)", { pending: pending.length });
    const categories = listCategories();
    const nameToId: Record<string, string> = {};
    const idToShort: Record<string, string> = {};
    for (const c of categories) {
      nameToId[c.name.toLowerCase()] = c.id;
      idToShort[c.id] = c.name.toLowerCase();
    }
    const setfitStmt = db.prepare(
      "UPDATE emails SET category_id = ?, category = ?, confidence = ?, primary_until = ?, classifier = 'setfit', classified_at = unixepoch() WHERE id = ? AND (classifier IS NULL OR classifier NOT IN ('user', 'llm'))"
    );
    // confidence is now a parameter (tiered high/medium/low — see mapLLMConfidence)
    // instead of the historical hardcoded 0.9. Medium rows fall inside the
    // needsUserConfirm 0.4-0.7 zone so the UI surfaces an "AI 信心不足" banner.
    const llmStmt = db.prepare(
      "UPDATE emails SET category_id = ?, category = ?, confidence = ?, classifier = 'llm', primary_until = ?, classified_at = unixepoch() WHERE id = ? AND (classifier IS NULL OR classifier NOT IN ('user', 'llm'))"
    );

    // Step 2a: SetFit-first — embed each pending email's classify_embedding,
    // run the LR head, write back if confident; otherwise queue for LLM.
    // The generic-MiniLM centroid fallback was retired 2026-05-08 (lessons-learned §23).
    let setfitHit = 0, setfitUncertain = 0;
    let jobThreadHits = 0;
    const llmQueue: typeof pending = [];
    // L1.5 thread shortcut: pre-load the set of thread_ids already tracked in Jobs.
    // A new email in one of these threads is almost certainly also job-related
    // (Gmail threading is deterministic, near-zero FP), so we bypass the work-
    // classifier gate and force maybe_work=1.
    const jobThreadIds = listJobThreadIds();

    for (const e of pending) {
      try {
        // Get or compute the embedding (cache to emails.embedding)
        const cachedRow = db.prepare("SELECT embedding FROM emails WHERE id = ?").get(e.id) as { embedding: Buffer | null } | undefined;
        let vec: Float32Array;
        if (cachedRow?.embedding) {
          try { vec = blobToEmbedding(cachedRow.embedding); }
          catch {
            const text = buildEmbedText({
              fromEmail: e.from_email, fromName: e.from_name, subject: e.subject, snippet: e.snippet,
            });
            vec = await embedText(text);
            updateEmailEmbedding(e.id, embeddingToBlob(vec));
          }
        } else {
          const text = buildEmbedText({
            fromEmail: e.from_email, fromName: e.from_name, subject: e.subject, snippet: e.snippet,
          });
          vec = await embedText(text);
          updateEmailEmbedding(e.id, embeddingToBlob(vec));
        }

        // Ingress tap for Jobs pipeline — tag maybe_work regardless of Inbox verdict.
        // One-way: Inbox never reads this flag; Jobs pipeline drains it in Step 3.
        //
        // Decision sources, in order of precedence:
        //   L1.5  thread_id ∈ existing job_emails → force maybe_work=1 (catches
        //         follow-up replies even when content scores low)
        //   L2    SetFit task-tuned classifier (if model files present):
        //         encode → predictIsWorkFromEmbedding → P ≥ WORK_PREDICT_THRESHOLD
        //   L2'   Legacy raw-MiniLM LR (isMaybeWork) when SetFit unavailable —
        //         silent fallback so prefetch keeps working in case the ONNX
        //         file is missing on a fresh deploy.
        //
        // SetFit body is fine-tuned offline (training/setfit-work/train.py);
        // the head can be runtime-retrained via lib/setfit-head.ts when the
        // user right-clicks "Classify as Job".
        try {
          const inJobThread = !!e.thread_id && jobThreadIds.has(e.thread_id);
          if (inJobThread) jobThreadHits++;

          let workFlag = false;
          if (isWorkEmbedderAvailable()) {
            const text = (e.subject || "").slice(0, 200) + "\n" + (e.snippet || "").slice(0, 1500);
            try {
              const workEmb = await embedTextForWork(text);
              updateWorkEmbedding(e.id, workEmbeddingToBlob(workEmb));
              const p = predictIsWorkFromEmbedding(workEmb);
              if (p !== null) workFlag = p >= WORK_PREDICT_THRESHOLD;
            } catch (err) {
              lp.warn("Step 2a SetFit predict error, falling back", { emailId: e.id, err });
              workFlag = isMaybeWork(vec);
            }
          } else {
            workFlag = isMaybeWork(vec);
          }

          setMaybeWork(e.id, inJobThread || workFlag);
        } catch {}

        // Primary path: SetFit 4-way classifier (task-tuned MiniLM body + LR head).
        // Held-out eval shows ~97% pass rate at top1 ≥ 0.80 — so most arrivals
        // never need LLM. If the model files are missing (fresh deploy before
        // scp), every row falls to LLM rather than going through a degraded
        // generic-MiniLM centroid (retired 2026-05-08).
        let confidentCategoryId: string | null = null;
        let confidentScore = 0;
        if (isClassifyEmbedderAvailable()) {
          try {
            const text = (e.subject || "").slice(0, 200) + "\n" + (e.snippet || "").slice(0, 1500);
            const cEmb = await embedTextForClassify(text);
            updateClassifyEmbedding(e.id, classifyEmbeddingToBlob(cEmb));
            // Compute sender behavioral + header features for 394-d head input.
            // A legacy 384-d head ignores these (predict path handles dim mismatch).
            const senderFeatures = computeSenderFeatures({
              fromEmail: e.from_email,
              excludeEmailId: e.id,
              listUnsubscribe: e.list_unsubscribe,
              listId: e.list_id,
              autoSubmitted: e.auto_submitted,
              precedence: e.precedence,
            });
            const pred = predictClassifyFromEmbedding(cEmb, senderFeatures);
            if (pred && pred.confident) {
              confidentCategoryId = pred.label;
              confidentScore = pred.top1;
            }
          } catch (err) {
            lp.warn("Step 2a SetFit classify error, falling through to LLM", { emailId: e.id, err });
          }
        }

        if (confidentCategoryId) {
          const shortName = idToShort[confidentCategoryId] || "notification";
          // Deterministic TTL extraction — runs regardless of classifier path
          // so confident hits don't lose time-sensitivity detection.
          const row = db.prepare("SELECT body, received_at FROM emails WHERE id = ?").get(e.id) as { body: string; received_at: number } | undefined;
          const primaryUntil = row
            ? inferPrimaryUntil({ subject: e.subject, body: row.body || e.snippet || "", receivedAt: row.received_at })
            : null;
          setfitStmt.run(confidentCategoryId, shortName, confidentScore, primaryUntil, e.id);
          setfitHit++;
        } else {
          setfitUncertain++;
          llmQueue.push(e);
        }
      } catch (err) {
        lp.warn("Step 2a: classifier error", { emailId: e.id, err });
        llmQueue.push(e); // fail open — let LLM handle it
      }
    }

    lp.info("Step 2a: classify done", { confident: setfitHit, uncertain: setfitUncertain, jobThreadHits });

    // Steps 2b + 3: merged LLM call.
    //
    // Each step independently asks Sonnet for a strict-JSON output. They're
    // batched into one prompt that returns {classifications, jobs} — saves
    // spawn count in the typical "new mail → both tasks fire" case (see
    // docs/design/prefetch-llm-merge.md). When merged can't run (prompt >
    // MAX_PROMPT_BYTES, breaker open, parse failure), we fall back to the
    // original per-step spawns.
    //
    // (Briefings was the third task but was retired 2026-05-02 — its
    // stale-trigger fired on every new email arrival, dominating spawn
    // count. UX consolidated into the single email-digest at dashboard top.)

    const jobsBatchAll = getMaybeWorkEmails();
    const jobsBatch = jobsBatchAll.slice(0, 30); // matches old drainMaybeWorkQueue cap

    // Helper: apply classify results to DB + bootstrap SetFit training samples.
    // Reused by merged-success and fallback paths.
    const applyClassifyResults = (results: ClassifyResult[]) => {
      const embStmt = db.prepare("SELECT embedding FROM emails WHERE id = ?");
      const queueById = new Map(llmQueue.map((q) => [q.id, q]));
      let applied = 0, unknown = 0, bootstrapped = 0;
      const tierCounts = { high: 0, medium: 0, low: 0 };
      for (const r of results) {
        const raw = (r.category || "").toLowerCase();
        const categoryId = nameToId[raw];
        if (!categoryId) {
          lp.warn("LLM returned unknown category — leaving NULL", { emailId: r.id, category: r.category });
          unknown++;
          continue;
        }
        const conf = mapLLMConfidence(r.confidence);
        tierCounts[conf.tier]++;
        let primaryUntilSec: number | null = null;
        if (r.primary_until && categoryId !== "cat_news") {
          const ts = parseLLMTimestamp(r.primary_until, USER_TZ);
          if (ts !== null && ts > Math.floor(Date.now() / 1000)) {
            primaryUntilSec = ts;
          }
        }
        if (primaryUntilSec === null && categoryId !== "cat_news") {
          const row = db.prepare("SELECT body, received_at FROM emails WHERE id = ?").get(r.id) as { body: string; received_at: number } | undefined;
          const src = queueById.get(r.id);
          if (row && src) {
            primaryUntilSec = inferPrimaryUntil({
              subject: src.subject,
              body: row.body || src.snippet || "",
              receivedAt: row.received_at,
            });
          }
        }
        llmStmt.run(categoryId, raw, conf.numeric, primaryUntilSec, r.id);
        applied++;

        // Only回灌 trainable tiers (high/medium). Low-conf rows are LLM
        // guesses — useful for routing the user's inbox but not for teaching
        // the SetFit head.
        if (conf.trainable) {
          const emb = embStmt.get(r.id) as { embedding: Buffer | null } | undefined;
          if (emb?.embedding) {
            addCategoryExample({
              categoryId,
              emailId: r.id,
              source: conf.source,
              embedding: emb.embedding,
              subjectPreview: (queueById.get(r.id)?.subject || "").slice(0, 120),
            });
            bootstrapped++;
          }
        }
      }
      lp.info("classify applied", { applied, bootstrapped, unknown, missed: llmQueue.length - applied - unknown, tiers: tierCounts });
    };

    // Try merged path first
    let mergedHandledClassify = false, mergedHandledJobs = false;
    try {
      const merged = await runMergedPrefetchLLM({
        classifyEmails: llmQueue,
        classifyCategories: categories,
        jobsEmails: jobsBatch,
      });

      if (merged.spawned && !merged.fellBack) {
        lp.info("merged LLM", { ms: merged.elapsedMs, promptBytes: merged.promptBytes, classifications: merged.classifications.length, jobs: merged.jobs.length });

        if (merged.classifications.length > 0 && llmQueue.length > 0) {
          try { applyClassifyResults(merged.classifications); mergedHandledClassify = true; }
          catch (e) { lp.warn("classify apply error", { err: e }); }
        } else if (llmQueue.length === 0) {
          mergedHandledClassify = true; // nothing to do
        }

        if (merged.jobs.length > 0 && jobsBatch.length > 0) {
          try {
            const stats = newPipelineStats(jobsBatch.length);
            applyJobsLLMResults(merged.jobs, jobsBatch, stats);
            lp.info("jobs (merged)", {
              candidates: stats.candidates,
              isJob: stats.isJobTrue,
              skipped: stats.isJobFalse,
              matchedByThread: stats.matchedByThread,
              matchedByDomain: stats.matchedByDomain,
              matchedByFuzzy: stats.matchedByFuzzy,
              createdNew: stats.createdNew,
            });
            mergedHandledJobs = true;
          } catch (e) { lp.warn("jobs apply error", { err: e }); }
        } else if (jobsBatch.length === 0) {
          mergedHandledJobs = true;
        }
      } else if (merged.fellBack) {
        lp.warn("merged fell back, using individual spawns", { promptBytes: merged.promptBytes });
      } else if (!merged.spawned && (llmQueue.length || jobsBatch.length)) {
        lp.warn("merged spawn failed; falling back to individual spawns");
      }
    } catch (e) {
      lp.error("merged LLM error", { err: e });
    }

    // Per-task fallback for anything merged didn't handle
    if (!mergedHandledClassify && llmQueue.length > 0) {
      try {
        const results = await classifyEmailsWithLLM(llmQueue, categories);
        applyClassifyResults(results);
      } catch (e) {
        lp.error("Step 2b (fallback) error", { err: e });
      }
    }

    if (!mergedHandledJobs && jobsBatch.length > 0) {
      try {
        const stats = await runJobsPipeline(jobsBatch);
        lp.info("Step 3 (jobs, fallback)", {
          candidates: stats.candidates,
          isJob: stats.isJobTrue,
          skipped: stats.isJobFalse,
          matchedByThread: stats.matchedByThread,
          matchedByDomain: stats.matchedByDomain,
          matchedByFuzzy: stats.matchedByFuzzy,
          createdNew: stats.createdNew,
        });
      } catch (e) {
        lp.error("Step 3 (jobs, fallback) error", { err: e });
      }
    }

    // Step 5 (calendar event extraction) is now manual-only via the
    // /calendar "Scan inbox" button. The auto-extract path was removed
    // because every prefetch fired a per-email Haiku spawn — the dominant
    // contributor to daily spawn count after the 2026-04 Anthropic ban
    // incident. See /api/events action=scanInbox + extractEventsForBatch.

    lp.info("Done");
  } catch (e) {
    lp.error("Error", { err: e });
  }

  fetching = false;
}
