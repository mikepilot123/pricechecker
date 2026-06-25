/* Service worker.
   Strategy: NETWORK-FIRST for the app's own files (HTML/CSS/JS) so a new
   deploy shows up automatically the next time the device is online — no
   manual hard-refresh needed. The cache is only a fallback for when the
   network is unavailable, so the app still opens offline.

   Google Sheet requests are never touched here — prices/intake always go
   straight to the network (with their own localStorage fallback in app.js). */
const CACHE = "rpc-shell-v12";
const SHELL = [
  "./",
  "./index.html",
  "./assets/style.css",
  "./assets/app.js",
  "./assets/intake.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle our own GET requests; let everything else (Google Sheet,
  // fonts, POSTs to Apps Script, etc.) go straight to the network.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first: try the live file, cache a fresh copy, and only fall
  // back to the cached copy if the network is unreachable.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
