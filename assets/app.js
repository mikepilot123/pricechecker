/* ============================================================
   Repair Price Checker
   Live data from the shop's published Google Sheet (CSV).
   Edit the sheet -> prices update here on next load / refresh.
   ============================================================ */

// --- Data source: published Google Sheet tabs (CSV) -------------------------
const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTRAjtrKggslKZ32dsGE9GpRizu7qJOMJscTZg04MVDwssg199lNXRClV692KeUdTtkveaM8yiBrThu/pub";

const TABS = [
  { key: "apple", gid: "0", label: "iPhones" },
  { key: "samsung", gid: "1256027568", label: "Samsung" },
];

const AUTO_REFRESH_MS = 5 * 60 * 1000; // every 5 minutes
const CACHE_KEY = "rpc_cache_v1";
const MODEL_PAGE_SIZE = 18;

// Section labels in the sheet that are dividers, not real models.
const SECTION_RE = /(series|^table\d*$)/i;

// --- DOM refs ---------------------------------------------------------------
const els = {
  search: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  chips: document.getElementById("filterChips"),
  results: document.getElementById("results"),
  count: document.getElementById("resultCount"),
  empty: document.getElementById("emptyState"),
  error: document.getElementById("errorState"),
  errorSub: document.getElementById("errorSub"),
  info: document.getElementById("infoBanner"),
  lastUpdated: document.getElementById("lastUpdated"),
  statusDot: document.getElementById("statusDot"),
  refresh: document.getElementById("refreshBtn"),
};

// --- State ------------------------------------------------------------------
let MODELS = [];          // [{ name, brand, prices:[{type,value}], minPrice }]
let infoLines = [];       // standing info banner text
let activeBrand = "all";
let lastFetchTime = null;
let tickTimer = null;
let visibleModelCount = MODEL_PAGE_SIZE;

// --- CSV parsing ------------------------------------------------------------
// Robust CSV -> array of rows (handles quoted fields, commas, newlines).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- Turn a tab's rows into model objects -----------------------------------
function rowsToModels(rows, tabKey) {
  const out = [];
  const banner = [];

  // Find header row (first cell trimmed === "Model").
  let headerIdx = rows.findIndex((r) => (r[0] || "").trim().toLowerCase() === "model");
  if (headerIdx === -1) return { models: out, banner };

  // Capture any info text above the header (skip the title row 0).
  for (let i = 0; i < headerIdx; i++) {
    const cell = (rows[i][0] || "").trim();
    if (cell && i > 0 && !SECTION_RE.test(cell)) banner.push(cell);
  }

  // Repair-type column names.
  const header = rows[headerIdx].map((h) => (h || "").trim());
  const repairCols = [];
  for (let c = 1; c < header.length; c++) {
    const name = header[c];
    if (name && name.toLowerCase() !== "pricing structure") {
      repairCols.push({ idx: c, name });
    }
  }

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    const model = (cells[0] || "").trim();
    if (!model) continue;                 // blank separator
    if (SECTION_RE.test(model)) continue; // "S Series", "Table1", etc.

    const prices = [];
    let min = Infinity;
    for (const col of repairCols) {
      const raw = (cells[col.idx] || "").trim();
      if (!raw || raw.toUpperCase() === "N/A") continue;
      prices.push({ type: col.name, value: raw });
      const num = parseFloat(raw.replace(/[^0-9.]/g, ""));
      if (!isNaN(num) && num < min) min = num;
    }

    out.push({
      name: model,
      brand: deriveBrand(model, tabKey),
      prices,
      minPrice: min === Infinity ? null : min,
    });
  }
  return { models: out, banner };
}

function deriveBrand(name, tabKey) {
  const n = name.toLowerCase();
  if (n.startsWith("ipad")) return "iPad";
  if (n.startsWith("iphone")) return "iPhone";
  if (tabKey === "samsung" || n.startsWith("samsung")) return "Samsung";
  return "Other";
}

