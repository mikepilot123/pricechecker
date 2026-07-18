/* ============================================================
   Repair Price Checker
   Live data from the shop's published Google Sheet (CSV).
   Edit the sheet -> prices update here on next automatic sync.
   ============================================================ */

// --- Data source: published Google Sheet tabs (CSV) -------------------------
const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTRAjtrKggslKZ32dsGE9GpRizu7qJOMJscTZg04MVDwssg199lNXRClV692KeUdTtkveaM8yiBrThu/pub";

const TABS = [
  { key: "apple", gid: "0", label: "iPhones" },
  { key: "techno", gid: "1021598529", label: "Techno" },
  { key: "samsung", gid: "1256027568", label: "Samsung" },
];

const AUTO_REFRESH_MS = 60 * 1000; // fallback sync when no price update socket is configured
const WS_RECONNECT_MAX_MS = 60 * 1000;
const WS_URL_STORAGE_KEY = "rpc_price_update_ws";
const DEFAULT_PRICE_UPDATE_WS_URL = ""; // disabled: Vercel watcher retired to stay on free tier; app uses 60s polling fallback
const INVENTORY_URL = "https://pricechecker-cyan.vercel.app/api/inventory";
// Bump this when the sheet parser changes so an old, incorrectly parsed
// price list is never used as the offline fallback.
const CACHE_KEY = "rpc_cache_v3";

// Section labels in the sheet that are dividers, not real models.
const SECTION_RE = /(series|^table\d*$)/i;

// --- DOM refs ---------------------------------------------------------------
const els = {
  search: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  chips: document.getElementById("filterChips"),
  pricesView: document.getElementById("view-prices"),
  results: document.getElementById("results"),
  count: document.getElementById("resultCount"),
  empty: document.getElementById("emptyState"),
  error: document.getElementById("errorState"),
  errorSub: document.getElementById("errorSub"),
  info: document.getElementById("infoBanner"),
  lastUpdated: document.getElementById("lastUpdated"),
  statusDot: document.getElementById("statusDot"),
  pricesSetupModal: document.getElementById("pricesSetupModal"),
  closePricesSetupModal: document.getElementById("closePricesSetupModal"),
  pricesScriptUrlInput: document.getElementById("pricesScriptUrlInput"),
  pricesPinInput: document.getElementById("pricesPinInput"),
  pricesSetupSave: document.getElementById("pricesSetupSave"),
  pricesSetupError: document.getElementById("pricesSetupError"),
};

// --- State ------------------------------------------------------------------
let MODELS = [];          // [{ name, brand, prices:[{type,value}], minPrice }]
let infoLines = [];       // standing info banner text
let activeBrand = "all";
let lastFetchTime = null;
let tickTimer = null;
let lastAutoScrolledModel = null;
let forceSearchScroll = false;
let priceSocket = null;
let socketReconnectTimer = null;
let socketReconnectDelay = 2000;
let syncTimer = null;
let loadInFlight = null;
let INVENTORY_ITEMS = [];
let inventoryLoadInFlight = null;

// --- Price editing state ----------------------------------------------------
const PRICES_SCRIPT_URL_KEY = "rpc_prices_script_url";
const INTAKE_PIN_KEY = "rpc_intake_pin";

function pricesScriptUrl() {
  try { return localStorage.getItem(PRICES_SCRIPT_URL_KEY) || ""; } catch(_) { return ""; }
}
function storedPin() {
  try { return localStorage.getItem(INTAKE_PIN_KEY) || ""; } catch(_) { return ""; }
}

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

  // A sheet tab can contain more than one table. For example, the iPhone
  // table uses "Incell Screen", while the iPad table below it uses
  // "Front Glass". Each "Model" row starts a new table with its own headers.
  const headerIndexes = rows
    .map((row, index) => ((row[0] || "").trim().toLowerCase() === "model" ? index : -1))
    .filter((index) => index !== -1);
  if (!headerIndexes.length) return { models: out, banner };

  // Capture any info text above the first table header (skip the title row).
  for (let i = 0; i < headerIndexes[0]; i++) {
    const cell = (rows[i][0] || "").trim();
    if (cell && i > 0 && !SECTION_RE.test(cell)) banner.push(cell);
  }

  for (let t = 0; t < headerIndexes.length; t++) {
    const headerIdx = headerIndexes[t];
    const endIdx = headerIndexes[t + 1] || rows.length;
    const header = rows[headerIdx].map((h) => (h || "").trim());
    const repairCols = [];
    for (let c = 1; c < header.length; c++) {
      const name = header[c];
      if (name && name.toLowerCase() !== "pricing structure") {
        repairCols.push({ idx: c, name });
      }
    }

    for (let r = headerIdx + 1; r < endIdx; r++) {
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
  }
  return { models: out, banner };
}

