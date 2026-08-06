/* Service worker.
   Strategy: NETWORK-FIRST for the app's own files (HTML/CSS/JS) so a new
   deploy shows up automatically the next time the device is online — no
   manual hard-refresh needed. The cache is only a fallback for when the
   network is unavailable, so the app still opens offline.

   Google Sheet requests are never touched here — prices/intake always go
   straight to the network (with their own localStorage fallback in app.js). */
const CACHE = "rpc-shell-v60";
// Keep this list in sync with the <script>/<link> tags in index.html.
// cache.addAll() is all-or-nothing: one 404 here rejects the whole install
// and the device silently ends up with no offline shell at all, so a file
// removed from the repo must be removed from this list too.
const SHELL = [
  "./",
  "./index.html",
  "./assets/style.css",
  "./assets/app.js",
  "./assets/dashboard.js",
  "./assets/appointments.js",
  "./assets/leads.js",
  "./assets/inventory.js",
  "./assets/intake.js",
  "./assets/parts-checker.js",
  "./assets/diagnostics.js",
  "./manifest.webmanifest",
  "./assets/branding/jq-electronics-logo.png",
  "./assets/branding/icon-192.png",
  "./assets/branding/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
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

  // A navigation (loading the page itself) is the only request that may fall
  // back to index.html. Asset requests (JS/CSS/images, incl. versioned
  // `?v=` URLs) must NOT: substituting index.html's HTML for a missing
  // .js file makes the browser execute HTML as JavaScript, which throws and
  // breaks the whole app — the exact failure a flaky connection would hit
  // right after a new deploy changed an asset's `?v=` string.
  const isNavigation = req.mode === "navigate";

  // Network-first: try the live file, cache a fresh copy, and only fall
  // back to the cached copy if the network is unreachable.
  e.respondWith(
    fetch(new Request(req, { cache: "no-store" }))
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (isNavigation) return caches.match("./index.html");
          // No cached asset and we're offline: fail honestly instead of
          // handing back HTML. The page's own network-first retry (and the
          // app's localStorage fallbacks) take it from here.
          return Response.error();
        })
      )
  );
});
