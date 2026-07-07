/* Forever Winter Almanac — combined service worker.
   - App shell + every data JSON (attachments, detection, and all map data) are
     precached on install (small, ~1–2 MB total).
   - Map imagery (tiles / marker icons / popup photos, under /assets/img/) is
     large, so it's cached at runtime, cache-first — any map you open keeps
     working offline afterwards.
   - The Maps tab's "Save all maps offline" button posts SAVE_ALL to warm the
     entire image cache up front. */
const VERSION = "fw-almanac-v19";
const SHELL = VERSION + "-shell";
const IMG = VERSION + "-img";

const SHELL_ASSETS = [
  "./", "index.html",
  "app.css", "maps.css", "app.js", "maps.js",
  "manifest.webmanifest",
  "data/attachments.json", "data/detection.json", "data/maps.json", "data/weapons.json", "data/parts.json",
  "data/economy.json", "data/bosses.json", "data/factions.json", "data/ammo.json", "data/loot.json",
  "assets/vendor/leaflet.js", "assets/vendor/leaflet.css",
  "assets/vendor/images/marker-icon.png", "assets/vendor/images/marker-icon-2x.png",
  "assets/vendor/images/marker-shadow.png",
  "assets/vendor/images/layers.png", "assets/vendor/images/layers-2x.png",
  "assets/icons/icon.svg", "assets/icons/favicon.png", "assets/icons/apple-touch-icon.png",
  "assets/icons/icon-192.png", "assets/icons/icon-512.png", "assets/icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: "reload" }))).catch(() => {});
    // every map's JSON, so the map list + per-map data work fully offline
    try {
      const mf = await fetch("data/maps.json").then((r) => r.json());
      await cache.addAll(mf.maps.map((m) => m.file)).catch(() => {});
    } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let wiki article links pass through
  if (url.pathname.includes("/assets/img/")) {
    e.respondWith(cacheFirst(IMG, req));            // heavy map imagery: runtime, cache-first
  } else if (url.pathname.endsWith(".json")) {
    e.respondWith(networkFirst(SHELL, req));         // data: fresh when online, cached offline
  } else {
    e.respondWith(staleWhileRevalidate(SHELL, req)); // shell: instant, updated in background
  }
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return hit || Response.error();
  }
}

async function networkFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req)) || Response.error();
  }
}

async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetcher = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fetcher;
}

/* Warm the entire image cache on request from the Maps tab. */
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SAVE_ALL" && Array.isArray(e.data.urls)) {
    e.waitUntil((async () => {
      const cache = await caches.open(IMG);
      let done = 0;
      for (const u of e.data.urls) {
        try {
          if (!(await cache.match(u))) {
            const res = await fetch(u);
            if (res && res.ok) await cache.put(u, res.clone());
          }
        } catch (_) {}
        done++;
        if (done % 20 === 0 || done === e.data.urls.length) {
          const clients = await self.clients.matchAll();
          clients.forEach((c) => c.postMessage({ type: "SAVE_PROGRESS", done, total: e.data.urls.length }));
        }
      }
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.postMessage({ type: "SAVE_DONE", total: e.data.urls.length }));
    })());
  }
});
