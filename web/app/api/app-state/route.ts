import { getAppState, setAppState } from "@/lib/db";
import { getDemoUser } from "@/lib/demo";
import { getProfileName, setProfileName } from "@/lib/profile";

// Keys writable via this public HTTP API. Server-only keys (embed_model,
// work_classifier_*, work_seed_centroid, claude_auth_*) are set by
// instrumentation/prefetch and MUST NOT appear here.
const ALLOWED_KEYS = new Set(["user_profile_name"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  if (!key || !ALLOWED_KEYS.has(key)) {
    return Response.json({ error: "Key required or not allowed" }, { status: 400 });
  }
  if (key === "user_profile_name") {
    return Response.json({ key, value: getProfileName(getDemoUser(request)) });
  }
  return Response.json({ key, value: getAppState(key) });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const key = body.key as string | undefined;
  const value = body.value as string | undefined;
  if (!key || !ALLOWED_KEYS.has(key) || typeof value !== "string") {
    return Response.json({ error: "Key and string value required" }, { status: 400 });
  }
  if (key === "user_profile_name") {
    setProfileName(getDemoUser(request), value.slice(0, 100));
    return Response.json({ ok: true });
  }
  setAppState(key, value);
  return Response.json({ ok: true });
}
