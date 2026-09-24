/**
 * Download the MiniLM embedder into EMAILDIGEST_MODEL_CACHE so the app can
 * run with DEMO_MODE=1 (which forbids model downloads at runtime).
 *
 *   EMAILDIGEST_MODEL_CACHE=/srv/emaildigest/models npx tsx scripts/fetch-embedder-model.ts
 *
 * Run it once on a machine with network access, without DEMO_MODE, then copy
 * the directory to the demo host if needed. The script re-loads the model
 * with remote access disabled to prove the cache is complete.
 */
import path from "path";
import fs from "fs";
import { pipeline, env } from "@huggingface/transformers";

const MODEL_ID = process.env.EMAILDIGEST_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
const cache = process.env.EMAILDIGEST_MODEL_CACHE;
if (!cache) {
  console.error("Set EMAILDIGEST_MODEL_CACHE to the target directory.");
  process.exit(1);
}
if (process.env.DEMO_MODE === "1") {
  console.error("Run this without DEMO_MODE; it needs to download once.");
  process.exit(1);
}

(async () => {
  const dir = path.resolve(cache);
  fs.mkdirSync(dir, { recursive: true });
  env.cacheDir = dir;
  env.localModelPath = dir;
  env.allowRemoteModels = true;
  const first = await pipeline("feature-extraction", MODEL_ID);
  await first("warmup", { pooling: "mean", normalize: true });

  env.allowRemoteModels = false;
  const offline = await pipeline("feature-extraction", MODEL_ID);
  const out = await offline("warmup", { pooling: "mean", normalize: true });
  console.log(`OK: ${MODEL_ID} loads from ${dir} without network (dim ${out.dims.at(-1)})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
