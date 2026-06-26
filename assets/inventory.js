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
    const box = $("inventoryChips");
    if (!box) return;
    const counts = new Map();
    ITEMS.forEach((item) => counts.set(item.section, (counts.get(item.section) || 0) + 1));
    const chips = [{ key: "all", label: "All", count: ITEMS.length }].concat(
      sections.map((section) => ({ key: section, label: titleCase(section), count: counts.get(section) || 0 }))
    );
    box.innerHTML = chips.map((chip) =>
      `<button type="button" class="chip ${chip.key === activeSection ? "active" : ""}" data-section="${esc(chip.key)}">${esc(chip.label)} (${chip.count})</button>`
    ).join("");
    box.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeSection = btn.dataset.section || "all";
        render();
      });
    });
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
      ? `Showing ${list.length} item${list.length === 1 ? "" : "s"}`
      : "";
    $("inventoryEmpty").hidden = list.length > 0 || !loadedOnce;
    $("inventoryList").innerHTML = list.map(inventoryCardHtml).join("");
    $("clearInventorySearch").hidden = !($("inventorySearch").value || "").trim();
  }

  function inventoryCardHtml(item) {
    const status = item.quantity <= 0 ? "out" : item.quantity <= 1 ? "low" : "ok";
    const statusLabel = item.quantity <= 0 ? "Out of stock" : item.quantity <= 1 ? "Low stock" : "In stock";
    return `<article class="inventory-card inventory-${status}">
      <div class="inventory-main">
        <span class="inventory-section">${esc(titleCase(item.section))}</span>
        <h3>${esc(item.item || item.label || "Inventory item")}</h3>
        ${item.quality ? `<p>${esc(item.quality)}</p>` : ""}
        ${item.note ? `<p class="inventory-note">${esc(item.note)}</p>` : ""}
      </div>
      <div class="inventory-qty">
        <span class="inventory-qty-num">${esc(String(item.quantity))}</span>
        <span class="inventory-qty-label">${esc(statusLabel)}</span>
      </div>
    </article>`;
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
