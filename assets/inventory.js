/* ============================================================
   Inventory checker — reads the inventory tab through /api/inventory
   and exposes the latest items to the Check In form.
   ============================================================ */

(function () {
  const INVENTORY_URL = "https://pricechecker-cyan.vercel.app/api/inventory";
  const AUTO_REFRESH_MS = 60 * 1000;
  const $ = (id) => document.getElementById(id);

  let ITEMS = [];
  let sections = [];
  let activeSection = "all";
  let lastUpdated = null;
  let loadedOnce = false;
  let loadInFlight = null;

  function publishInventory() {
    window.RPC_INVENTORY_ITEMS = ITEMS.slice();
    window.dispatchEvent(new CustomEvent("rpc-inventory", { detail: { items: ITEMS.slice() } }));
  }

  async function loadInventory({ force = false } = {}) {
    if (loadInFlight) return loadInFlight;
    if (loadedOnce && !force) {
      publishInventory();
      return { items: ITEMS, sections };
    }
    loadInFlight = (async () => {
      setStatus("loading");
      try {
        const res = await fetch(INVENTORY_URL + "?_=" + Date.now(), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Rejected");
        ITEMS = (data.items || []).map(normalizeItem);
        sections = data.sections || [...new Set(ITEMS.map((item) => item.section))];
        lastUpdated = Date.now();
        loadedOnce = true;
        publishInventory();
        render();
        setStatus("live");
        $("inventoryError").hidden = true;
        return { items: ITEMS, sections };
      } catch (err) {
        console.error("Inventory load failed:", err);
        setStatus("error");
        $("inventoryError").hidden = false;
        $("inventoryErrorSub").textContent = "Couldn't load inventory (" + err.message + ").";
        return { items: ITEMS, sections };
      } finally {
        loadInFlight = null;
      }
    })();
    return loadInFlight;
  }

  window.RPC_LOAD_INVENTORY = loadInventory;

  function normalizeItem(item) {
    return Object.assign({}, item, {
      key: item.key || "",
      section: item.section || "OTHER",
      item: item.item || item.device || "",
      device: item.device || "",
      quality: item.quality || "",
      note: item.note || "",
      quantity: Number(item.quantity || 0),
      label: item.label || [item.item || item.device || "", item.quality || ""].filter(Boolean).join(" · "),
    });
  }

  function setStatus(state) {
    const dot = $("inventoryStatusDot");
    const updated = $("inventoryUpdated");
    if (!dot || !updated) return;
    dot.className = "status-dot";
    if (state === "error") dot.classList.add("error");
    else if (state === "loading") dot.classList.add("stale");
    if (state === "error") updated.textContent = "Inventory sync failed";
    else if (!lastUpdated) updated.textContent = "Loading inventory…";
    else updated.textContent = "Updated " + relativeTime(lastUpdated);
  }

  function relativeTime(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  }

  function renderChips() {
    const select = $("inventorySectionFilter");
    if (!select) return;
    const counts = new Map();
    ITEMS.forEach((item) => counts.set(item.section, (counts.get(item.section) || 0) + 1));
    const filters = [{ key: "all", label: "All", count: ITEMS.length }].concat(
      sections.map((section) => ({ key: section, label: titleCase(section), count: counts.get(section) || 0 }))
    );
    const current = activeSection;
    select.innerHTML = filters.map((filter) =>
      `<option value="${esc(filter.key)}">${esc(filter.label)} (${filter.count})</option>`
    ).join("");
    select.value = filters.some((filter) => filter.key === current) ? current : "all";
  }

  function filteredItems() {
    const q = ($("inventorySearch")?.value || "").trim().toLowerCase();
    return ITEMS.filter((item) => {
      if (activeSection !== "all" && item.section !== activeSection) return false;
      if (!q) return true;
      return [item.section, item.item, item.device, item.quality, item.note, item.label]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  function render() {
    if (!$("inventoryList")) return;
    renderChips();
    const list = filteredItems();
    $("inventoryCount").textContent = list.length
      ? `1-${list.length} of ${list.length}`
      : "";
    renderSummary(list);
    $("inventoryEmpty").hidden = list.length > 0 || !loadedOnce;
    $("inventoryList").innerHTML = list.map(inventoryRowHtml).join("");
    $("clearInventorySearch").hidden = !($("inventorySearch").value || "").trim();
  }

  function renderSummary(list) {
    const box = $("inventorySummary");
    if (!box) return;
    const source = list.length || ($("inventorySearch")?.value || activeSection !== "all") ? list : ITEMS;
    const total = source.length;
    const low = source.filter((item) => item.quantity > 0 && item.quantity <= 1).length;
    const out = source.filter((item) => item.quantity <= 0).length;
    const onHand = source.reduce((sum, item) => sum + item.quantity, 0);
    box.innerHTML = [
      summaryTile("Items", total),
      summaryTile("On hand", onHand),
      summaryTile("Low stock", low, "warn"),
      summaryTile("Out", out, "danger"),
    ].join("");
  }

  function summaryTile(label, value, tone = "") {
    return `<div class="inventory-summary-tile ${tone ? "is-" + tone : ""}">
      <span>${esc(label)}</span>
      <strong>${esc(String(value))}</strong>
    </div>`;
  }

  function inventoryRowHtml(item) {
    const status = item.quantity <= 0 ? "out" : item.quantity <= 1 ? "low" : "ok";
    const statusLabel = item.quantity <= 0 ? "Out of stock" : item.quantity <= 1 ? "Low stock" : "In stock";
    const product = item.item || item.label || "Inventory item";
    const avatarIcon = item.section === "TOOLS" ? "i-tools" : item.section === "BATTERIES" ? "i-cash" : "i-device";
    const unavailable = item.quantity <= 0 ? 1 : 0;
    const committed = item.note && /sold/i.test(item.note) ? 1 : 0;
    const available = Math.max(0, item.quantity - committed);
    return `<tr class="inventory-row inventory-${status}">
      <td data-label="Product">
        <div class="inventory-product">
          <span class="inventory-thumb"><svg class="icon"><use href="#${avatarIcon}"></use></svg></span>
          <span class="inventory-product-text">
            <strong>${esc(product)}</strong>
            <span class="inventory-product-meta">
              ${item.quality ? `<span class="inventory-pill">${esc(item.quality)}</span>` : `<span>${esc(titleCase(item.section))}</span>`}
              ${item.note ? `<span class="inventory-note">${esc(item.note)}</span>` : ""}
            </span>
          </span>
        </div>
      </td>
      <td data-label="Category"><span class="inventory-category">${esc(titleCase(item.section))}</span></td>
      <td data-label="Status"><span class="inventory-stock-status">${esc(statusLabel)}</span>${unavailable ? `<span class="inventory-unavailable">Unavailable ${unavailable}</span>` : ""}</td>
      <td class="num" data-label="Available">${available}</td>
      <td class="num" data-label="On hand">${esc(String(item.quantity))}</td>
    </tr>`;
  }

  function titleCase(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  $("inventorySearch")?.addEventListener("input", render);
  $("inventorySectionFilter")?.addEventListener("change", () => {
    activeSection = $("inventorySectionFilter").value || "all";
    render();
  });
  $("clearInventorySearch")?.addEventListener("click", () => {
    $("inventorySearch").value = "";
    render();
    $("inventorySearch").focus();
  });
  window.addEventListener("rpc-enter-inventory", () => loadInventory({ force: !loadedOnce }));
  setInterval(() => {
    if (!$("view-inventory")?.hidden) loadInventory({ force: true });
    if (lastUpdated) setStatus("live");
  }, AUTO_REFRESH_MS);
})();
