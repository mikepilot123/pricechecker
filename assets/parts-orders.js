/* ============================================================
   Parts orders — tracks parts ordered from suppliers, optionally linked to
   a customer and/or a repair ticket. Its own top-level tab (see index.html's
   data-target="partsOrders" nav button and #view-partsOrders), entered via
   the "rpc-enter-parts-orders" event assets/intake.js's navigateTo() fires.
   ============================================================ */
(function () {
  const INTAKE_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const INVENTORY_URL = "https://pricechecker-cyan.vercel.app/api/inventory";
  const LS_PIN = "rpc_intake_pin";
  const MAX_INLINE_PDF_BYTES = 2.5 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);

  const STATUS_LABELS = { ordered: "Ordered", backordered: "Backordered", arrived: "Arrived", cancelled: "Cancelled" };

  let PARTS_ORDERS = [];
  let tickets = [];
  let CUSTOMERS = [];
  let customersLoadStarted = false;
  // Which multi-part shipments are collapsed, keyed by batchId — expanded
  // by default, so a shipment only ends up here once someone hides it.
  let collapsedShipments = new Set();
  let statusFilter = "all";
  let searchQuery = "";
  let editingId = null;
  let saving = false;
  let inventorySaving = false;
  let inventoryTargetId = null;
  let linkModalTargetId = null;
  let bound = false;

  let reviewBatchId = null;
  let reviewUploadUrl = null;
  let reviewRows = [];
  let formTicketCombobox = null;
  let reviewTicketCombobox = null;

  function pin() {
    try { return localStorage.getItem(LS_PIN) || ""; } catch (_) { return ""; }
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function money(value) {
    return "$" + Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  async function partsOrderApi(payload) {
    const res = await fetch(INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: pin() }, payload)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Rejected");
    return data;
  }

  function notifyError(message) {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message);
    else console.warn(message);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read the selected PDF"));
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        if (comma < 0) return reject(new Error("Couldn't read the selected PDF"));
        resolve(result.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  // Backs the "Customer" name fields' autosuggest below — same shared
  // customer directory (lib/customers.js) the Log Device form uses, fetched
  // independently here since this panel can be opened without Repairs ever
  // having loaded it first.
  async function ensureCustomersLoaded() {
    if (customersLoadStarted) return;
    customersLoadStarted = true;
    try {
      const data = await partsOrderApi({ action: "listCustomers" });
      CUSTOMERS = data.customers || [];
    } catch (err) {
      customersLoadStarted = false;
    }
  }

  async function loadPartsOrders() {
    try {
      const data = await partsOrderApi({ action: "listPartsOrders" });
      PARTS_ORDERS = data.partsOrders || [];
      renderPartsOrders();
    } catch (err) {
      notifyError("Couldn't load parts orders: " + err.message);
    }
  }

  // Tickets normally arrive via the "rpc-tickets" broadcast (see the bottom
  // of this file) once assets/intake.js loads them for the Repairs tab —
  // but Parts orders is its own top-level tab now, so a visit here can
  // easily happen before Repairs ever has. Without this, an already-linked
  // part has nothing to look its customer/device name up from and falls
  // back to the generic "Linked repair" label, and match suggestions never
  // find anything to suggest. Fetched fresh on every visit so it's never
  // stale against a status change made elsewhere.
  async function loadTicketsForMatching() {
    try {
      const data = await partsOrderApi({ action: "list" });
      tickets = data.tickets || tickets;
      renderPartsOrders();
    } catch (err) {
      // Non-fatal — labels/matching just fall back gracefully.
    }
  }

  function filteredPartsOrders() {
    return PARTS_ORDERS.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (!searchQuery) return true;
      // A part linked to a repair usually has no customerName of its own —
      // that lives on the ticket — so search that too, or "search by
      // customer" would silently miss every linked part.
      const ticket = item.ticketId ? tickets.find((t) => t.id === item.ticketId) : null;
      return [item.part, item.vendor, item.customerName, item.notes, ticket?.customerName, ticket?.device, ticket?.phone]
        .some((v) => String(v || "").toLowerCase().includes(searchQuery));
    });
  }

  function renderStatusChips() {
    const box = $("partsOrderStatusChips");
    if (!box) return;
    const counts = PARTS_ORDERS.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const chips = [{ key: "all", label: "All", count: PARTS_ORDERS.length }].concat(
      Object.keys(STATUS_LABELS)
        .filter((key) => counts[key])
        .map((key) => ({ key, label: STATUS_LABELS[key], count: counts[key] }))
    );
    box.innerHTML = chips.map((c) => `
      <button type="button" class="inventory-stock-filter inventory-stock-filter-${esc(c.key)}${statusFilter === c.key ? " active" : ""}"
        data-parts-status-filter="${esc(c.key)}" role="tab" aria-selected="${statusFilter === c.key ? "true" : "false"}">
        <span class="inventory-stock-dot" aria-hidden="true"></span>${esc(c.label)} (${c.count})
      </button>
    `).join("");
  }

  function renderSummary() {
    const box = $("partsOrderSummary");
    if (!box) return;
    const openStatuses = new Set(["ordered", "backordered"]);
    const open = PARTS_ORDERS.filter((item) => openStatuses.has(item.status));
    const openTotal = open.reduce((sum, item) => sum + item.totalCost, 0);
    const arrived = PARTS_ORDERS.filter((item) => item.status === "arrived").length;
    box.innerHTML = [
      summaryTile("Orders", PARTS_ORDERS.length),
      summaryTile("Open cost", money(openTotal)),
      summaryTile("Pending", open.length, open.length ? "warn" : ""),
      summaryTile("Arrived", arrived),
    ].join("");
  }

  function summaryTile(label, value, tone = "") {
    return `<div class="inventory-summary-tile ${tone ? "is-" + tone : ""}">
      <span>${esc(label)}</span>
      <strong>${esc(String(value))}</strong>
    </div>`;
  }

  // ---- Repair matching: suggest a link to an in-progress repair whose
  // device name shows up in the ordered part's description, e.g. "OLED
  // Assembly ... For Google Pixel 6 Pro" -> a ticket with device "Google
  // Pixel 6 Pro". Only offered while a part isn't already linked. ----
  const CLOSED_TICKET_STATUSES = new Set([
    "Repaired", "Checked Out - Waiting on Client", "No Fix", "Picked Up", "Cancelled",
  ]);

  function normalizeMatchText(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function findMatchingTickets(item) {
    const partNorm = normalizeMatchText(item.part);
    if (!partNorm) return [];
    return tickets
      .filter((t) => t.device && !CLOSED_TICKET_STATUSES.has(t.status))
      .map((t) => ({ ticket: t, device: normalizeMatchText(t.device) }))
      .filter((m) => m.device.length >= 3 && partNorm.includes(m.device))
      .sort((a, b) => b.device.length - a.device.length)
      .map((m) => m.ticket)
      .filter((t, i, arr) => arr.findIndex((other) => other.id === t.id) === i)
      .slice(0, 3);
  }

  // ---- Ticket link display/lookup (tickets come from the app-wide
  // "rpc-tickets" broadcast — see assets/intake.js / assets/dashboard.js) ----
  function ticketLabel(t) {
    if (!t) return "";
    return `${t.customerName || "Unknown customer"} — ${t.device || "Device"}`;
  }

  function ticketLabelById(id) {
    return ticketLabel(tickets.find((t) => t.id === id));
  }

  // Linking a part to a repair means that repair is now blocked on a part
  // arriving, so reflect that on the ticket itself instead of leaving staff
  // to flip it by hand. Skipped for repairs already finished (or already
  // marked ordered) so this never resurrects or downgrades a closed ticket.
  async function markTicketPartOrdered(ticketId) {
    if (!ticketId) return;
    const ticket = tickets.find((t) => t.id === ticketId);
    if (ticket && (CLOSED_TICKET_STATUSES.has(ticket.status) || ticket.status === "Part Ordered")) return;
    try {
      await partsOrderApi({ action: "update", id: ticketId, status: "Part Ordered" });
      if (ticket) ticket.status = "Part Ordered";
      if (typeof window.RPC_RELOAD_TICKETS === "function") window.RPC_RELOAD_TICKETS();
    } catch (err) {
      notifyError("Linked, but couldn't update the repair's status: " + err.message);
    }
  }

  function linkedCellHtml(item) {
    if (item.inventoryStockState === "stocked") {
      const label = item.inventoryItemLabel || "Inventory item";
      const quantity = item.inventoryStockedQuantity || item.quantity;
      return `<span class="parts-order-inventory-chip" title="Added ${esc(quantity)} to ${esc(label)}">
        <svg class="icon"><use href="#i-inventory-flow"></use></svg><span class="parts-order-chip-label">In inventory · ${esc(label)}</span>
      </span>`;
    }
    if (item.ticketId) {
      const label = ticketLabelById(item.ticketId) || item.customerName || "Linked repair";
      return `<span class="parts-order-link-chip" title="${esc(label)}">
        <svg class="icon"><use href="#i-device"></use></svg><span class="parts-order-chip-label">${esc(label)}</span>
      </span>`;
    }
    if (item.status === "cancelled") {
      return item.customerName
        ? `<span class="parts-order-customer-text" title="${esc(item.customerName)}">${esc(item.customerName)}</span>`
        : `<span class="parts-order-empty-cell">—</span>`;
    }
    const matches = findMatchingTickets(item);
    const label = matches.length ? `Link to ${ticketLabel(matches[0])}${matches.length > 1 ? ` (+${matches.length - 1} more)` : ""}` : "Choose a repair";
    const repairButton = `<button type="button" class="parts-order-match parts-order-choose-repair" data-parts-choose-repair="${esc(item.id)}" title="${esc(label)}">
        <svg class="icon"><use href="#i-link"></use></svg><span class="parts-order-chip-label">Repair</span>
      </button>`;
    return `<div class="parts-order-destination-cell">
      ${item.customerName ? `<span class="parts-order-customer-text" title="${esc(item.customerName)}">${esc(item.customerName)}</span>` : ""}
      <div class="parts-order-match-list">
        ${repairButton}
        <button type="button" class="parts-order-inventory-option" data-parts-inventory="${esc(item.id)}" title="Add this order to inventory">
          <svg class="icon"><use href="#i-inventory-flow"></use></svg><span>Inventory</span>
        </button>
      </div>
    </div>`;
  }

  function paymentStatusButtonHtml(batchId, paymentStatus) {
    const collected = paymentStatus === "collected";
    return `<button type="button" class="parts-order-payment-btn ${collected ? "is-collected" : "is-pending"}" data-parts-toggle-payment="${esc(batchId)}" title="Click to mark ${collected ? "pending collection" : "payment collected"}">
      ${collected ? "Payment collected" : "Pending collection"}
    </button>`;
  }

  function partsOrderRowHtml(item, { grouped = false } = {}) {
    const canAdvance = !grouped && item.status !== "arrived" && item.status !== "cancelled";
    return `<tr class="inventory-row parts-order-row is-${esc(item.status)}${grouped ? " parts-order-shipment-item" : ""}">
      <td data-label="Part">
        <div class="inventory-product">
          <span class="inventory-thumb"><svg class="icon"><use href="#i-device"></use></svg></span>
          <span class="inventory-product-text">
            <strong>${esc(item.part)}</strong>
            ${item.notes ? `<span class="inventory-product-meta"><span class="inventory-note">${esc(item.notes)}</span></span>` : ""}
          </span>
        </div>
      </td>
      <td data-label="Vendor">${esc(item.vendor) || "—"}</td>
      <td data-label="Status"><span class="parts-order-status-badge parts-order-status-${esc(item.status)}">${esc(STATUS_LABELS[item.status] || item.status)}</span></td>
      <td data-label="Destination">${linkedCellHtml(item)}</td>
      <td class="num" data-label="Qty">${item.quantity}</td>
      <td class="num" data-label="Cost">
        <strong>${money(item.totalCost)}</strong>
        ${item.quantity > 1 ? `<span class="parts-order-cost-sub">${money(item.unitCost)} each</span>` : ""}
      </td>
      <td data-label="Ordered">${esc(formatDate(item.orderedAt))}</td>
      <td data-label="Actions">
        <div class="parts-order-actions">
          ${canAdvance ? `<button type="button" class="parts-order-arrived-btn" data-parts-arrived="${esc(item.id)}">Mark arrived</button>` : ""}
          ${!grouped ? paymentStatusButtonHtml(item.batchId || item.id, item.paymentStatus) : ""}
          <div class="parts-order-icon-actions">
            ${!grouped && item.sourceDocumentUrl ? `<a class="icon-btn ghost-btn" href="${esc(item.sourceDocumentUrl)}" target="_blank" rel="noopener" title="View order PDF" aria-label="View order PDF"><svg class="icon"><use href="#i-receipt"></use></svg></a>` : ""}
            <button type="button" class="icon-btn ghost-btn" data-parts-edit="${esc(item.id)}" title="Edit" aria-label="Edit"><svg class="icon"><use href="#i-pencil"></use></svg></button>
            <button type="button" class="icon-btn ghost-btn danger-btn" data-parts-delete="${esc(item.id)}" title="Delete" aria-label="Delete"><svg class="icon"><use href="#i-trash"></use></svg></button>
          </div>
        </div>
      </td>
    </tr>`;
  }

  // ---- Shipments: every part saved from the same PDF upload shares a
  // batchId (see saveReviewRows below); a manually-added part's batchId is
  // just its own id, so it never groups with anything else. Grouping here
  // is purely a render-time concern — nothing about batchId changes. ----
  function groupOrdersByBatch(list) {
    const order = [];
    const groups = new Map();
    for (const item of list) {
      const key = item.batchId || item.id;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key).push(item);
    }
    return order.map((key) => groups.get(key));
  }

  function toggleShipment(batchId) {
    if (!batchId) return;
    if (collapsedShipments.has(batchId)) collapsedShipments.delete(batchId);
    else collapsedShipments.add(batchId);
    renderPartsOrders();
  }

  function shipmentHeaderRowHtml(group, collapsed) {
    const batchId = group[0].batchId || group[0].id;
    const vendor = group.find((i) => i.vendor)?.vendor || "";
    // Nothing typed in for either at upload time: fall back to the first
    // part's own description rather than a bare "Shipment" label, so there's
    // still something to tell shipments apart by before anyone renames one.
    const shipmentName = group.find((i) => i.shipmentName)?.shipmentName || vendor || group[0].part || "Shipment";
    const total = group.reduce((sum, i) => sum + i.totalCost, 0);
    const pdfUrl = group.find((i) => i.sourceDocumentUrl)?.sourceDocumentUrl || null;
    const pending = group.filter((i) => i.status !== "arrived" && i.status !== "cancelled");
    return `<tr class="parts-order-shipment-header">
      <td colspan="8">
        <div class="parts-order-shipment-bar">
          <button type="button" class="parts-order-shipment-info" data-parts-toggle-shipment="${esc(batchId)}" aria-expanded="${collapsed ? "false" : "true"}">
            <svg class="icon parts-order-shipment-chevron${collapsed ? " is-collapsed" : ""}"><use href="#i-chevron-down"></use></svg>
            <svg class="icon"><use href="#i-receipt"></use></svg>
            <span>
              <strong>${esc(shipmentName)}</strong>
              <small>${group.length} part${group.length === 1 ? "" : "s"} · ${money(total)} · ${esc(formatDate(group[0].orderedAt))}</small>
            </span>
          </button>
          <div class="parts-order-shipment-actions">
            ${paymentStatusButtonHtml(batchId, group[0].paymentStatus)}
            <button type="button" class="icon-btn ghost-btn" data-parts-rename-shipment="${esc(batchId)}" title="Rename shipment" aria-label="Rename shipment"><svg class="icon"><use href="#i-pencil"></use></svg></button>
            ${pdfUrl ? `<a class="icon-btn ghost-btn" href="${esc(pdfUrl)}" target="_blank" rel="noopener" title="View order PDF" aria-label="View order PDF"><svg class="icon"><use href="#i-receipt"></use></svg></a>` : ""}
            ${pending.length
              ? `<button type="button" class="parts-order-arrived-btn" data-parts-arrive-shipment="${esc(batchId)}">Mark shipment arrived</button>`
              : `<span class="parts-order-status-badge parts-order-status-arrived">All arrived</span>`}
          </div>
        </div>
      </td>
    </tr>`;
  }

  function renderPartsOrders() {
    const list = $("partsOrderList");
    if (!list) return;
    renderStatusChips();
    renderSummary();
    const visible = filteredPartsOrders();
    const count = $("partsOrderCount");
    if (count) {
      count.textContent = PARTS_ORDERS.length
        ? `${visible.length} of ${PARTS_ORDERS.length} order${PARTS_ORDERS.length === 1 ? "" : "s"}`
        : "";
    }
    // Every batch — a single manually-added part included — gets the same
    // collapsible header-with-chevron treatment, so the table reads
    // consistently instead of some rows floating loose above named groups.
    list.innerHTML = groupOrdersByBatch(visible).map((group) => {
      const batchId = group[0].batchId || group[0].id;
      const collapsed = collapsedShipments.has(batchId);
      const header = shipmentHeaderRowHtml(group, collapsed);
      return collapsed ? header : header + group.map((item) => partsOrderRowHtml(item, { grouped: true })).join("");
    }).join("");
    const empty = $("partsOrderEmpty");
    if (empty) {
      empty.hidden = visible.length > 0;
      const title = $("partsOrderEmptyTitle");
      if (title) title.textContent = PARTS_ORDERS.length ? "No parts match the current filters" : "No parts ordered yet";
    }
  }

  /* ---- Manual add/edit modal ------------------------------------------ */
  function openPartsOrderForm(item) {
    editingId = item ? item.id : null;
    $("partsOrderFormTitle").textContent = item ? "Edit part" : "Add part";
    $("partsOrderSubmit").textContent = item ? "Save changes" : "Add part";
    $("partsOrderId").value = item ? item.id : "";
    $("partsOrderPart").value = item ? item.part : "";
    $("partsOrderVendor").value = item ? item.vendor : "";
    $("partsOrderStatus").value = item ? item.status : "ordered";
    $("partsOrderQuantity").value = item ? item.quantity : 1;
    $("partsOrderUnitCost").value = item ? item.unitCost.toFixed(2) : "";
    $("partsOrderCustomerName").value = item ? item.customerName : "";
    $("partsOrderCustomerPhone").value = item ? item.customerPhone : "";
    $("partsOrderNotes").value = item ? item.notes : "";
    formTicketCombobox?.set(item?.ticketId || "", item?.ticketId ? ticketLabelById(item.ticketId) : "");
    $("partsOrderMessage").hidden = true;
    $("partsOrderFormModal").hidden = false;
    ensureCustomersLoaded();
    $("partsOrderPart").focus();
  }

  function closePartsOrderForm() {
    if (saving) return;
    $("partsOrderFormModal").hidden = true;
  }

  /* ---- Link-to-repair modal: lists candidate repairs (from
     findMatchingTickets) as clickable rows, plus a text search across all
     tickets for when there are no candidates. Nothing here auto-links or
     auto-advances — every link is a deliberate click. ---- */
  function ticketRowHtml(t) {
    return `<button type="button" class="device-option parts-order-link-row" data-ticket-id="${esc(t.id)}">
      ${esc(ticketLabel(t))} <span class="rem-notes">#${esc(t.id)}</span>
    </button>`;
  }

  function renderLinkSearchResults(query) {
    const results = $("partsOrderLinkResults");
    const empty = $("partsOrderLinkEmpty");
    if (!results) return;
    const q = query.trim().toLowerCase();
    const matches = q
      ? tickets
          .filter((t) => [t.customerName, t.device, t.phone, t.id].some((v) => String(v || "").toLowerCase().includes(q)))
          .slice(0, 20)
      : [];
    results.innerHTML = matches.map(ticketRowHtml).join("");
    if (empty) empty.hidden = !q || matches.length > 0;
  }

  function openLinkModal(id) {
    const item = PARTS_ORDERS.find((part) => part.id === id);
    if (!item) return;
    linkModalTargetId = id;
    const title = $("partsOrderLinkTitle");
    if (title) title.textContent = `Link "${item.part}" to a repair`;
    const matches = findMatchingTickets(item);
    const suggested = $("partsOrderLinkSuggested");
    if (suggested) suggested.innerHTML = matches.map(ticketRowHtml).join("");
    const suggestedLabel = $("partsOrderLinkSuggestedLabel");
    if (suggestedLabel) suggestedLabel.hidden = matches.length === 0;
    const search = $("partsOrderLinkSearch");
    if (search) search.value = "";
    renderLinkSearchResults("");
    $("partsOrderLinkModal").hidden = false;
    requestAnimationFrame(() => {
      if (!matches.length) search?.focus();
    });
  }

  function closeLinkModal() {
    $("partsOrderLinkModal").hidden = true;
    linkModalTargetId = null;
  }

  function handleLinkModalClick(event) {
    const row = event.target.closest("[data-ticket-id]");
    if (!row || !linkModalTargetId) return;
    const id = linkModalTargetId;
    const ticketId = row.dataset.ticketId;
    closeLinkModal();
    linkPartsOrderToTicket(id, ticketId);
  }

  function inventoryOptionHtml(item) {
    return `<option value="${esc(item.key)}">${esc(item.label || item.item)} — ${esc(item.section)} (in stock: ${Number(item.quantity || 0)})</option>`;
  }

  function syncInventoryMode() {
    const isNew = $("partsOrderInventoryMode")?.value === "new";
    $("partsOrderInventoryExistingFields").hidden = isNew;
    $("partsOrderInventoryNewFields").hidden = !isNew;
    $("partsOrderInventoryItem").required = !isNew;
    $("partsOrderInventorySection").required = isNew;
    $("partsOrderInventoryNewItem").required = isNew;
  }

  async function openInventoryModal(id) {
    const item = PARTS_ORDERS.find((part) => part.id === id);
    if (!item || item.ticketId || item.inventoryStockState === "stocked") return;
    inventoryTargetId = id;
    $("partsOrderInventoryTitle").textContent = "Add ordered part to inventory";
    $("partsOrderInventoryContext").textContent = `${item.quantity} × ${item.part} will be added to stock and marked arrived.`;
    $("partsOrderInventoryMode").value = "existing";
    $("partsOrderInventoryNewItem").value = item.part;
    $("partsOrderInventoryQuality").value = "";
    $("partsOrderInventoryMessage").hidden = true;
    $("partsOrderInventoryModal").hidden = false;
    syncInventoryMode();

    const select = $("partsOrderInventoryItem");
    const sectionSelect = $("partsOrderInventorySection");
    select.disabled = true;
    select.innerHTML = `<option value="">Loading inventory…</option>`;
    try {
      const data = typeof window.RPC_LOAD_INVENTORY === "function"
        ? await window.RPC_LOAD_INVENTORY({ force: true })
        : { items: window.RPC_INVENTORY_ITEMS || [], sections: [] };
      const inventoryChoices = (data.items || window.RPC_INVENTORY_ITEMS || []).filter((candidate) => candidate.key);
      const inventorySections = (data.sections || [...new Set(inventoryChoices.map((candidate) => candidate.section))]).filter(Boolean);
      const grouped = new Map();
      inventoryChoices.forEach((candidate) => {
        if (!grouped.has(candidate.section)) grouped.set(candidate.section, []);
        grouped.get(candidate.section).push(candidate);
      });
      select.innerHTML = `<option value="">Choose an inventory item…</option>` + [...grouped.entries()].map(([section, choices]) =>
        `<optgroup label="${esc(section)}">${choices.sort((a, b) => String(a.label).localeCompare(String(b.label))).map(inventoryOptionHtml).join("")}</optgroup>`
      ).join("");
      sectionSelect.innerHTML = `<option value="">Choose a section…</option>` + inventorySections.map((section) =>
        `<option value="${esc(section)}">${esc(section)}</option>`).join("");
      select.disabled = false;
      if (!inventoryChoices.length && !inventorySections.length) {
        throw new Error("No inventory sections are available");
      }
      select.focus();
    } catch (err) {
      select.disabled = true;
      $("partsOrderInventoryMessage").textContent = "Couldn't load inventory: " + err.message;
      $("partsOrderInventoryMessage").hidden = false;
    }
  }

  function closeInventoryModal() {
    if (inventorySaving) return;
    $("partsOrderInventoryModal").hidden = true;
    inventoryTargetId = null;
  }

  async function stockPartsOrder(event) {
    event?.preventDefault();
    if (inventorySaving || !inventoryTargetId) return;
    const form = $("partsOrderInventoryForm");
    if (!form.reportValidity()) return;
    const isNew = $("partsOrderInventoryMode").value === "new";
    const payload = { action: "stockPartsOrder", pin: pin(), partsOrderId: inventoryTargetId };
    if (isNew) {
      payload.section = $("partsOrderInventorySection").value;
      payload.item = $("partsOrderInventoryNewItem").value.trim();
      payload.quality = $("partsOrderInventoryQuality").value.trim();
    } else {
      payload.itemKey = $("partsOrderInventoryItem").value;
    }
    inventorySaving = true;
    const submit = $("partsOrderInventorySubmit");
    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Adding…";
    $("partsOrderInventoryMessage").hidden = true;
    try {
      const res = await fetch(INVENTORY_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Rejected");
      PARTS_ORDERS = PARTS_ORDERS.map((part) => part.id === data.partsOrder.id ? data.partsOrder : part);
      renderPartsOrders();
      $("partsOrderInventoryModal").hidden = true;
      inventoryTargetId = null;
      if (typeof window.RPC_LOAD_INVENTORY === "function") window.RPC_LOAD_INVENTORY({ force: true });
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(`Added ${data.partsOrder.inventoryStockedQuantity} to inventory`, { tone: "info", duration: 3000 });
      }
    } catch (err) {
      $("partsOrderInventoryMessage").textContent = err.message;
      $("partsOrderInventoryMessage").hidden = false;
    } finally {
      inventorySaving = false;
      submit.disabled = false;
      submit.textContent = original;
    }
  }

  async function savePartsOrderForm(event) {
    event?.preventDefault();
    if (saving) return;
    const form = $("partsOrderForm");
    if (!form.reportValidity()) return;
    const previousTicketId = editingId ? (PARTS_ORDERS.find((item) => item.id === editingId)?.ticketId || "") : "";
    const payload = {
      action: editingId ? "updatePartsOrder" : "addPartsOrder",
      id: editingId || undefined,
      part: $("partsOrderPart").value.trim(),
      vendor: $("partsOrderVendor").value.trim(),
      status: $("partsOrderStatus").value,
      quantity: $("partsOrderQuantity").value,
      unitCost: $("partsOrderUnitCost").value || 0,
      customerName: $("partsOrderCustomerName").value.trim(),
      customerPhone: $("partsOrderCustomerPhone").value.trim(),
      ticketId: $("partsOrderTicketId").value || "",
      notes: $("partsOrderNotes").value.trim(),
    };
    saving = true;
    const submitBtn = $("partsOrderSubmit");
    const original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    const message = $("partsOrderMessage");
    message.hidden = true;
    try {
      const data = await partsOrderApi(payload);
      const saved = data.partsOrder;
      PARTS_ORDERS = editingId
        ? PARTS_ORDERS.map((item) => (item.id === saved.id ? saved : item))
        : [saved].concat(PARTS_ORDERS);
      renderPartsOrders();
      $("partsOrderFormModal").hidden = true;
      if (saved.ticketId && saved.ticketId !== previousTicketId) markTicketPartOrdered(saved.ticketId);
    } catch (err) {
      message.textContent = err.message;
      message.hidden = false;
    } finally {
      saving = false;
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  }

  async function markArrived(id) {
    try {
      const data = await partsOrderApi({ action: "updatePartsOrder", id, status: "arrived" });
      PARTS_ORDERS = PARTS_ORDERS.map((item) => (item.id === id ? data.partsOrder : item));
      renderPartsOrders();
    } catch (err) {
      notifyError("Couldn't update that part: " + err.message);
    }
  }

  async function markShipmentArrived(batchId) {
    const pending = PARTS_ORDERS.filter((item) =>
      (item.batchId || item.id) === batchId && item.status !== "arrived" && item.status !== "cancelled");
    if (!pending.length) return;
    try {
      for (const item of pending) {
        const data = await partsOrderApi({ action: "updatePartsOrder", id: item.id, status: "arrived" });
        PARTS_ORDERS = PARTS_ORDERS.map((p) => (p.id === item.id ? data.partsOrder : p));
        renderPartsOrders();
      }
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(`Marked ${pending.length} part${pending.length === 1 ? "" : "s"} arrived`, { tone: "info", duration: 2500 });
      }
    } catch (err) {
      notifyError("Couldn't mark the whole shipment arrived: " + err.message);
    }
  }

  async function renameShipment(batchId) {
    const group = PARTS_ORDERS.filter((item) => (item.batchId || item.id) === batchId);
    if (!group.length) return;
    const vendor = group.find((item) => item.vendor)?.vendor || "Shipment";
    const currentName = group.find((item) => item.shipmentName)?.shipmentName || vendor;
    const entered = window.prompt("Shipment name", currentName);
    if (entered == null) return;
    const shipmentName = entered.trim();
    try {
      await partsOrderApi({ action: "renamePartsShipment", batchId, shipmentName });
      PARTS_ORDERS = PARTS_ORDERS.map((item) =>
        (item.batchId || item.id) === batchId ? { ...item, shipmentName } : item);
      renderPartsOrders();
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(shipmentName ? "Shipment renamed" : "Shipment name reset", { tone: "info", duration: 2500 });
      }
    } catch (err) {
      notifyError("Couldn't rename that shipment: " + err.message);
    }
  }

  // Whether the shop has paid the supplier for a shipment — separate from
  // the part's own ordered/arrived/cancelled status. Applies to every part
  // sharing a batchId, so it works the same for a single standalone part
  // (whose batchId is just its own id) as for a multi-part PDF shipment.
  async function togglePaymentStatus(batchId) {
    const group = PARTS_ORDERS.filter((item) => (item.batchId || item.id) === batchId);
    if (!group.length) return;
    const paymentStatus = group[0].paymentStatus === "collected" ? "pending" : "collected";
    try {
      await partsOrderApi({ action: "setPartsShipmentPaymentStatus", batchId, paymentStatus });
      PARTS_ORDERS = PARTS_ORDERS.map((item) =>
        (item.batchId || item.id) === batchId ? { ...item, paymentStatus } : item);
      renderPartsOrders();
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(paymentStatus === "collected" ? "Payment marked collected" : "Marked pending collection", { tone: "info", duration: 2500 });
      }
    } catch (err) {
      notifyError("Couldn't update payment status: " + err.message);
    }
  }

  async function deletePartsOrderRow(id) {
    if (!window.confirm("Delete this parts order?")) return;
    try {
      await partsOrderApi({ action: "deletePartsOrder", id });
      PARTS_ORDERS = PARTS_ORDERS.filter((item) => item.id !== id);
      renderPartsOrders();
    } catch (err) {
      notifyError("Couldn't delete that part: " + err.message);
    }
  }

  async function linkPartsOrderToTicket(id, ticketId) {
    try {
      const data = await partsOrderApi({ action: "updatePartsOrder", id, ticketId });
      PARTS_ORDERS = PARTS_ORDERS.map((item) => (item.id === id ? data.partsOrder : item));
      renderPartsOrders();
      if (typeof window.RPC_TOAST === "function") window.RPC_TOAST("Linked to repair", { tone: "info", duration: 2500 });
      markTicketPartOrdered(ticketId);
    } catch (err) {
      notifyError("Couldn't link that part: " + err.message);
    }
  }

  function handlePartsOrderListClick(event) {
    const arrivedBtn = event.target.closest("[data-parts-arrived]");
    const editBtn = event.target.closest("[data-parts-edit]");
    const deleteBtn = event.target.closest("[data-parts-delete]");
    const linkBtn = event.target.closest("[data-parts-link]");
    const chooseRepairBtn = event.target.closest("[data-parts-choose-repair]");
    const inventoryBtn = event.target.closest("[data-parts-inventory]");
    const shipmentBtn = event.target.closest("[data-parts-arrive-shipment]");
    const toggleBtn = event.target.closest("[data-parts-toggle-shipment]");
    const renameShipmentBtn = event.target.closest("[data-parts-rename-shipment]");
    const paymentBtn = event.target.closest("[data-parts-toggle-payment]");
    if (arrivedBtn) { markArrived(arrivedBtn.dataset.partsArrived); return; }
    if (shipmentBtn) { markShipmentArrived(shipmentBtn.dataset.partsArriveShipment); return; }
    if (toggleBtn) { toggleShipment(toggleBtn.dataset.partsToggleShipment); return; }
    if (renameShipmentBtn) { renameShipment(renameShipmentBtn.dataset.partsRenameShipment); return; }
    if (paymentBtn) { togglePaymentStatus(paymentBtn.dataset.partsTogglePayment); return; }
    if (editBtn) { openPartsOrderForm(PARTS_ORDERS.find((item) => item.id === editBtn.dataset.partsEdit)); return; }
    if (deleteBtn) { deletePartsOrderRow(deleteBtn.dataset.partsDelete); return; }
    if (chooseRepairBtn) { openLinkModal(chooseRepairBtn.dataset.partsChooseRepair); return; }
    if (inventoryBtn) { openInventoryModal(inventoryBtn.dataset.partsInventory); return; }
    if (linkBtn) { linkPartsOrderToTicket(linkBtn.dataset.partsLink, linkBtn.dataset.ticketId); return; }
  }

  // ---- Reusable "link to a repair" search combobox, same pattern as the
  // reminder form's in assets/dashboard.js — one instance per modal. ----
  function createTicketCombobox({ inputId, dropdownId, comboboxId, clearBtnId, hiddenId }) {
    const input = $(inputId), dropdown = $(dropdownId), combobox = $(comboboxId), clearBtn = $(clearBtnId), hidden = $(hiddenId);
    if (!input || !dropdown || !combobox) return null;

    function closeDropdown() {
      dropdown.hidden = true;
      combobox.classList.remove("open");
      input.setAttribute("aria-expanded", "false");
    }
    function renderDropdown(query) {
      const q = query.trim().toLowerCase();
      const matches = tickets
        .filter((t) => !q || [t.customerName, t.device, t.phone, t.id].some((v) => String(v || "").toLowerCase().includes(q)))
        .slice(0, 8);
      dropdown.innerHTML = matches.length
        ? matches.map((t) => `
          <button type="button" class="device-option" role="option" data-ticket-id="${esc(t.id)}" data-ticket-label="${esc(ticketLabel(t))}">
            ${esc(ticketLabel(t))} <span class="rem-notes">#${esc(t.id)}</span>
          </button>`).join("")
        : `<div class="device-dropdown-empty">No matching repairs</div>`;
      dropdown.hidden = false;
      combobox.classList.add("open");
      input.setAttribute("aria-expanded", "true");
    }
    function select(id, label) {
      if (hidden) hidden.value = id || "";
      input.value = label || "";
      if (clearBtn) clearBtn.hidden = !id;
      closeDropdown();
    }
    input.addEventListener("input", () => {
      if (hidden) hidden.value = "";
      if (clearBtn) clearBtn.hidden = true;
      renderDropdown(input.value);
    });
    input.addEventListener("focus", () => renderDropdown(input.value));
    dropdown.addEventListener("mousedown", (event) => {
      const item = event.target.closest("[data-ticket-id]");
      if (!item) return;
      event.preventDefault();
      select(item.dataset.ticketId, item.dataset.ticketLabel);
    });
    clearBtn?.addEventListener("click", () => select("", ""));
    document.addEventListener("click", (event) => {
      if (!combobox.contains(event.target)) closeDropdown();
    });
    return { set: select, reset: () => select("", "") };
  }

  // ---- Customer name autosuggest — same shared directory (CUSTOMERS) the
  // Log Device form uses; picking a match fills in the phone field too. ----
  function createCustomerCombobox({ nameInputId, phoneInputId, dropdownId, comboboxId }) {
    const input = $(nameInputId), dropdown = $(dropdownId), combobox = $(comboboxId), phoneInput = $(phoneInputId);
    if (!input || !dropdown || !combobox) return null;

    function close() {
      dropdown.hidden = true;
      combobox.classList.remove("open");
      input.setAttribute("aria-expanded", "false");
    }
    function render() {
      const q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      const matches = CUSTOMERS.filter((c) =>
        [c.name, c.phone].some((v) => String(v || "").toLowerCase().includes(q))
      ).slice(0, 8);
      if (!matches.length) { close(); return; }
      dropdown.innerHTML = matches.map((c) => `
        <button type="button" class="device-option" role="option" data-customer-id="${esc(c.id)}">
          ${esc(c.name || "Unknown customer")} <span class="rem-notes">${esc(c.phone || "")}</span>
        </button>
      `).join("");
      dropdown.hidden = false;
      combobox.classList.add("open");
      input.setAttribute("aria-expanded", "true");
    }
    dropdown.addEventListener("mousedown", (event) => {
      const btn = event.target.closest("[data-customer-id]");
      if (!btn) return;
      event.preventDefault();
      const customer = CUSTOMERS.find((c) => c.id === btn.dataset.customerId);
      if (!customer) return;
      input.value = customer.name || "";
      if (phoneInput && customer.phone) phoneInput.value = customer.phone;
      close();
    });
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    document.addEventListener("click", (event) => {
      if (!combobox.contains(event.target)) close();
    });
  }

  /* ---- PDF upload + AI-extraction review -------------------------------
     Supplier PDFs are small, so they travel to the server in the existing
     PIN-protected request and Gemini reads them there. Nothing is saved to
     parts_orders until the reviewed rows are explicitly confirmed here. */
  function resetReviewState() {
    reviewRows = [];
    reviewUploadUrl = null;
    $("partsOrderReviewVendor").value = "";
    $("partsOrderReviewShipmentName").value = "";
    $("partsOrderReviewCustomerName").value = "";
    $("partsOrderReviewCustomerPhone").value = "";
    reviewTicketCombobox?.reset();
    $("partsOrderReviewRows").innerHTML = "";
    $("partsOrderReviewMessage").hidden = true;
    $("partsOrderReviewForm").hidden = true;
    $("partsOrderReviewStatus").hidden = false;
    $("partsOrderReviewSaveBtn").disabled = true;
  }

  function renderReviewRows() {
    $("partsOrderReviewRows").innerHTML = reviewRows.map((row, i) => `
      <div class="parts-order-review-row" data-row-index="${i}">
        <input type="text" class="text-input" data-review-field="part" placeholder="Part" value="${esc(row.part)}" />
        <input type="number" class="text-input" data-review-field="quantity" min="1" step="1" value="${esc(String(row.quantity))}" aria-label="Quantity" />
        <input type="number" class="text-input" data-review-field="unitCost" min="0" step="0.01" value="${esc(row.unitCost.toFixed(2))}" aria-label="Unit cost" />
        <button type="button" class="icon-btn" data-review-remove="${i}" aria-label="Remove line"><svg class="icon"><use href="#i-xmark"></use></svg></button>
      </div>
    `).join("");
  }

  function handleReviewRowInput(event) {
    const rowEl = event.target.closest("[data-row-index]");
    const field = event.target.dataset.reviewField;
    if (!rowEl || !field) return;
    const row = reviewRows[Number(rowEl.dataset.rowIndex)];
    if (!row) return;
    if (field === "part") row.part = event.target.value;
    else if (field === "quantity") row.quantity = Math.max(1, Number(event.target.value) || 1);
    else if (field === "unitCost") row.unitCost = Math.max(0, Number(event.target.value) || 0);
  }

  function handleReviewRowClick(event) {
    const removeBtn = event.target.closest("[data-review-remove]");
    if (!removeBtn) return;
    reviewRows.splice(Number(removeBtn.dataset.reviewRemove), 1);
    renderReviewRows();
  }

  // Guesses which in-progress repair these extracted lines are for, by
  // running the same device-name match used in the table's "Linked to"
  // column across every row and taking the ticket that comes up most.
  function suggestReviewTicket() {
    const scores = new Map();
    for (const row of reviewRows) {
      const matches = findMatchingTickets({ part: row.part });
      matches.forEach((t, i) => scores.set(t.id, (scores.get(t.id) || 0) + (matches.length - i)));
    }
    let best = null, bestScore = 0;
    for (const [id, score] of scores) {
      if (score > bestScore) { bestScore = score; best = id; }
    }
    return best ? tickets.find((t) => t.id === best) || null : null;
  }

  function openReviewModal() {
    $("partsOrderReviewModal").hidden = false;
  }

  function closeReviewModal() {
    $("partsOrderReviewModal").hidden = true;
  }

  async function handlePdfSelected(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") {
      notifyError("Please choose a PDF file.");
      return;
    }
    if (file.size > MAX_INLINE_PDF_BYTES) {
      notifyError("That PDF is over 2.5MB. Compress or split it, then try again.");
      return;
    }
    const p = pin();
    if (!p) {
      notifyError("Enter Check In PIN first.");
      return;
    }
    resetReviewState();
    openReviewModal();
    ensureCustomersLoaded();
    $("partsOrderReviewStatus").textContent = "Reading the PDF…";
    try {
      reviewBatchId = "PO" + crypto.randomUUID();
      const pdfBase64 = await readFileAsBase64(file);
      const extracted = await partsOrderApi({ action: "extractPartsOrderPdf", pdfBase64, filename: file.name });
      reviewRows = (extracted.parts || []).map((p) => ({ part: p.part, quantity: p.quantity, unitCost: p.unitCost }));
      $("partsOrderReviewVendor").value = extracted.vendor || "";
      if (!reviewRows.length) reviewRows.push({ part: "", quantity: 1, unitCost: 0 });
      renderReviewRows();
      const suggested = suggestReviewTicket();
      if (suggested) {
        reviewTicketCombobox?.set(suggested.id, ticketLabel(suggested));
        if (typeof window.RPC_TOAST === "function") {
          window.RPC_TOAST(`Auto-linked to ${ticketLabel(suggested)} — change below if that's wrong`, { tone: "info", duration: 4000 });
        }
      }
      $("partsOrderReviewStatus").hidden = true;
      $("partsOrderReviewForm").hidden = false;
      $("partsOrderReviewSaveBtn").disabled = false;
    } catch (err) {
      $("partsOrderReviewStatus").hidden = false;
      $("partsOrderReviewStatus").textContent = "Couldn't read that PDF: " + err.message;
    }
  }

  async function saveReviewRows() {
    const message = $("partsOrderReviewMessage");
    message.hidden = true;
    const rows = reviewRows.filter((row) => row.part.trim());
    if (!rows.length) {
      message.textContent = "Add at least one part with a description.";
      message.hidden = false;
      return;
    }
    const saveBtn = $("partsOrderReviewSaveBtn");
    const original = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const vendor = $("partsOrderReviewVendor").value.trim();
    const shipmentName = $("partsOrderReviewShipmentName").value.trim();
    const customerName = $("partsOrderReviewCustomerName").value.trim();
    const customerPhone = $("partsOrderReviewCustomerPhone").value.trim();
    const ticketId = $("partsOrderReviewTicketId").value || "";
    try {
      const saved = [];
      for (const row of rows) {
        const data = await partsOrderApi({
          action: "addPartsOrder", batchId: reviewBatchId, vendor, shipmentName, part: row.part.trim(), quantity: row.quantity,
          unitCost: row.unitCost, customerName, customerPhone, ticketId, source: "pdf", sourceDocumentUrl: reviewUploadUrl,
        });
        saved.push(data.partsOrder);
      }
      PARTS_ORDERS = saved.concat(PARTS_ORDERS);
      renderPartsOrders();
      closeReviewModal();
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(`Added ${saved.length} part${saved.length === 1 ? "" : "s"} from the PDF`, { tone: "info", duration: 3000 });
      }
      if (ticketId) markTicketPartOrdered(ticketId);
    } catch (err) {
      message.textContent = "Some parts couldn't be saved: " + err.message;
      message.hidden = false;
      saveBtn.disabled = false;
    } finally {
      saveBtn.textContent = original;
    }
  }

  /* ---- Wiring ----------------------------------------------------------- */
  function bind() {
    if (bound) return;
    bound = true;

    $("partsOrderNewBtn")?.addEventListener("click", () => openPartsOrderForm(null));
    $("closePartsOrderFormModal")?.addEventListener("click", closePartsOrderForm);
    $("partsOrderCancelBtn")?.addEventListener("click", closePartsOrderForm);
    $("partsOrderForm")?.addEventListener("submit", savePartsOrderForm);
    $("partsOrderSubmit")?.addEventListener("click", savePartsOrderForm);
    $("partsOrderList")?.addEventListener("click", handlePartsOrderListClick);
    $("closePartsOrderInventoryModal")?.addEventListener("click", closeInventoryModal);
    $("partsOrderInventoryCancelBtn")?.addEventListener("click", closeInventoryModal);
    $("partsOrderInventoryForm")?.addEventListener("submit", stockPartsOrder);
    $("partsOrderInventorySubmit")?.addEventListener("click", stockPartsOrder);
    $("partsOrderInventoryMode")?.addEventListener("change", syncInventoryMode);

    $("closePartsOrderLinkModal")?.addEventListener("click", closeLinkModal);
    $("partsOrderLinkCancelBtn")?.addEventListener("click", closeLinkModal);
    $("partsOrderLinkSuggested")?.addEventListener("click", handleLinkModalClick);
    $("partsOrderLinkResults")?.addEventListener("click", handleLinkModalClick);
    $("partsOrderLinkSearch")?.addEventListener("input", (event) => renderLinkSearchResults(event.target.value || ""));

    $("partsOrderSearch")?.addEventListener("input", () => {
      searchQuery = ($("partsOrderSearch").value || "").trim().toLowerCase();
      $("clearPartsOrderSearch").hidden = !searchQuery;
      renderPartsOrders();
    });
    $("clearPartsOrderSearch")?.addEventListener("click", () => {
      $("partsOrderSearch").value = "";
      searchQuery = "";
      $("clearPartsOrderSearch").hidden = true;
      renderPartsOrders();
    });
    $("partsOrderStatusChips")?.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-parts-status-filter]");
      if (!chip) return;
      statusFilter = chip.dataset.partsStatusFilter;
      renderPartsOrders();
    });

    $("partsOrderUploadBtn")?.addEventListener("click", () => $("partsOrderPdfInput")?.click());
    $("partsOrderPdfInput")?.addEventListener("change", handlePdfSelected);
    $("closePartsOrderReviewModal")?.addEventListener("click", closeReviewModal);
    $("partsOrderReviewCancelBtn")?.addEventListener("click", closeReviewModal);
    $("partsOrderReviewSaveBtn")?.addEventListener("click", saveReviewRows);
    $("partsOrderReviewAddRow")?.addEventListener("click", () => {
      reviewRows.push({ part: "", quantity: 1, unitCost: 0 });
      renderReviewRows();
    });
    $("partsOrderReviewRows")?.addEventListener("input", handleReviewRowInput);
    $("partsOrderReviewRows")?.addEventListener("click", handleReviewRowClick);

    formTicketCombobox = createTicketCombobox({
      inputId: "partsOrderTicketSearch", dropdownId: "partsOrderTicketDropdown",
      comboboxId: "partsOrderTicketCombobox", clearBtnId: "clearPartsOrderTicket", hiddenId: "partsOrderTicketId",
    });
    reviewTicketCombobox = createTicketCombobox({
      inputId: "partsOrderReviewTicketSearch", dropdownId: "partsOrderReviewTicketDropdown",
      comboboxId: "partsOrderReviewTicketCombobox", clearBtnId: "clearPartsOrderReviewTicket", hiddenId: "partsOrderReviewTicketId",
    });
    createCustomerCombobox({
      nameInputId: "partsOrderCustomerName", phoneInputId: "partsOrderCustomerPhone",
      dropdownId: "partsOrderCustomerDropdown", comboboxId: "partsOrderCustomerCombobox",
    });
    createCustomerCombobox({
      nameInputId: "partsOrderReviewCustomerName", phoneInputId: "partsOrderReviewCustomerPhone",
      dropdownId: "partsOrderReviewCustomerDropdown", comboboxId: "partsOrderReviewCustomerCombobox",
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!$("partsOrderFormModal")?.hidden) closePartsOrderForm();
      if (!$("partsOrderInventoryModal")?.hidden) closeInventoryModal();
      if (!$("partsOrderReviewModal")?.hidden) closeReviewModal();
      if (!$("partsOrderLinkModal")?.hidden) closeLinkModal();
    });
  }

  function initPartsOrders() {
    bind();
    loadPartsOrders();
    ensureCustomersLoaded();
    loadTicketsForMatching();
  }

  window.addEventListener("rpc-enter-parts-orders", initPartsOrders);
  window.addEventListener("rpc-tickets", (event) => { tickets = event.detail?.tickets || []; });
})();