function deriveBrand(name, tabKey) {
  const n = name.toLowerCase();
  if (n.startsWith("ipad")) return "iPad";
  if (n.startsWith("iphone")) return "iPhone";
  if (tabKey === "techno" || n.startsWith("techno") || n.startsWith("tecno")) return "Techno";
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

async function loadData({ reason = "auto" } = {}) {
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
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
          "Showing the last saved prices — couldn't reach the sheet. The app will keep retrying automatically.";
      } else {
        setStatus("error");
        showError("Check your internet connection. The app will keep retrying automatically.");
      }
    } finally {
      startTicking();
      loadInFlight = null;
    }
  })();
  return loadInFlight;
}

async function loadInventoryForPrices({ force = false } = {}) {
  if (!force && Array.isArray(window.RPC_INVENTORY_ITEMS) && window.RPC_INVENTORY_ITEMS.length) {
    INVENTORY_ITEMS = window.RPC_INVENTORY_ITEMS.map(normalizeInventoryItemForPrices);
    if (MODELS.length) render();
    return INVENTORY_ITEMS;
  }
  if (inventoryLoadInFlight) return inventoryLoadInFlight;
  inventoryLoadInFlight = (async () => {
    try {
      const res = await fetch(INVENTORY_URL + "?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Inventory rejected");
      INVENTORY_ITEMS = (data.items || []).map(normalizeInventoryItemForPrices);
      window.RPC_INVENTORY_ITEMS = INVENTORY_ITEMS.slice();
      if (MODELS.length) render();
      return INVENTORY_ITEMS;
    } catch (err) {
      console.warn("Inventory stock indicators unavailable:", err);
      return INVENTORY_ITEMS;
    } finally {
      inventoryLoadInFlight = null;
    }
  })();
  return inventoryLoadInFlight;
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
  const labels = { all: "All", iPhone: "iPhone", iPad: "iPad", Techno: "Techno", Samsung: "Samsung", Other: "Other" };
  els.chips.innerHTML = "";
  brands.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "chip" + (b === activeBrand ? " active" : "");
    btn.textContent = labels[b] || b;
    btn.onclick = () => {
      activeBrand = b;
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
  const hasQuery = els.search.value.trim().length > 0;
  els.clearSearch.hidden = !els.search.value;
  if (!hasQuery) setPriceFiltersCollapsed(false);
  els.results.innerHTML = "";
  els.empty.hidden = list.length > 0;
  els.error.hidden = true;

  els.count.textContent = list.length
    ? `${list.length} model${list.length === 1 ? "" : "s"}`
    : "";

  // When the team is searching, auto-expand matches so prices show
  // immediately. While browsing (no query), keep cards collapsed.
  const expand = hasQuery;

  const frag = document.createDocumentFragment();
  let firstEl = null;
  let forcedScrollEl = null;
  const forcedModel = forceSearchScroll ? bestSearchMatch(list) : null;
  for (const m of list) {
    const el = card(m, expand);
    if (!firstEl) firstEl = el;
    if (forcedModel && m === forcedModel) forcedScrollEl = el;
    frag.appendChild(el);
  }
  els.results.appendChild(frag);

  if (forceSearchScroll) {
    forceSearchScroll = false;
    lastAutoScrolledModel = forcedModel ? forcedModel.name : null;
    if (forcedScrollEl || firstEl) setPriceFiltersCollapsed(true);
    requestAnimationFrame(() => scrollCardIntoView(forcedScrollEl || firstEl));
    return;
  }

  // Once a search narrows it down to exactly one model, scroll so its whole
  // card (head + full price list) is visible — staff shouldn't have to
  // manually scroll past the sticky search bar to see prices they just found.
  if (expand && list.length === 1 && list[0].name !== lastAutoScrolledModel) {
    lastAutoScrolledModel = list[0].name;
    setPriceFiltersCollapsed(true);
    requestAnimationFrame(() => scrollCardIntoView(firstEl));
  } else if (!expand || list.length !== 1) {
    lastAutoScrolledModel = null;
  }
}

function setPriceFiltersCollapsed(collapsed) {
  els.chips.classList.toggle("collapsed", collapsed);
  els.chips.setAttribute("aria-hidden", collapsed ? "true" : "false");
  if (els.pricesView) els.pricesView.classList.toggle("focused-search-result", collapsed);
}

function normalizeSearchText(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function bestSearchMatch(list) {
  if (!list.length) return null;
  const q = normalizeSearchText(els.search.value);
  if (!q) return list[0];
  return list.find((m) => normalizeSearchText(m.name) === q)
    || list.find((m) => normalizeSearchText(m.name).startsWith(q))
    || list[0];
}

function normalizeInventoryItemForPrices(item) {
  const quantity = Number(item.quantity || 0);
  const note = String(item.note || "");
  const committed = note && /sold/i.test(note) ? 1 : 0;
  return Object.assign({}, item, {
    key: item.key || "",
    section: String(item.section || "").toUpperCase(),
    item: item.item || item.device || "",
    device: item.device || item.item || "",
    quality: item.quality || "",
    quantity,
    available: Math.max(0, quantity - committed),
  });
}

function inventorySectionForRepair(repairType) {
  const text = String(repairType || "").toLowerCase();
  if (/(screen|lcd|display|front\s*glass)/i.test(text)) return "SCREENS";
  if (/battery/i.test(text)) return "BATTERIES";
  return "";
}

function normalizeDeviceName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\b(apple|cell|phone|tablet)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bgen(?:eration)?\b/g, "gen")
    .replace(/\s+/g, " ")
    .trim();
}