// --- Fetch ------------------------------------------------------------------
async function fetchTab(tab) {
  const url = `${SHEET_BASE}?gid=${tab.gid}&single=true&output=csv&_=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCSV(await res.text());
}

async function loadData({ manual = false } = {}) {
  setRefreshing(true);
  try {
    const results = await Promise.all(TABS.map((t) => fetchTab(t).then((rows) => ({ t, rows }))));
    const all = [];
    let banner = [];
    for (const { t, rows } of results) {
      const { models, banner: b } = rowsToModels(rows, t.key);
      all.push(...models);
      if (b.length > banner.length) banner = b; // keep the richest info line
    }
    MODELS = all;
    visibleModelCount = MODEL_PAGE_SIZE;
    // Expose model names so the Intake form can autosuggest devices.
    window.RPC_MODEL_NAMES = all.map((m) => m.name.trim());
    window.dispatchEvent(new Event("rpc-models"));
    infoLines = banner;
    lastFetchTime = Date.now();
    persistCache();
    renderInfo();
    buildChips();
    render();
    setStatus("live");
    els.error.hidden = true;
  } catch (err) {
    console.error("Load failed:", err);
    const restored = restoreCache();
    if (restored) {
      renderInfo();
      buildChips();
      render();
      setStatus("stale");
      els.errorSub.textContent =
        "Showing the last saved prices — couldn't reach the sheet. Tap Refresh to retry.";
    } else {
      setStatus("error");
      showError("Check your internet connection and tap Refresh.");
    }
  } finally {
    setRefreshing(false);
    startTicking();
  }
}

// --- Cache (offline resilience) ---------------------------------------------
function persistCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ models: MODELS, info: infoLines, time: lastFetchTime })
    );
  } catch (_) {}
}
function restoreCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.models || !data.models.length) return false;
    MODELS = data.models;
    infoLines = data.info || [];
    lastFetchTime = data.time || null;
    return true;
  } catch (_) {
    return false;
  }
}

// --- Rendering --------------------------------------------------------------
function renderInfo() {
  els.info.textContent = infoLines.length ? infoLines.join("  ·  ") : "Prices in TTD.";
}

function buildChips() {
  const brands = ["all", ...new Set(MODELS.map((m) => m.brand))];
  const labels = { all: "All", iPhone: "iPhone", iPad: "iPad", Samsung: "Samsung", Other: "Other" };
  els.chips.innerHTML = "";
  brands.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "chip" + (b === activeBrand ? " active" : "");
    btn.textContent = labels[b] || b;
    btn.onclick = () => {
      activeBrand = b;
      visibleModelCount = MODEL_PAGE_SIZE;
      [...els.chips.children].forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      render();
    };
    els.chips.appendChild(btn);
  });
}

function currentFilter() {
  const q = els.search.value.trim().toLowerCase();
  return MODELS.filter((m) => {
    if (activeBrand !== "all" && m.brand !== activeBrand) return false;
    if (q && !m.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

function render() {
  const list = currentFilter();
  const visible = list.slice(0, visibleModelCount);
  els.clearSearch.hidden = !els.search.value;
  els.results.innerHTML = "";
  els.empty.hidden = list.length > 0;
  els.error.hidden = true;

  els.count.textContent = list.length
    ? `Showing ${visible.length} of ${list.length} model${list.length === 1 ? "" : "s"}`
    : "";

  // When the team is searching, auto-expand matches so prices show
  // immediately. While browsing (no query), keep cards collapsed.
  const expand = els.search.value.trim().length > 0;

  const frag = document.createDocumentFragment();
  for (const m of visible) frag.appendChild(card(m, expand));
  if (visible.length < list.length) {
    const more = document.createElement("button");
    const remaining = list.length - visible.length;
    more.className = "view-more-btn";
    more.innerHTML = `View ${Math.min(MODEL_PAGE_SIZE, remaining)} more <span aria-hidden="true">↓</span>`;
    more.onclick = () => {
      visibleModelCount += MODEL_PAGE_SIZE;
      render();
    };
    frag.appendChild(more);
  }
  els.results.appendChild(frag);
}

function card(m, expand = false) {
  const el = document.createElement("div");
  el.className = "card" + (expand ? " open" : "");

  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML = `
    <div class="card-model">
      <span>${escapeHtml(m.name)}</span>
      <span class="brand-tag">${m.brand}</span>
    </div>
    <div class="card-right">
      <div class="from-price">
        ${
          m.minPrice != null
            ? `<span class="from-label">from</span><span class="from-value">$${fmt(m.minPrice)}</span>`
            : `<span class="from-value na">Call to confirm</span>`
        }
      </div>
      <svg class="icon chevron" aria-hidden="true"><use href="#i-chevron-down"></use></svg>
    </div>`;

  const body = document.createElement("div");
  body.className = "card-body";
  if (m.prices.length) {
    const grid = document.createElement("div");
    grid.className = "price-grid";
    grid.innerHTML = m.prices
      .map(
        (p) => `<div class="price-row">
          <span class="price-name">${escapeHtml(p.type)}</span>
          <span class="price-val">${formatPrice(p.value)}</span>
        </div>`
      )
      .join("");
    body.appendChild(grid);
  } else {
    body.innerHTML = `<p class="no-prices">No set price for this model yet — please call to confirm a quote.</p>`;
  }

  head.onclick = () => el.classList.toggle("open");
  el.appendChild(head);
  el.appendChild(body);
  return el;
}

// --- Status / timestamp -----------------------------------------------------
function setStatus(state) {
  els.statusDot.className = "status-dot " + state;
  updateTimestamp();
}

function updateTimestamp() {
  if (!lastFetchTime) {
    els.lastUpdated.textContent = "Prices not loaded yet";
    return;
  }
  const secs = Math.round((Date.now() - lastFetchTime) / 1000);
  let when;
  if (secs < 10) when = "just now";
  else if (secs < 60) when = `${secs}s ago`;
  else if (secs < 3600) when = `${Math.floor(secs / 60)} min ago`;
  else when = new Date(lastFetchTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const prefix = els.statusDot.classList.contains("stale") ? "Saved prices · updated " : "Updated ";
  els.lastUpdated.textContent = prefix + when;
}

function startTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(updateTimestamp, 15000);
}

function setRefreshing(on) {
  els.refresh.classList.toggle("spinning", on);
  els.refresh.disabled = on;
}

function showError(msg) {
  els.results.innerHTML = "";
  els.count.textContent = "";
  els.empty.hidden = true;
  els.error.hidden = false;
  els.errorSub.textContent = msg;
}

// --- Helpers ----------------------------------------------------------------
function fmt(n) {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2 });
}
function formatPrice(raw) {
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  if (!isNaN(num) && /^[0-9.,\s$]+$/.test(String(raw))) return "$" + fmt(num);
  return escapeHtml(raw); // non-numeric (e.g. notes) shown as-is
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// --- Loading skeleton -------------------------------------------------------
function showSkeleton() {
  els.results.innerHTML = Array.from({ length: 6 })
    .map(() => `<div class="skeleton"></div>`)
    .join("");
}

// --- Wire up events ---------------------------------------------------------
els.search.addEventListener("input", () => {
  visibleModelCount = MODEL_PAGE_SIZE;
  render();
});
els.clearSearch.addEventListener("click", () => {
  els.search.value = "";
  visibleModelCount = MODEL_PAGE_SIZE;
  els.search.focus();
  render();
});
els.refresh.addEventListener("click", () => loadData({ manual: true }));

// Refresh when the tab regains focus (counter staff reopening the app).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && lastFetchTime && Date.now() - lastFetchTime > 60000) {
    loadData();
  }
});

// Auto-refresh on an interval.
setInterval(loadData, AUTO_REFRESH_MS);

// --- Service worker (offline shell) -----------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// --- Sticky search offset -----------------------------------------------
// Search bars stick just below the header; track its real height (it can
// change with font load, wrapping, or the refresh button showing/hiding)
// so the sticky offset never overlaps or gaps.
(function () {
  const header = document.querySelector(".app-header");
  if (!header) return;
  const setH = () => document.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
  setH();
  if ("ResizeObserver" in window) new ResizeObserver(setH).observe(header);
  window.addEventListener("resize", setH);
})();

// --- Go ---------------------------------------------------------------------
showSkeleton();
loadData();
