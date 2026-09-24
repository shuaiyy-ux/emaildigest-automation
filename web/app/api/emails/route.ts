import { getAllEmails, updateCategories, markCategoriesAsRead, markCategoryIdsAsRead, setEmailRead, insertCorrection, addEvalLabel, removeEvalLabel, listEvalSet, listCategories, updateEmailEmbedding, updateClassifyEmbedding, removeEmailExampleFromCategory, addCategoryExample, getAppState, setAppState, type EmailRow } from "@/lib/db";
import db from "@/lib/db";
import { isPrefetching, startPrefetch, startBackfill } from "@/lib/prefetch";
import { classifyEmailsWithLLM, mapLLMConfidence } from "@/lib/llm-classify";
import { buildEmbedText, embedText, embeddingToBlob, blobToEmbedding } from "@/lib/embedder";
import {
  isClassifyEmbedderAvailable,
  embedTextForClassify,
  predictClassifyFromEmbedding,
  classifyEmbeddingToBlob,
} from "@/lib/classify-embedder";
import { computeSenderFeatures } from "@/lib/sender-features";
import { trainSetfitClassifyHead } from "@/lib/setfit-classify-head";
import { formatTtlHint, inferPrimaryUntil } from "@/lib/ttl-rules";
import { log } from "@/lib/logger";
import { isDemoMode } from "@/lib/demo";
import { collectUsage, withUsageHeader } from "@/lib/demo-usage";

// Dedup guard for warm-start retrain. Without this, two user corrections
// within ~150ms can both load the current head, train independently, and
// last-write-wins — losing one correction's gradient updates. Mirrors
// `setfitRetrainInFlight` in /api/jobs/route.ts.
let classifyRetrainInFlight = false;

// Reclassify is a 30-90s synchronous LLM call (40 emails per batch). Anchor
// the in-flight state so a second click — same tab F5 or a sibling tab —
// gets a 409 instead of firing a parallel spawn that double-bills the user.
// Same shape as event_scan_started_at; see docs/design/state-boundary.md.
const RECLASSIFY_FRESHNESS_SEC = 100;
function readReclassifyStatus(): { isRunning: boolean; startedAt: number | null } {
  const raw = getAppState("reclassify_started_at");
  const startedAt = raw ? Number(raw) : 0;
  if (!startedAt) return { isRunning: false, startedAt: null };
  const ageSec = Math.floor(Date.now() / 1000) - startedAt;
  if (ageSec > RECLASSIFY_FRESHNESS_SEC) {
    setAppState("reclassify_started_at", "");
    return { isRunning: false, startedAt: null };
  }
  return { isRunning: true, startedAt };
}