function inventoryDeviceMatches(modelName, itemName) {
  const model = normalizeDeviceName(modelName);
  const item = normalizeDeviceName(itemName);
  if (!model || !item) return false;
  // Strict equality only — substring matching let a bare "iPhone 13" inventory
  // entry falsely match "iPhone 13 Mini"/"Pro"/"Pro Max" price rows, since the
  // shorter normalized name is a substring of the longer ones.
  return model === item;
}

function normalizePartQuality(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/oled/g, " oled ")
    .replace(/lcd/g, " lcd ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function screenQualityMatches(repairType, inventoryItem) {
  const repair = normalizePartQuality(repairType);
  const quality = normalizePartQuality([inventoryItem.quality, inventoryItem.label].filter(Boolean).join(" "));

  if (/front\s*glass|glass\s*only/.test(repair)) {
    return /front\s*glass|glass/.test(quality);
  }
  if (/\bincell\b/.test(repair)) {
    return /\bincell\b/.test(quality);
  }
  if (/\bsoft\b/.test(repair)) {
    return /\bsoft\b/.test(quality);
  }
  if (/\bhard\b/.test(repair)) {
    return /\bhard\b/.test(quality);
  }
  if (/\boled\b/.test(repair)) {
    return /\boled\b|\bsoft\b|\bhard\b/.test(quality) && !/\bincell\b|front\s*glass|\bglass\b/.test(quality);
  }
  if (/\blcd\b/.test(repair)) {
    return /\blcd\b/.test(quality);
  }
  return true;
}

function inventoryPartMatchesRepair(repairType, item) {
  const section = inventorySectionForRepair(repairType);
  if (section === "SCREENS") return screenQualityMatches(repairType, item);
  if (section === "BATTERIES") return true;
  return false;
}

function isPricePartInStock(modelName, repairType) {
  const section = inventorySectionForRepair(repairType);
  if (!section || !INVENTORY_ITEMS.length) return false;
  return INVENTORY_ITEMS.some((item) =>
    item.section === section
    && item.available > 0
    && inventoryDeviceMatches(modelName, item.device || item.item || item.label)
    && inventoryPartMatchesRepair(repairType, item)
  );
}

