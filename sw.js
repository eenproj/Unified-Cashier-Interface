/* APOTEK SMART POS PWA Service Worker v1
 * Cache only static shell assets. Never cache authenticated API responses,
 * tokens, transaction writes, or tenant-specific data.
 */
const CACHE_PREFIX = "apotek-smart-pos-shell-";
const CACHE_VERSION = "v1.0.0";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./offline.html",
  "./pwa-runtime.js",
  "./pwa-config.js",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // App shell: cache-first. Do not intercept external Apps Script/API traffic.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put("./index.html", fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (_) {
        return (await caches.match(req)) || (await caches.match("./index.html")) ||
          (await caches.match("./offline.html"));
      }
    })());
    return;
  }

  if (url.pathname.includes("/api/") || url.searchParams.has("token")) return;
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (_) {
      return cached || Response.error();
    }
  })());
});
