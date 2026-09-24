// EmailDigest Service Worker
// Three jobs: (1) precache & SWR static shell, (2) Web Push handler with
// foreground suppression, (3) notification click → focus or open window.
//
// Bumping SHELL_CACHE invalidates old shell entries on next activate.

const SHELL_CACHE = "ed-shell-v1";
const SHELL_URLS = ["/", "/manifest.json", "/icon-192.png", "/apple-touch-icon.png"];

/* ── install / activate ─────────────────────────────────── */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── fetch: SWR for static, network for everything else ─── */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API and Next data routes need fresh data — leave to network.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/data/")) return;

  // Only SWR for static assets the browser identifies as such.
  const dest = req.destination;
  const isStatic = ["script", "style", "image", "font"].includes(dest)
    || url.pathname === "/"
    || url.pathname === "/manifest.json"
    || url.pathname.startsWith("/icon-")
    || url.pathname === "/apple-touch-icon.png";
  if (!isStatic) return;

  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      // Only cache successful, basic-type responses (skip opaque).
      if (res && res.ok && res.type === "basic") {
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

/* ── push handler ───────────────────────────────────────── */

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { /* keep default */ }

  // Foreground suppression: if the user already has the PWA visible, don't
  // pop a banner. Decision lives on-device — no server-side heartbeat needed.
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const isForeground = clients.some((c) => c.visibilityState === "visible");
  if (isForeground) return;

  const title = payload.title || "EmailDigest";
  const body = payload.body || "";
  const tag = payload.tag || "ed-default";
  const url = payload.url || "/";

  await self.registration.showNotification(title, {
    body,
    tag,                                  // collapse same-tag updates
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url },
    requireInteraction: false,
  });
}

/* ── notification click ─────────────────────────────────── */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (existing) {
      existing.focus().catch(() => {});
      if ("navigate" in existing) existing.navigate(target).catch(() => {});
      return;
    }
    await self.clients.openWindow(target);
  })());
});