function scrollCardIntoView(cardEl) {
  if (!cardEl) return;
  const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
  const searchWrap = document.querySelector(".search-wrap");
  const stickyOffset = headerH + (searchWrap ? searchWrap.offsetHeight : 0) + 12;
  const rect = cardEl.getBoundingClientRect();
  // Skip the scroll if the card already fits cleanly below the sticky bar.
  if (rect.top >= stickyOffset && rect.bottom <= window.innerHeight) return;
  const top = window.scrollY + rect.top - stickyOffset;
  window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
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
            ? `<span class="from-value"><span class="from-prefix">From</span> $${fmt(m.minPrice)}</span>`
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
    grid.innerHTML = m.prices.map((p, i) => priceRowHtml(m, p, i)).join("");
    grid.querySelectorAll(".price-row").forEach((rowEl) => {
      const p = m.prices[Number(rowEl.dataset.idx)];
      const go = (e) => {
        e.stopPropagation();
        logDeviceFromPrice(m, p);
      };
      rowEl.addEventListener("click", go);
      rowEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go(e);
        }
      });
      bindPriceEditBtn(rowEl, m, p);
    });
    body.appendChild(grid);
  } else {
    body.innerHTML = `<p class="no-prices">No set price for this model yet — please call to confirm a quote.</p>`;
  }

  head.onclick = () => el.classList.toggle("open");
  el.appendChild(head);
  el.appendChild(body);
  return el;
}

// --- Price rows + inline pencil edit ------------------------------------------
// Matches assets/intake.js's per-field pencil pattern (startInlineEdit /
// saveInlineEdit / renderDetailRowStatic): clicking the pencil turns just
// that row's value into an input + save/cancel, no page-wide edit mode.
function priceRowHtml(m, p, idx) {
  const inStock = isPricePartInStock(m.name, p.type);
  return `<div class="price-row" role="button" tabindex="0" data-idx="${idx}"
      aria-label="Log a device for ${escapeHtml(m.name)} — ${escapeHtml(p.type)}">
    <span class="price-name"><button type="button" class="price-add-btn" tabindex="-1" aria-hidden="true">+</button>${escapeHtml(p.type)}${inStock ? `<span class="price-stock-tick" title="In stock" aria-label="In stock">✓</span>` : ""}</span>
    ${priceValueHtml(p.value)}
    <button type="button" class="icon-btn ghost-btn price-edit-btn" data-edit-price aria-label="Edit price"><svg class="icon"><use href="#i-pencil"></use></svg></button>
  </div>`;
}

function priceValueHtml(value) {
  return `<span class="price-val">${formatPrice(value)}</span>`;
}

function bindPriceEditBtn(rowEl, model, priceEntry) {
  const btn = rowEl.querySelector("[data-edit-price]");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    startPriceInlineEdit(rowEl, model, priceEntry);
  });
}

function startPriceInlineEdit(rowEl, model, priceEntry) {
  if (!pricesScriptUrl()) { openPricesSetupModal(); return; }
  const raw = String(priceEntry.value).replace(/[^0-9.]/g, "");
  rowEl.querySelector(".price-val").outerHTML = `
    <span class="price-val price-val-editing">
      <input type="text" inputmode="decimal" class="text-input price-inline-input" value="${escapeHtml(raw)}" />
      <button type="button" class="icon-btn ghost-btn" data-save-price aria-label="Save"><svg class="icon"><use href="#i-check"></use></svg></button>
      <button type="button" class="icon-btn ghost-btn" data-cancel-price aria-label="Cancel"><svg class="icon"><use href="#i-xmark"></use></svg></button>
    </span>`;
  rowEl.querySelector("[data-edit-price]")?.remove();
  const input = rowEl.querySelector(".price-inline-input");
  input.focus();
  input.select();
  rowEl.querySelector("[data-save-price]").addEventListener("click", (e) => {
    e.stopPropagation();
    savePriceInlineEdit(rowEl, model, priceEntry);
  });
  rowEl.querySelector("[data-cancel-price]").addEventListener("click", (e) => {
    e.stopPropagation();
    renderPriceRowStatic(rowEl, model, priceEntry);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); savePriceInlineEdit(rowEl, model, priceEntry); }
    if (e.key === "Escape") { e.preventDefault(); renderPriceRowStatic(rowEl, model, priceEntry); }
  });
}

