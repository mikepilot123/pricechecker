/* ============================================================
   Smart restock (top of the Parts orders tab)
   ------------------------------------------------------------
   Its own sub-tab under Parts orders ("Smart restock").
   Suggests which parts to order, and how many, from data the app already
   has — no AI service involved:
     • demand   repairs logged in the period (issue → part) and Prices-tab
                searches that clearly point at one model
     • supply   stock in the inventory sheet + parts already on order
     • timing   how long each kind of part usually takes to arrive (from
                past parts orders) + how many weeks of stock to keep
   Staff tick suggestions, copy/share an order list for the supplier, and
   "Record as ordered" creates the parts orders. Also lists stock that
   isn't moving (money sitting still).
   ============================================================ */
(() => {
  const $ = (id) => document.getElementById(id);
  const INTAKE_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const PRICES_URL = "https://pricechecker-cyan.vercel.app/api/prices";
  const PREFS_KEY = "rpc_restock_prefs";
  // Roughly how many price searches turn into a repair. Only searches that
  // clearly name one model count, and they're split across that model's parts.
  const SEARCH_CONVERSION = 0.3;
  const DEFAULT_LEAD_DAYS = 7;
  const DAY = 86400000;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const pin = () => { try { return localStorage.getItem("rpc_intake_pin") || ""; } catch (_) { return ""; } };

  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: pin() }, body)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Request failed");
    return data;
  }
  async function listTickets() {
    const q = new URLSearchParams({ action: "list", pin: pin(), _: Date.now() });
    const res = await fetch(INTAKE_URL + "?" + q.toString());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Couldn't load repairs");
    return data.tickets || [];
  }

  /* ---- Parts --------------------------------------------------------- */
  // Order matters: back glass before screen ("glass"), speaker before mic.
  const PARTS = [
    { key: "backglass", label: "Back glass", re: /back\s*glass|back\s*cover|housing|rear\s*glass/i, section: /BACK/ },
    { key: "screen", label: "Screen", re: /screen|display|lcd|oled|incell|digiti[sz]er|front\s*glass/i, section: /SCREEN/ },
    { key: "battery", label: "Battery", re: /batter/i, section: /BATTER/ },
    { key: "charging", label: "Charging port", re: /charg|dock|usb|lightning\s*port/i, section: /CHARG/ },
    { key: "camera", label: "Camera", re: /camera|lens/i, section: /CAMERA/ },
    { key: "speaker", label: "Speaker / mic", re: /speaker|\bmic\b|microphone|earpiece/i, section: /SPEAKER/ },
  ];
  const partFor = (text) => PARTS.find((p) => p.re.test(String(text || ""))) || null;
  const partBySection = (section) => PARTS.find((p) => p.section.test(String(section || "").toUpperCase())) || null;

  /* ---- Models -------------------------------------------------------- */
  const keyOf = (s) => String(s || "").toLowerCase().replace(/\bapple\b/g, "").replace(/[^a-z0-9]/g, "");
  let modelIndex = [];
  function buildModelIndex() {
    const models = Array.isArray(window.RPC_PRICE_MODELS) ? window.RPC_PRICE_MODELS : [];
    modelIndex = models
      .map((m) => ({ model: m, key: keyOf(m.name) }))
      .filter((m) => m.key)
      .sort((a, b) => b.key.length - a.key.length); // longest (most specific) first
  }
  // A free-text device/part name → price-list model: exact, then the longest
  // model the text starts with, then the longest model it contains.
  function modelFor(text) {
    const k = keyOf(text);
    if (!k) return null;
    return (modelIndex.find((m) => m.key === k)
      || modelIndex.find((m) => k.startsWith(m.key))
      || modelIndex.find((m) => m.key.length >= 4 && k.includes(m.key)))?.model || null;
  }
  // "iPhone 12/12 Pro" → ["iPhone 12", "iPhone 12 Pro"]; "iPhone 13 Pro/Pro Max"
  // → ["iPhone 13 Pro", "iPhone 13 Pro Max"]. One part that fits several models.
  function expandNames(name) {
    const parts = String(name || "").split("/").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return parts;
    const first = parts[0];
    const brand = (first.match(/^(\D*?)(?=\d)/) || [, ""])[1];
    const upToNumber = (first.match(/^(.*?\d+\w*)/) || [, first])[1];
    return [first, ...parts.slice(1).map((p) => (/^\d/.test(p) ? `${brand}${p}` : `${upToNumber} ${p}`))];
  }
  // What the Prices tab would show for a search, reduced to one model when
  // the search clearly means one (vague searches like "iphone" are skipped).
  function modelForSearch(query) {
    const q = String(query || "").trim().toLowerCase();
    if (q.length < 2) return null;
    const exact = modelIndex.find((m) => m.key === keyOf(q));
    if (exact) return exact.model;
    const matches = modelIndex.filter((m) => m.model.name.toLowerCase().includes(q)).map((m) => m.model);
    if (!matches.length || matches.length > 3) return null;
    return matches.sort((a, b) => a.name.length - b.name.length)[0];
  }
  const priceFor = (model, part) => {
    const entry = (model?.prices || []).find((p) => part.re.test(p.type));
    const n = entry ? parseFloat(String(entry.value).replace(/[^0-9.]/g, "")) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  /* ---- Engine -------------------------------------------------------- */
  function median(list) {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function compute({ tickets, orders, inventory, searches, days, coverDays }) {
    buildModelIndex();
    const since = Date.now() - days * DAY;
    const rows = new Map(); // `${model}|${part}` → row
    const rowFor = (model, part) => {
      const id = `${model.name}|${part.key}`;
      if (!rows.has(id)) {
        rows.set(id, {
          id, model, part, repairs: 0, searches: 0, searchEst: 0, stock: 0, tracked: false,
          stockItems: [], onOrder: 0, lastCost: null, lastVendor: "", lastOrderedAt: 0, quality: "",
        });
      }
      return rows.get(id);
    };

    // Demand: repairs logged in the period.
    const repairsByModel = new Map();
    const partTotals = new Map();
    for (const t of tickets) {
      if (t.status === "Cancelled") continue;
      const created = new Date(t.created).getTime();
      if (!(created >= since)) continue;
      const model = modelFor(t.device);
      if (!model) continue;
      const seen = new Set();
      for (const issue of String(t.issues || "").split(",")) {
        const part = partFor(issue);
        if (!part || seen.has(part.key)) continue;
        seen.add(part.key);
        rowFor(model, part).repairs += 1;
        repairsByModel.set(model.name, (repairsByModel.get(model.name) || 0) + 1);
        partTotals.set(part.key, (partTotals.get(part.key) || 0) + 1);
      }
    }

    // Demand: searches → one model → spread over the parts it usually needs.
    const totalRepairs = [...partTotals.values()].reduce((a, b) => a + b, 0);
    let searchesCounted = 0;
    const searchesByModel = new Map();
    for (const s of searches) {
      const model = modelForSearch(s.query);
      if (!model) continue;
      searchesCounted += s.count;
      searchesByModel.set(model.name, (searchesByModel.get(model.name) || 0) + s.count);
    }
    for (const [name, count] of searchesByModel) {
      const model = modelIndex.find((m) => m.model.name === name)?.model;
      if (!model) continue;
      // Parts this model has a price for; weight by its own repairs, else the shop's mix.
      const offered = PARTS.filter((p) => priceFor(model, p) != null);
      if (!offered.length) continue;
      // The model's own repairs, smoothed with the shop-wide mix so one
      // charging-port job doesn't send every search to charging ports.
      const weights = offered.map((p) => {
        const own = rows.get(`${model.name}|${p.key}`)?.repairs || 0;
        const shop = totalRepairs ? (partTotals.get(p.key) || 0) / totalRepairs : 1 / offered.length;
        return own + 2 * shop;
      });
      const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
      offered.forEach((p, i) => {
        const row = rowFor(model, p);
        row.searches = count;
        row.searchEst += count * SEARCH_CONVERSION * (weights[i] / weightSum);
      });
    }

    // Supply: inventory sheet (SCREENS, BATTERIES, …).
    const stocked = []; // { item, part, stock, rows } — for "not moving"
    for (const item of inventory) {
      const part = partBySection(item.section);
      if (!part) continue;
      const available = Math.max(0, Number(item.quantity || 0) - (/sold/i.test(item.note || "") ? 1 : 0));
      const entry = { item, part, stock: available, rows: [] };
      stocked.push(entry);
      for (const name of expandNames(item.device || item.item)) {
        const model = modelFor(name);
        if (!model) continue;
        const row = rowFor(model, part);
        entry.rows.push(row);
        row.tracked = true;
        row.stock += available;
        row.stockItems.push(item);
        if (!row.quality && item.quality) row.quality = item.quality;
      }
    }

    // Supply + timing: parts orders.
    const leadByPart = new Map();
    const leadAll = [];
    for (const o of orders) {
      if (o.status === "cancelled") continue;
      const part = partFor(o.part);
      const model = part ? modelFor(o.part) : null;
      const ordered = new Date(o.orderedAt).getTime();
      if (o.status === "arrived" && o.arrivedAt && ordered) {
        const lead = (new Date(o.arrivedAt).getTime() - ordered) / DAY;
        if (lead >= 0 && lead < 120) {
          leadAll.push(lead);
          if (part) leadByPart.set(part.key, [...(leadByPart.get(part.key) || []), lead]);
        }
      }
      if (!part || !model) continue;
      const row = rowFor(model, part);
      if (o.status === "ordered" || o.status === "backordered") row.onOrder += Number(o.quantity || 0);
      if (ordered > row.lastOrderedAt && o.unitCost > 0) {
        row.lastOrderedAt = ordered;
        row.lastCost = Number(o.unitCost);
        row.lastVendor = o.vendor || "";
      }
    }
    const globalLead = median(leadAll) ?? DEFAULT_LEAD_DAYS;

    // Suggestions.
    const suggestions = [];
    const slow = [];
    for (const row of rows.values()) {
      const lead = Math.min(45, Math.max(1, Math.round(median(leadByPart.get(row.part.key) || []) ?? globalLead)));
      const demand = row.repairs + row.searchEst;
      const perDay = demand / days;
      const need = perDay * (lead + coverDays);
      const available = row.stock + row.onOrder;
      let target = Math.ceil(need - 0.5);
      // Keep one on hand for anything that comes up regularly, even when the
      // rate alone rounds down to zero.
      if (target < 1 && (row.repairs >= 2 || demand >= 1.2)) target = 1;
      const qty = Math.max(0, target - available);
      Object.assign(row, { lead, demand, perDay, need, available, price: priceFor(row.model, row.part) });
      if (qty > 0) {
        row.qty = qty;
        row.daysLeft = perDay > 0 ? available / perDay : Infinity;
        row.urgency = available <= 0 ? "out" : row.daysLeft < lead ? "soon" : "top-up";
        row.lostPerWeek = row.urgency === "out" ? perDay * 7 : 0;
        suggestions.push(row);
      }
    }
    // Stock with no repairs or searches on any model it fits.
    for (const entry of stocked) {
      if (entry.stock < 1 || !entry.rows.length) continue;
      if (entry.rows.some((r) => r.repairs > 0 || r.searches > 0)) continue;
      const cost = entry.rows.find((r) => r.lastCost)?.lastCost || null;
      slow.push({ name: entry.item.device || entry.item.item, part: entry.part, quality: entry.item.quality || "", stock: entry.stock, lastCost: cost });
    }
    const urgencyRank = { out: 0, soon: 1, "top-up": 2 };
    suggestions.sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency] || b.demand - a.demand);
    slow.sort((a, b) => b.stock - a.stock);
    const vendors = [...new Set(orders.map((o) => String(o.vendor || "").trim()).filter(Boolean))];
    return { suggestions, slow, vendors, globalLead: Math.round(globalLead), searchesCounted, totalRepairs };
  }

  /* ---- UI ------------------------------------------------------------ */
  const state = { loading: false, result: null, selected: new Set(), qty: new Map(), prefs: loadPrefs(), trackingSince: null };

  function loadPrefs() {
    try { return Object.assign({ days: 60, cover: 21 }, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); }
    catch (_) { return { days: 60, cover: 21 }; }
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (_) {} }

  function ensurePanel() {
    let panel = $("restockPanel");
    if (panel) return panel;
    const mount = $("restockMount");
    if (!mount) return null;
    panel = document.createElement("section");
    panel.id = "restockPanel";
    panel.className = "restock";
    panel.setAttribute("aria-labelledby", "restockTitle");
    panel.innerHTML = `
      <div class="restock-head">
        <div class="restock-title">
          <span class="restock-icon" aria-hidden="true"><svg class="icon"><use href="#i-inventory-flow"></use></svg></span>
          <span>
            <strong id="restockTitle">Smart restock</strong>
            <small id="restockHeadline">Checking what to reorder…</small>
          </span>
        </div>
        <div class="restock-controls">
          <label><span>Based on</span>
            <select id="restockDays" class="text-input">
              <option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option>
            </select>
          </label>
          <label><span>Keep in stock</span>
            <select id="restockCover" class="text-input">
              <option value="14">2 weeks</option><option value="21">3 weeks</option><option value="30">4 weeks</option>
            </select>
          </label>
          <button type="button" class="ghost-btn icon-btn" id="restockRefresh" aria-label="Refresh suggestions"><svg class="icon"><use href="#i-refresh"></use></svg></button>
        </div>
      </div>
      <div class="restock-body" id="restockBody">
        <p class="restock-note" id="restockNote"></p>
        <div class="restock-list" id="restockList"></div>
        <div class="restock-actions" id="restockActions" hidden>
          <span id="restockSelection"></span>
          <label class="restock-vendor"><span>Supplier</span><input type="text" class="text-input" id="restockVendor" list="restockVendors" autocomplete="off" placeholder="e.g. MobileSentrix" /></label>
          <datalist id="restockVendors"></datalist>
          <button type="button" class="ghost-btn" id="restockCopy"><svg class="icon"><use href="#i-clipboard"></use></svg>Copy order list</button>
          <button type="button" class="ghost-btn" id="restockShare"><svg class="icon"><use href="#i-chat"></use></svg>Send to supplier</button>
          <button type="button" class="primary-btn" id="restockRecord"><svg class="icon"><use href="#i-check"></use></svg>Record as ordered</button>
        </div>
        <details class="restock-slow" id="restockSlow" hidden>
          <summary id="restockSlowSummary"></summary>
          <div id="restockSlowList"></div>
        </details>
        <p class="field-error" id="restockError" hidden></p>
      </div>`;
    mount.appendChild(panel);
    bindPanel();
    return panel;
  }

  function bindPanel() {
    $("restockDays").value = String(state.prefs.days);
    $("restockCover").value = String(state.prefs.cover);
    $("restockDays").addEventListener("change", () => { state.prefs.days = Number($("restockDays").value); savePrefs(); refresh(); });
    $("restockCover").addEventListener("change", () => { state.prefs.cover = Number($("restockCover").value); savePrefs(); refresh(); });
    $("restockRefresh").addEventListener("click", () => refresh({ force: true }));
    $("restockList").addEventListener("change", (e) => {
      const box = e.target.closest("[data-restock-pick]");
      if (box) {
        if (box.checked) state.selected.add(box.dataset.restockPick); else state.selected.delete(box.dataset.restockPick);
        renderActions();
      }
      const qty = e.target.closest("[data-restock-qty]");
      if (qty) {
        const n = Math.max(1, Math.min(99, Math.round(Number(qty.value) || 1)));
        qty.value = n;
        state.qty.set(qty.dataset.restockQty, n);
        renderActions();
      }
    });
    $("restockVendor").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
    $("restockCopy").addEventListener("click", copyList);
    $("restockShare").addEventListener("click", shareList);
    $("restockRecord").addEventListener("click", recordOrdered);
  }

  const qtyOf = (row) => state.qty.get(row.id) ?? row.qty;
  const selectedRows = () => (state.result?.suggestions || []).filter((r) => state.selected.has(r.id));
  const partName = (row) => `${row.model.name} ${row.part.label.toLowerCase()}${row.quality ? ` (${row.quality})` : ""}`;

  function reasonHtml(row) {
    const bits = [];
    if (row.repairs) bits.push(`Repaired ${row.repairs}×`);
    if (row.searches) bits.push(`Searched ${row.searches}×`);
    bits.push(row.tracked ? `${row.stock} in stock` : "Not in inventory sheet");
    if (row.onOrder) bits.push(`${row.onOrder} on order`);
    bits.push(`~${row.lead} day${row.lead === 1 ? "" : "s"} to arrive`);
    return bits.map(esc).join(" · ");
  }

  function render() {
    const result = state.result;
    if (!result) return;
    const { suggestions, slow } = result;
    const list = $("restockList");
    const days = state.prefs.days;
    const outCount = suggestions.filter((s) => s.urgency === "out").length;
    const estCost = suggestions.reduce((sum, s) => sum + (s.lastCost || 0) * s.qty, 0);
    $("restockHeadline").textContent = suggestions.length
      ? `${suggestions.length} part${suggestions.length === 1 ? "" : "s"} worth ordering${outCount ? ` · ${outCount} out of stock with demand` : ""}${estCost ? ` · about ${money(estCost)}` : ""}`
      : "Nothing needs reordering right now";

    const trackingDays = state.trackingSince ? Math.floor((Date.now() - new Date(state.trackingSince).getTime()) / DAY) : 0;
    $("restockNote").textContent = [
      `Based on ${result.totalRepairs} repair part${result.totalRepairs === 1 ? "" : "s"} and ${result.searchesCounted} price search${result.searchesCounted === 1 ? "" : "es"} in the last ${days} days, stock in the inventory sheet, parts on order, and a typical ${result.globalLead}-day delivery.`,
      !state.trackingSince || trackingDays < days ? `Price-search tracking started ${trackingDays > 0 ? `${trackingDays} day${trackingDays === 1 ? "" : "s"} ago` : "today"} — suggestions get sharper as searches build up.` : "",
    ].filter(Boolean).join(" ");

    if (!suggestions.length) {
      list.innerHTML = `<p class="restock-empty">You're stocked for the next ${Math.round(state.prefs.cover / 7)} weeks based on recent demand. 👍</p>`;
    } else {
      list.innerHTML = suggestions.map((row) => {
        const badge = row.urgency === "out"
          ? `<span class="restock-badge is-out">Out of stock</span>`
          : row.urgency === "soon"
            ? `<span class="restock-badge is-soon">Runs out in ~${Math.max(1, Math.round(row.daysLeft))} days</span>`
            : `<span class="restock-badge">Top up</span>`;
        return `<div class="restock-row${state.selected.has(row.id) ? " is-picked" : ""}">
          <label class="restock-pick"><input type="checkbox" data-restock-pick="${esc(row.id)}"${state.selected.has(row.id) ? " checked" : ""} aria-label="Select ${esc(partName(row))}" /></label>
          <div class="restock-main">
            <p class="restock-name">${esc(row.model.name)} <span>${esc(row.part.label)}${row.quality ? ` · ${esc(row.quality)}` : ""}</span> ${badge}</p>
            <p class="restock-why">${reasonHtml(row)}</p>
          </div>
          <div class="restock-money">
            ${row.lastCost ? `<span>${esc(money(row.lastCost))} each${row.lastVendor ? ` · ${esc(row.lastVendor)}` : ""}</span>` : `<span class="muted">No past price</span>`}
            ${row.price ? `<span class="muted">Repair price ${esc(money(row.price))}</span>` : ""}
          </div>
          <label class="restock-qty"><span>Order</span><input type="number" min="1" max="99" inputmode="numeric" class="text-input" data-restock-qty="${esc(row.id)}" value="${esc(qtyOf(row))}" aria-label="How many ${esc(partName(row))} to order" /></label>
        </div>`;
      }).join("");
    }

    $("restockVendors").innerHTML = (result.vendors || []).map((v) => `<option value="${esc(v)}"></option>`).join("");
    const slowBox = $("restockSlow");
    slowBox.hidden = !slow.length;
    if (slow.length) {
      const units = slow.reduce((a, r) => a + r.stock, 0);
      $("restockSlowSummary").textContent = `Not moving: ${slow.length} item${slow.length === 1 ? "" : "s"} (${units} unit${units === 1 ? "" : "s"}) with no repairs or searches in ${days} days`;
      $("restockSlowList").innerHTML = slow.map((r) => `<p><strong>${esc(r.name)}</strong> ${esc(r.part.label.toLowerCase())}${r.quality ? ` · ${esc(r.quality)}` : ""} — ${r.stock} in stock${r.lastCost ? ` (~${esc(money(r.lastCost * r.stock))} tied up)` : ""}</p>`).join("");
    }
    renderActions();
  }

  function renderActions() {
    const rows = selectedRows();
    $("restockActions").hidden = !rows.length;
    if (!rows.length) return;
    const vendorInput = $("restockVendor");
    if (!vendorInput.dataset.touched) vendorInput.value = rows.find((r) => r.lastVendor)?.lastVendor || "";
    const units = rows.reduce((a, r) => a + qtyOf(r), 0);
    const cost = rows.reduce((a, r) => a + (r.lastCost || 0) * qtyOf(r), 0);
    $("restockSelection").textContent = `${rows.length} selected · ${units} unit${units === 1 ? "" : "s"}${cost ? ` · about ${money(cost)}` : ""}`;
    document.querySelectorAll(".restock-row").forEach((el) => {
      const box = el.querySelector("[data-restock-pick]");
      el.classList.toggle("is-picked", !!box?.checked);
    });
  }

  function orderText(rows) {
    const date = new Date().toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    return [`Parts order — JQ Electronics (${date})`, "", ...rows.map((r) => `• ${partName(r)} × ${qtyOf(r)}`), "", "Please confirm prices and availability. Thank you!"].join("\n");
  }

  async function copyList() {
    const text = orderText(selectedRows());
    try {
      await navigator.clipboard.writeText(text);
      toast("Order list copied — paste it into WhatsApp or email to your supplier.");
    } catch (_) {
      window.prompt("Copy the order list:", text);
    }
  }

  async function shareList() {
    const text = orderText(selectedRows());
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === "AbortError") return; }
    }
    window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
  }

  async function recordOrdered() {
    const rows = selectedRows();
    if (!rows.length) return;
    const vendor = $("restockVendor").value;
    const btn = $("restockRecord");
    btn.disabled = true;
    $("restockError").hidden = true;
    const batchId = "RS" + Date.now().toString(36).toUpperCase();
    const shipmentName = `Restock ${new Date().toLocaleDateString([], { day: "numeric", month: "short" })}`;
    let done = 0;
    try {
      for (const r of rows) {
        await post(INTAKE_URL, {
          action: "addPartsOrder",
          batchId,
          shipmentName,
          vendor: vendor.trim(),
          part: partName(r),
          quantity: qtyOf(r),
          unitCost: r.lastCost || 0,
          status: "ordered",
          source: "restock",
          notes: "Added from Smart restock.",
        });
        done++;
      }
      toast(`Recorded ${done} part${done === 1 ? "" : "s"} as ordered.`);
      state.selected.clear();
      state.qty.clear();
      delete $("restockVendor").dataset.touched;
      if (typeof window.RPC_PARTS_ORDERS_RELOAD === "function") await window.RPC_PARTS_ORDERS_RELOAD();
      await refresh({ force: true });
    } catch (err) {
      $("restockError").textContent = `Recorded ${done} of ${rows.length} — ${err.message || err}`;
      $("restockError").hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function toast(message) {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message, { tone: "info", duration: 4000 });
  }

  let cache = null; // { at, tickets, orders, inventory, demandByDays }
  async function refresh({ force = false } = {}) {
    if (!ensurePanel() || state.loading) return;
    if (!pin()) {
      $("restockHeadline").textContent = "Connect this browser (Settings) to see suggestions";
      return;
    }
    state.loading = true;
    $("restockError").hidden = true;
    try {
      const fresh = force || !cache || Date.now() - cache.at > 5 * 60000;
      if (fresh) {
        const [tickets, ordersRes, inventoryRes] = await Promise.all([
          listTickets(),
          post(INTAKE_URL, { action: "listPartsOrders" }),
          typeof window.RPC_LOAD_INVENTORY === "function" ? window.RPC_LOAD_INVENTORY({ force: false }) : Promise.resolve({ items: [] }),
        ]);
        cache = { at: Date.now(), tickets, orders: ordersRes.partsOrders || [], inventory: inventoryRes.items || [], demand: new Map() };
      }
      const days = state.prefs.days;
      if (!cache.demand.has(days)) {
        const demand = await post(PRICES_URL, { action: "searchDemand", days }).catch(() => ({ searches: [] }));
        cache.demand.set(days, demand);
      }
      const demand = cache.demand.get(days);
      state.trackingSince = demand.trackingSince || null;
      if (!Array.isArray(window.RPC_PRICE_MODELS) || !window.RPC_PRICE_MODELS.length) {
        // The price list loads with the Prices tab; wait for it.
        await new Promise((resolve) => {
          window.addEventListener("rpc-price-models", resolve, { once: true });
          setTimeout(resolve, 8000);
        });
      }
      state.result = compute({
        tickets: cache.tickets,
        orders: cache.orders,
        inventory: cache.inventory,
        searches: demand.searches || [],
        days,
        coverDays: state.prefs.cover,
      });
      render();
    } catch (err) {
      $("restockError").textContent = "Couldn't work out suggestions: " + (err.message || err);
      $("restockError").hidden = false;
    } finally {
      state.loading = false;
    }
  }

  const restockShown = () => {
    const section = document.querySelector('[data-parts-panel-section="restock"]');
    return !!section && !section.hidden;
  };
  window.addEventListener("rpc-enter-restock", () => refresh());
  // Coming back to Parts orders while this sub-tab is the open one.
  window.addEventListener("rpc-enter-parts-orders", () => { if (restockShown()) refresh(); });
  // For other screens (e.g. a dashboard nudge) and testing.
  window.RPC_RESTOCK = { refresh, compute, expandNames, modelForSearch };
})();
