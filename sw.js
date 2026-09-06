/* Service worker.

   Strategy: STALE-WHILE-REVALIDATE for the app's own files, with a hard
   timeout on every network call.

   This used to be network-first with `cache: "no-store"`, which meant every
   load re-downloaded all ~750KB of HTML/CSS/JS and waited on the network to
   do it. On wifi that's invisible. On mobile data it isn't: a slow cellular
   fetch doesn't reject, it *hangs*, so the app sat waiting on the network
   with a perfectly good cached copy it refused to use, and never painted.

   So now: serve the cached copy immediately when there is one, and refresh
   it in the background for next time. A new deploy lands one reload later
   instead of instantly, which is the right trade for a shop tool that has to
   open on a phone in a back room with one bar of signal.

   The prices/intake API and Google Sheet are never touched here — those go
   straight to the network and have their own localStorage fallbacks. */

const VERSION = "v73";
const CACHE = `rpc-shell-${VERSION}`;

// How long any single network request may take before we stop waiting and
// use what we have. Cellular latency is spiky, so this is generous enough
// not to fight a merely-slow connection but short enough to never feel hung.
const NETWORK_TIMEOUT_MS = 4000;
// Navigations get less patience: this is the request standing between the
// user and a blank screen, and we always have index.html cached.
const NAV_TIMEOUT_MS = 2500;

// Base shell. The versioned `?v=` URLs that index.html actually references
// are added at runtime (and by the page's own PRECACHE message, see below),
// so this list intentionally doesn't try to track query strings by hand.
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
  "./assets/prices-admin.js",
  "./assets/account.js",
  "./assets/parts-orders.js",
  "./manifest.webmanifest",
  "./assets/branding/jq-electronics-logo.png",
  "./assets/branding/icon-192.png",
  "./assets/branding/icon-512.png",
  "./assets/branding/apple-touch-icon.png",
];

function timedFetch(request, ms, init) {
  // AbortController rather than Promise.race so a timed-out request is
  // actually cancelled — on a slow link, leaving a dozen abandoned downloads
  // running is part of what made the connection slow in the first place.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal, ...init })
    .finally(() => clearTimeout(timer));
}

async function cachePut(request, response) {
  if (!response || !response.ok) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
    await pruneSupersededVersions(cache, request);
  } catch (_) {
    // Storage full or unavailable — not worth failing the request over.
  }
}

// Every deploy bumps the `?v=` string on a few assets, so without this the
// cache slowly fills with style.css?v=1, ?v=2, ?v=3 … forever. Once a URL is
// stored, drop any other cached entry for the same file that differs only by
// query string.
async function pruneSupersededVersions(cache, request) {
  const fresh = new URL(request.url);
  const keys = await cache.keys();
  await Promise.all(keys.map((key) => {
    const old = new URL(key.url);
    if (old.pathname !== fresh.pathname || old.search === fresh.search) return null;
    return cache.delete(key);
  }));
}

// Exact-URL match only. Deliberately strict: `?v=` is how a deploy says "this
// file changed", so a request for style.css?v=4 must never be satisfied from
// a cached style.css?v=3 while the network is available — that would silently
// delay every deploy by a reload and make "I pushed a fix but nothing
// changed" a routine occurrence.
async function cacheLookup(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request);
}

// The version-agnostic fallback, used ONLY once the network has actually
// failed. Offline on the first load after a deploy, a slightly stale
// stylesheet beats a blank page.
async function staleFallback(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, { ignoreSearch: true });
}

// Add each URL independently. cache.addAll() is all-or-nothing: one 404
// rejects the whole install and the device silently ends up with no offline
// shell at all, which is the worst possible failure mode for this.
async function precache(urls) {
  const cache = await caches.open(CACHE);
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const request = new Request(url, { cache: "reload" });
      const response = await timedFetch(request, NETWORK_TIMEOUT_MS);
      if (!response.ok) throw new Error(`${url} -> ${response.status}`);
      await cache.put(request, response.clone());
    })
  );
  return {
    cached: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache(SHELL).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page hands us the exact `?v=` URLs it loaded (see app.js), which keeps
// the offline copy in sync with index.html automatically instead of relying
// on this file's SHELL list being updated by hand every deploy.
self.addEventListener("message", (e) => {
  const data = e.data || {};
  if (data.type !== "PRECACHE") return;
  const urls = Array.isArray(data.urls) ? data.urls : [];
  const reason = data.reason === "manual" ? "manual" : "auto";
  e.waitUntil(
    precache(SHELL.concat(urls)).then((result) => {
      if (e.source) e.source.postMessage({ type: "PRECACHE_DONE", reason, ...result });
    })
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only our own GET requests; the API, Google Sheet and fonts go straight
  // to the network.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigation: try the network briefly so a new deploy is picked up, but
  // fall back to the cached shell fast rather than leaving a blank screen.
  if (req.mode === "navigate") {
    e.respondWith(
      // "no-cache" (revalidate), NOT "no-store" (never cache). index.html is
      // served with max-age by GitHub Pages, so leaving the HTTP cache to its
      // own devices means a deploy stays invisible until that expires. This
      // forces a revalidation, which costs a 304 when nothing changed —
      // cheap even on mobile data — while still picking up a new deploy
      // immediately. The old "no-store" instead re-downloaded all 109KB of
      // HTML every single load, which is half of why this was slow.
      timedFetch(req, NAV_TIMEOUT_MS, { cache: "no-cache" })
        .then((res) => {
          cachePut(req, res);
          return res;
        })
        .catch(async () =>
          (await cacheLookup(req)) ||
          (await staleFallback(req)) ||
          (await caches.match("./index.html")) ||
          (await caches.match("./")) ||
          Response.error()
        )
    );
    return;
  }

  // Assets: stale-while-revalidate. Cached copy goes back immediately (this
  // is what makes the app open instantly on bad data), and a background
  // refresh keeps the next load current.
  e.respondWith(
    cacheLookup(req).then((hit) => {
      const network = timedFetch(req, NETWORK_TIMEOUT_MS)
        .then((res) => {
          cachePut(req, res);
          return res;
        });

      if (hit) {
        // Don't let an unhandled background rejection surface as an error.
        e.waitUntil(network.catch(() => {}));
        return hit;
      }

      // No exact copy — this is a freshly deployed `?v=` URL, so wait on the
      // network to get the real thing. Only if that fails do we reach for a
      // previous version of the same file. Never substitute index.html for a
      // missing .js file: the browser would execute HTML as JavaScript and
      // break the whole app.
      return network.catch(async () => (await staleFallback(req)) || Response.error());
    })
  );
});