function renderPriceRowStatic(rowEl, model, priceEntry) {
  rowEl.querySelector(".price-val-editing")?.remove();
  rowEl.insertAdjacentHTML(
    "beforeend",
    priceValueHtml(priceEntry.value) +
      `<button type="button" class="icon-btn ghost-btn price-edit-btn" data-edit-price aria-label="Edit price"><svg class="icon"><use href="#i-pencil"></use></svg></button>`
  );
  bindPriceEditBtn(rowEl, model, priceEntry);
}

async function savePriceInlineEdit(rowEl, model, priceEntry) {
  const url = pricesScriptUrl();
  const pin = storedPin();
  const input = rowEl.querySelector(".price-inline-input");
  const saveBtn = rowEl.querySelector("[data-save-price]");
  const value = (input.value || "").trim();
  if (!value) {
    input.classList.add("field-error-input");
    return;
  }
  saveBtn.disabled = true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "updatePrice",
        pin,
        model: model.name,
        repairType: priceEntry.type,
        value,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Update failed");
    // Optimistic local update so the row reflects the new value immediately;
    // still reload from the sheet in the background to reconcile formatting.
    priceEntry.value = value;
    renderPriceRowStatic(rowEl, model, priceEntry);
    loadData({ reason: "price-edit" });
  } catch (err) {
    input.classList.add("field-error-input");
    saveBtn.disabled = false;
  }
}

function openPricesSetupModal() {
  els.pricesScriptUrlInput.value = pricesScriptUrl();
  els.pricesPinInput.value = storedPin();
  els.pricesSetupError.hidden = true;
  els.pricesSetupModal.hidden = false;
}

function savePricesSetup() {
  const url = (els.pricesScriptUrlInput.value || "").trim();
  const pin = (els.pricesPinInput.value || "").trim();
  if (!url) {
    els.pricesSetupError.textContent = "Enter the Apps Script URL";
    els.pricesSetupError.hidden = false;
    return;
  }
  if (!pin) {
    els.pricesSetupError.textContent = "Enter the team PIN";
    els.pricesSetupError.hidden = false;
    return;
  }
  try {
    localStorage.setItem(PRICES_SCRIPT_URL_KEY, url);
    localStorage.setItem(INTAKE_PIN_KEY, pin);
  } catch(_) {}
  els.pricesSetupModal.hidden = true;
}

// --- Log device from a price row --------------------------------------------
// Lets staff jump straight from "how much for X" to logging the device for
// that exact repair, instead of re-typing the model/issue in the Intake tab.
// assets/intake.js listens for this event (it owns the actual modal/form).
function logDeviceFromPrice(model, priceEntry) {
  // Pull a clean number out of the raw cell ("$650", "650.00", etc.) so the
  // intake form can drop it straight into its numeric Repair-cost field.
  const num = parseFloat(String(priceEntry.value).replace(/[^0-9.]/g, ""));
  window.dispatchEvent(
    new CustomEvent("rpc-log-device", {
      detail: {
        device: model.name,
        repairType: priceEntry.type,
        price: formatPrice(priceEntry.value),
        priceValue: Number.isNaN(num) ? null : num,
      },
    })
  );
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
if (els.closePricesSetupModal) els.closePricesSetupModal.addEventListener("click", () => { els.pricesSetupModal.hidden = true; });
if (els.pricesSetupSave) els.pricesSetupSave.addEventListener("click", savePricesSetup);

els.search.addEventListener("input", render);
els.search.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  forceSearchScroll = true;
  render();
});
els.clearSearch.addEventListener("click", () => {
  els.search.value = "";
  els.search.focus();
  render();
});
window.addEventListener("rpc-inventory", (event) => {
  INVENTORY_ITEMS = ((event.detail && event.detail.items) || window.RPC_INVENTORY_ITEMS || [])
    .map(normalizeInventoryItemForPrices);
  if (MODELS.length) render();
});
// Refresh when the tab regains focus (counter staff reopening the app).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && lastFetchTime && Date.now() - lastFetchTime > 60000) {
    loadData({ reason: "focus" });
  }
});

