/* Service Worker امضاگیر
 * سیاست امنیتی: هیچ صفحه‌ی احرازهویت‌شده، API یا پاسخ شخصی هرگز کش نمی‌شود.
 * فقط فایل‌های ایستا (JS/CSS/فونت/آیکون) و صفحه‌ی آفلاین کش می‌شوند. */
const VERSION = "emz-v1";
const PRECACHE = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

const isStatic = (url) => url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || /\.(?:woff2?|ttf|css|js)$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || net;
      }),
    );
  }
});