function toResponse(r: EmailRow, nowSec: number) {
  const primaryUntilActive = r.primary_until != null && r.primary_until > nowSec;
  const isPriority =
    r.category_id !== "cat_junk" &&
    (r.category_id === "cat_primary" || primaryUntilActive);
  return {
    id: r.id, from: r.from_name, fromEmail: r.from_email,
    subject: r.subject, snippet: r.snippet, body: r.body, bodyHtml: r.body_html,
    date: r.date, receivedAt: r.received_at, category: r.category, categoryId: r.category_id,
    confidence: r.confidence, classifier: r.classifier,
    threadId: r.thread_id,
    isUnread: r.is_unread === 1,
    primaryUntil: r.primary_until,
    ttlHint: formatTtlHint(r.primary_until, nowSec),
    isPriority,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("reclassifyStatus") === "1") {
      // F5-recovery probe — symmetric with /api/events?scanStatus=1.
      return Response.json(readReclassifyStatus());
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const emails = getAllEmails().map((r) => toResponse(r, nowSec));
    const claudeAuth = {
      status: getAppState("claude_auth_status") || "unknown",
      error: getAppState("claude_auth_error") || null,
      checkedAt: Number(getAppState("claude_auth_checked_at") || 0),
    };
    const imapHealth = isDemoMode()
      ? { status: "disabled", error: null, checkedAt: 0 }
      : {
          status: getAppState("imap_status") || "unknown",
          error: getAppState("imap_error") || null,
          checkedAt: Number(getAppState("imap_checked_at") || 0),
        };
    return Response.json({ emails, fetching: isPrefetching(), count: emails.length, claudeAuth, imapHealth });
  } catch (e) {
    console.error("[emails GET] error:", e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  // DEMO_MODE: static mailbox. The client's 60s refresh gets an answer
  // without touching IMAP (and without the prefetch's model calls).
  if (body.action === "refresh") {
    if (isDemoMode()) return Response.json({ status: "static" });
    startPrefetch();
    return Response.json({ status: "started" });
  }

  if (body.action === "backfill") {
    if (isDemoMode()) return Response.json({ status: "static", mode: "backfill" });
    startBackfill();
    return Response.json({ status: "started", mode: "backfill" });
  }

  if (body.action === "markUnimportantRead") {
    // 4-bucket: News (broadcast) + Junk (marketing) are the low-priority buckets.
    const categories = ["news", "junk"];
    const count = markCategoriesAsRead(categories);
    return Response.json({ marked: count });
  }

  if (body.action === "markCategoriesRead") {
    // Prefer categoryIds (authoritative); fall back to legacy short-name array.
    const ids = Array.isArray(body.categoryIds) ? (body.categoryIds as string[]) : null;
    if (ids && ids.length > 0) {
      const count = markCategoryIdsAsRead(ids);
      return Response.json({ marked: count });
    }
    if (Array.isArray(body.categories)) {
      const count = markCategoriesAsRead(body.categories as string[]);
      return Response.json({ marked: count });
    }
    return Response.json({ error: "categoryIds or categories required" }, { status: 400 });
  }

  if (body.action === "setRead" && body.id != null && body.isUnread != null) {
    setEmailRead(body.id as string, body.isUnread as boolean);
    return Response.json({ updated: true });
  }

  if (body.action === "setCategory" && body.ids && body.category) {
    const ids = body.ids as string[];
    const shortName = (body.category as string).toLowerCase();
    // Resolve short → category_id
    const cats = listCategories();
    const cat = cats.find((c) => c.name.toLowerCase() === shortName);

    // Capture OLD category_id for each email BEFORE we update — needed to
    // pull the email out of the old category's examples so the SetFit head
    // warm-start retrain (below) doesn't keep training on the wrong label.
    const oldCategoryById = new Map<string, string | null>();
    if (ids.length > 0) {
      const oldRows = db.prepare(
        `SELECT id, category_id FROM emails WHERE id IN (${ids.map(() => "?").join(",")})`
      ).all(...ids) as Array<{ id: string; category_id: string | null }>;
      for (const r of oldRows) oldCategoryById.set(r.id, r.category_id);
    }

    // Phase 1 (async, outside txn): resolve each email's embedding. Vectors
    // cannot be computed inside a sync SQLite transaction. Writing the
    // embedding cache alone is idempotent — if the later txn rolls back, we
    // just warmed the cache, which is harmless.
    interface Prepared { id: string; subject: string; buf: Buffer; oldCatId: string | null }
    const prepared: Prepared[] = [];
    if (cat) {
      for (const id of ids) {
        const e = db.prepare(
          "SELECT id, from_name, from_email, subject, snippet, body, embedding FROM emails WHERE id = ?"
        ).get(id) as EmailRow | undefined;
        if (!e) continue;
        let buf = e.embedding as Buffer | null;
        let vec: Float32Array | null = null;
        if (buf) { try { vec = blobToEmbedding(buf); } catch { vec = null; } }
        if (!vec) {
          const text = buildEmbedText({
            fromEmail: e.from_email, fromName: e.from_name, subject: e.subject,
            snippet: e.snippet, body: e.body,
          });
          vec = await embedText(text);
          buf = embeddingToBlob(vec);
          updateEmailEmbedding(id, buf);
        }
        prepared.push({ id, subject: e.subject, buf: buf!, oldCatId: oldCategoryById.get(id) ?? null });
      }
    }

    // Phase 2 (sync, inside txn): all category-table mutations commit together
    // or roll back together. Prevents the "email disappears from both old and
    // new category" failure mode when a mid-chain step throws.
    if (cat) {
      const idStmt = db.prepare("UPDATE emails SET category_id = ? WHERE id = ?");
      const applyCategoryChange = db.transaction(() => {
        updateCategories(ids, shortName, "user");
        for (const p of prepared) {
          idStmt.run(cat.id, p.id);
          if (p.oldCatId && p.oldCatId !== cat.id) {
            removeEmailExampleFromCategory(p.oldCatId, p.id);
          }
          addCategoryExample({
            categoryId: cat.id,
            emailId: p.id,
            embedding: p.buf,
            source: "user_correction",
            subjectPreview: p.subject.slice(0, 60),
          });
        }
      });
      applyCategoryChange();

      // SetFit classify-head warm-start retrain — sole online learning path
      // post-2026-05-08 (the legacy MiniLM centroid was retired). Two-step:
      //   1. Cache classify_embedding for any corrected email that doesn't
      //      have one yet (encoder-side write, NOT inside the txn — async).
      //      Without this, getLabeledClassifySamples would skip the email
      //      and the retrain wouldn't see the new label.
      //   2. queueMicrotask the warm-start retrain. Fire-and-forget — failure
      //      doesn't block setCategory's response.
      // Cheap: encode is ~22ms × N corrected emails; retrain ~150ms one-shot.
      if (isClassifyEmbedderAvailable()) {
        // Step 1: cache embeddings (await — must complete before retrain reads
        // them; running both in queueMicrotask risked a race where retrain
        // reads stale samples).
        for (const p of prepared) {
          const cached = db.prepare("SELECT classify_embedding FROM emails WHERE id = ?")
            .get(p.id) as { classify_embedding: Buffer | null } | undefined;
          if (cached?.classify_embedding) continue;
          try {
            const e = db.prepare("SELECT subject, snippet FROM emails WHERE id = ?")
              .get(p.id) as { subject: string; snippet: string } | undefined;
            if (!e) continue;
            const text = (e.subject || "").slice(0, 200) + "\n" + (e.snippet || "").slice(0, 1500);
            const cEmb = await embedTextForClassify(text);
            updateClassifyEmbedding(p.id, classifyEmbeddingToBlob(cEmb));
          } catch (err) {
            console.warn("[setCategory] classify_embedding cache failed:", err);
          }
        }
        // Step 2: kick off retrain (deduped, non-blocking)
        queueMicrotask(() => {
          if (classifyRetrainInFlight) return;
          classifyRetrainInFlight = true;
          try {
            trainSetfitClassifyHead({ warmStart: true });
          } catch (e) {
            console.warn("[setCategory] setfit-classify-head retrain failed:", e);
          } finally {
            classifyRetrainInFlight = false;
          }
        });
      }
    } else {
      // No matching dynamic category — just update the legacy short-name path
      // so existing UI filters still reflect the user action.
      updateCategories(ids, shortName, "user");
    }
    return Response.json({ updated: ids.length });
  }

  if (body.action === "recordCorrection" && body.emailId && body.oldCategory && body.newCategory) {
    insertCorrection(
      body.emailId as string,
      (body.fromEmail as string) || "",
      (body.subject as string) || "",
      body.oldCategory as string,
      body.newCategory as string,
    );
    return Response.json({ recorded: true });
  }

  if (body.action === "addEvalLabel" && body.emailId && body.goldCategoryId) {
    addEvalLabel(body.emailId as string, body.goldCategoryId as string);
    return Response.json({ labeled: true });
  }

  if (body.action === "removeEvalLabel" && body.emailId) {
    removeEvalLabel(body.emailId as string);
    return Response.json({ removed: true });
  }

  if (body.action === "listEvalSet") {
    return Response.json({ evalSet: listEvalSet() });
  }

  if (body.action === "reclassifyUnclassified") {
    const { result, usage } = await collectUsage(() => reclassifyUnclassified(request));
    return withUsageHeader(result, usage);
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

async function reclassifyUnclassified(request: Request): Promise<Response> {
  {
    // Reject if a fresh reclassify is already running. Without this, a
    // second click would burn a parallel ~60s LLM spawn.
    const status = readReclassifyStatus();
    if (status.isRunning) {
      return Response.json(
        { error: "reclassify_in_progress", startedAt: status.startedAt },
        { status: 409 },
      );
    }

    const pending = db.prepare(
      `SELECT id, from_name, from_email, subject, snippet,
              list_unsubscribe, list_id, auto_submitted, precedence
       FROM emails
       WHERE category_id IS NULL AND (classifier IS NULL OR classifier NOT IN ('user', 'llm'))
       ORDER BY received_at DESC
       LIMIT 40`
    ).all() as { id: string; from_name: string; from_email: string; subject: string; snippet: string;
                 list_unsubscribe: string; list_id: string; auto_submitted: string; precedence: string }[];

    if (pending.length === 0) {
      return Response.json({ classified: 0, message: "No unclassified emails" });
    }

    const cats = listCategories();
    const nameToId: Record<string, string> = {};
    const idToShort: Record<string, string> = {};
    for (const c of cats) {
      nameToId[c.name.toLowerCase()] = c.id;
      idToShort[c.id] = c.name.toLowerCase();
    }

    // Mirror prefetch.ts Step 2a: SetFit task-tuned 4-way head decides first.
    // Only rows below the 0.80 confidence threshold fall through to LLM.
    // Pre-2026-05-08 this path skipped SetFit entirely and burnt LLM tokens
    // on every straggler (see lessons-learned §23).
    const setfitStmt = db.prepare(
      "UPDATE emails SET category_id = ?, category = ?, confidence = ?, primary_until = ?, classifier = 'setfit', classified_at = unixepoch() WHERE id = ? AND (classifier IS NULL OR classifier NOT IN ('user', 'llm'))"
    );
    // confidence is parameterized (tiered — see mapLLMConfidence) instead of
    // the historical hardcoded 0.9. Mirrors prefetch.ts Step 2b.
    const llmStmt = db.prepare(
      "UPDATE emails SET category_id = ?, category = ?, confidence = ?, classifier = 'llm', primary_until = ?, classified_at = unixepoch() WHERE id = ? AND (classifier IS NULL OR classifier NOT IN ('user', 'llm'))"
    );

    const setfitDecided: Array<{ id: string; categoryId: string; shortName: string; top1: number; primaryUntil: number | null }> = [];
    const llmQueue: typeof pending = [];

    setAppState("reclassify_started_at", String(Math.floor(Date.now() / 1000)));
    const startedAt = Date.now();
    try {
      if (isClassifyEmbedderAvailable()) {
        for (const e of pending) {
          try {
            const text = (e.subject || "").slice(0, 200) + "\n" + (e.snippet || "").slice(0, 1500);
            const cEmb = await embedTextForClassify(text);
            updateClassifyEmbedding(e.id, classifyEmbeddingToBlob(cEmb));
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
              const shortName = idToShort[pred.label] || "notification";
              const row = db.prepare("SELECT body, received_at FROM emails WHERE id = ?")
                .get(e.id) as { body: string; received_at: number } | undefined;
              const primaryUntil = row
                ? inferPrimaryUntil({ subject: e.subject, body: row.body || e.snippet || "", receivedAt: row.received_at })
                : null;
              setfitDecided.push({ id: e.id, categoryId: pred.label, shortName, top1: pred.top1, primaryUntil });
              continue;
            }
          } catch (err) {
            log.warn("reclassify", "SetFit predict error, falling back to LLM", { emailId: e.id, err: String(err) });
          }
          llmQueue.push(e);
        }
      } else {
        // SetFit files missing — every row falls to LLM. Logged so a fresh
        // deploy without scp shows up in metrics instead of silently regressing.
        log.warn("reclassify", "SetFit embedder unavailable — entire batch falls to LLM", { pending: pending.length });
        llmQueue.push(...pending);
      }

      // Apply SetFit decisions (cheap, sync). Done before the LLM call so a
      // mid-flight cancel still persists the rows we already judged.
      for (const d of setfitDecided) {
        setfitStmt.run(d.categoryId, d.shortName, d.top1, d.primaryUntil, d.id);
      }

      let llmApplied = 0, unknown = 0;
      const tierCounts = { high: 0, medium: 0, low: 0 };
      if (llmQueue.length > 0) {
        // request.signal propagates to the spawn so closing the tab kills the
        // child process instead of letting it run to completion on tokens
        // nobody will read.
        const results = await classifyEmailsWithLLM(llmQueue, cats, { signal: request.signal });
        for (const r of results) {
          const raw = (r.category || "").toLowerCase();
          const categoryId = nameToId[raw];
          if (!categoryId) { unknown++; continue; }
          const conf = mapLLMConfidence(r.confidence);
          tierCounts[conf.tier]++;
          let primaryUntilSec: number | null = null;
          if (r.primary_until && categoryId !== "cat_news") {
            const ts = Math.floor(new Date(r.primary_until).getTime() / 1000);
            if (Number.isFinite(ts) && ts > Math.floor(Date.now() / 1000)) primaryUntilSec = ts;
          }
          if (primaryUntilSec === null && categoryId !== "cat_news") {
            const src = llmQueue.find((q) => q.id === r.id);
            const row = db.prepare("SELECT body, received_at FROM emails WHERE id = ?").get(r.id) as { body: string; received_at: number } | undefined;
            if (row && src) {
              primaryUntilSec = inferPrimaryUntil({ subject: src.subject, body: row.body || src.snippet || "", receivedAt: row.received_at });
            }
          }
          llmStmt.run(categoryId, raw, conf.numeric, primaryUntilSec, r.id);
          llmApplied++;
        }
      }

      log.info("reclassify", "done", {
        attempted: pending.length,
        setfit: setfitDecided.length,
        llm: llmApplied,
        tiers: tierCounts,
        unknown,
        ms: Date.now() - startedAt,
      });
      return Response.json({
        classified: setfitDecided.length + llmApplied,
        setfit: setfitDecided.length,
        llm: llmApplied,
        unknown,
        attempted: pending.length,
      });
    } catch (e) {
      log.error("reclassify", "failed", { err: String(e), attempted: pending.length, setfit: setfitDecided.length });
      return Response.json({ error: String(e), attempted: pending.length, setfit: setfitDecided.length }, { status: 500 });
    } finally {
      setAppState("reclassify_started_at", "");
    }
  }
}