// Automatic live updates ------------------------------------------------------
// GitHub Pages cannot receive Google Sheet updates directly, so it listens to
// the Vercel WebSocket watcher and falls back to this one-minute no-button sync
// if the socket is unavailable.
function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    // Skip background refreshes while the tab is hidden — the
    // visibilitychange handler above catches the app up on return.
    if (document.hidden) return;
    loadData({ reason: "interval" });
  }, AUTO_REFRESH_MS);
}

function priceUpdateSocketUrl() {
  try {
    const saved = localStorage.getItem(WS_URL_STORAGE_KEY);
    if (saved === "off") return "";
    return saved || DEFAULT_PRICE_UPDATE_WS_URL;
  } catch (_) {
    return DEFAULT_PRICE_UPDATE_WS_URL;
  }
}

function startPriceUpdateSocket() {
  const url = priceUpdateSocketUrl();
  if (!url || !("WebSocket" in window)) return;
  try {
    priceSocket = new WebSocket(url);
  } catch (err) {
    console.warn("Price update socket couldn't start:", err);
    return;
  }

  priceSocket.addEventListener("open", () => {
    socketReconnectDelay = 2000;
  });
  priceSocket.addEventListener("message", (event) => {
    let message = event.data;
    try { message = JSON.parse(event.data); } catch (_) {}
    const type = typeof message === "string" ? message : message && message.type;
    if (type === "price:update" || type === "prices:update" || type === "refresh") {
      loadData({ reason: "socket" });
    }
  });
  priceSocket.addEventListener("close", scheduleSocketReconnect);
  priceSocket.addEventListener("error", () => {
    if (priceSocket) priceSocket.close();
  });
}

function scheduleSocketReconnect() {
  if (!priceUpdateSocketUrl()) return;
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer);
  socketReconnectTimer = setTimeout(startPriceUpdateSocket, socketReconnectDelay);
  socketReconnectDelay = Math.min(socketReconnectDelay * 1.7, WS_RECONNECT_MAX_MS);
}

// --- Service worker (offline shell) -----------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {});
  });
}

// --- Install app (PWA) -------------------------------------------------------
// Chrome/Edge/Android fire `beforeinstallprompt` when the manifest + service
// worker criteria are met; we hold onto that event and surface our own
// "Install app" nav button instead of relying on staff to notice the
// browser's own (easy-to-miss) install affordance. iOS Safari has no such
// event — Add to Home Screen there only exists in the Share sheet — so we
// show a one-time instructional tip instead of a button that would do
// nothing when tapped.
(function () {
  const btn = document.getElementById("installAppBtn");
  const iosTip = document.getElementById("installIosTip");
  const closeIosTip = document.getElementById("closeInstallIosTip");
  const LS_IOS_TIP_DISMISSED = "rpc_install_ios_tip_dismissed";
  let deferredPrompt = null;

  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  if (isStandalone()) return; // already installed and running as an app

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btn) btn.hidden = false;
  });

  btn?.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    btn.hidden = true;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (_) { /* dismissed */ }
    deferredPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    if (btn) btn.hidden = true;
    if (iosTip) iosTip.hidden = true;
  });

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (isIos && iosTip) {
    let dismissed = false;
    try { dismissed = localStorage.getItem(LS_IOS_TIP_DISMISSED) === "1"; } catch (_) { /* ignore */ }
    if (!dismissed) setTimeout(() => { iosTip.hidden = false; }, 1500);
    closeIosTip?.addEventListener("click", () => {
      iosTip.hidden = true;
      try { localStorage.setItem(LS_IOS_TIP_DISMISSED, "1"); } catch (_) { /* ignore */ }
    });
  }
})();

// --- Sticky search offset -----------------------------------------------
// Search bars stick just below the header; track its real height (it can
// change with font load or wrapping)
// so the sticky offset never overlaps or gaps.
(function () {
  const header = document.querySelector(".app-header");
  if (!header) return;
  const setH = () => {
    const sideNav = window.matchMedia("(min-width: 900px)").matches;
    document.documentElement.style.setProperty("--header-h", sideNav ? "0px" : header.offsetHeight + "px");
  };
  setH();
  if ("ResizeObserver" in window) new ResizeObserver(setH).observe(header);
  window.addEventListener("resize", setH);
})();

// --- Go ---------------------------------------------------------------------
showSkeleton();
startAutoSync();
startPriceUpdateSocket();
loadData({ reason: "initial" });
loadInventoryForPrices();
