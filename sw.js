const CACHE_NAME = "kk-cache-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// Network-first: this app gets iterated on often, so a deploy should show up
// the moment the phone is next online, not on some later reload. The cache
// only kicks in as a fallback when there's no connection at all.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    // A plain fetch() still honors the browser's ordinary HTTP cache, so a
    // deploy landing within an asset's Cache-Control max-age window could
    // silently keep serving the previous version despite this being
    // "network-first" — no-store forces an actual round-trip every time.
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        if (response.ok) {
          // Keep the worker alive until the cache write lands — respondWith's
          // promise already resolved with `response` by the time this runs,
          // so without waitUntil the browser is free to kill the worker
          // mid-write, silently leaving the offline fallback on a stale asset.
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone())));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || "Kinder Kalender", { body: data.body || "" }),
      updateBadge(data.badge),
    ])
  );
});

// `badge` is only present on the midnight countdown payload — other push
// kinds (e.g. the eve-of-handover reminder) omit it so they don't clobber
// whatever count the countdown last set on the home-screen icon.
function updateBadge(badge) {
  if (badge === undefined || !("setAppBadge" in navigator)) return Promise.resolve();
  return badge > 0 ? navigator.setAppBadge(badge) : navigator.clearAppBadge();
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      const existing = clients.find((client) => client.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow("./");
    })
  );
});
