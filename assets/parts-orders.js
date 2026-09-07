/* ============================================================
   Parts orders — tracks parts ordered from suppliers, optionally linked to
   a customer and/or a repair ticket. Lives as a sub-panel of the Accounting
   tab (see index.html's data-account-panel="partsOrders"), following the
   same shape as the Expenses panel in assets/dashboard.js.
   ============================================================ */
(function () {
  const INTAKE_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  const MAX_INLINE_PDF_BYTES = 2.5 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);

  const STATUS_LABELS = { ordered: "Ordered", backordered: "Backordered", arrived: "Arrived", cancelled: "Cancelled" };

  let PARTS_ORDERS = [];
  let tickets = [];
  let statusFilter = "all";
  let searchQuery = "";
  let editingId = null;
  let saving = false;
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

  async function loadPartsOrders() {
    try {
      const data = await partsOrderApi({ action: "listPartsOrders" });
      PARTS_ORDERS = data.partsOrders || [];
      renderPartsOrders();
    } catch (err) {
      notifyError("Couldn't load parts orders: " + err.message);
    }
  }

  function filteredPartsOrders() {
    return PARTS_ORDERS.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (!searchQuery) return true;
      return [item.part, item.vendor, item.customerName, item.notes]
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

  function linkedCellHtml(item) {
    if (item.ticketId) {
      const label = ticketLabelById(item.ticketId) || item.customerName || "Linked repair";
      return `<button type="button" class="parts-order-link-chip" data-parts-open-ticket="${esc(item.ticketId)}">
        <svg class="icon"><use href="#i-device"></use></svg>${esc(label)}
      </button>`;
    }
    if (item.customerName) {
      return `<span class="parts-order-customer-text">${esc(item.customerName)}</span>`;
    }
    const matches = findMatchingTickets(item);
    if (matches.length) {
      return `<div class="parts-order-match-list">
        ${matches.map((t) => `
          <button type="button" class="parts-order-match" data-parts-link="${esc(item.id)}" data-ticket-id="${esc(t.id)}">
            <svg class="icon"><use href="#i-check"></use></svg>Link to ${esc(ticketLabel(t))}
          </button>
        `).join("")}
      </div>`;
    }
    return `<span class="parts-order-empty-cell">—</span>`;
  }

  function partsOrderRowHtml(item) {
    const canAdvance = item.status !== "arrived" && item.status !== "cancelled";
    return `<tr class="inventory-row parts-order-row is-${esc(item.status)}">
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
      <td data-label="Linked to">${linkedCellHtml(item)}</td>
      <td class="num" data-label="Cost">
        <strong>${money(item.totalCost)}</strong>
        <span class="parts-order-cost-sub">${item.quantity} × ${money(item.unitCost)}</span>
      </td>
      <td data-label="Ordered">${esc(formatDate(item.orderedAt))}</td>
      <td data-label="Actions">
        <div class="parts-order-actions">
          ${canAdvance ? `<button type="button" class="parts-order-arrived-btn" data-parts-arrived="${esc(item.id)}">Mark arrived</button>` : ""}
          ${item.sourceDocumentUrl ? `<a class="icon-btn ghost-btn" href="${esc(item.sourceDocumentUrl)}" target="_blank" rel="noopener" title="View order PDF" aria-label="View order PDF"><svg class="icon"><use href="#i-receipt"></use></svg></a>` : ""}
          <button type="button" class="icon-btn ghost-btn" data-parts-edit="${esc(item.id)}" title="Edit" aria-label="Edit"><svg class="icon"><use href="#i-pencil"></use></svg></button>
          <button type="button" class="icon-btn ghost-btn danger-btn" data-parts-delete="${esc(item.id)}" title="Delete" aria-label="Delete"><svg class="icon"><use href="#i-trash"></use></svg></button>
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
    list.innerHTML = visible.map(partsOrderRowHtml).join("");
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
    $("partsOrderPart").focus();
  }

  function closePartsOrderForm() {
    if (saving) return;
    $("partsOrderFormModal").hidden = true;
  }

  async function savePartsOrderForm(event) {
    event?.preventDefault();
    if (saving) return;
    const form = $("partsOrderForm");
    if (!form.reportValidity()) return;
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
    } catch (err) {
      notifyError("Couldn't link that part: " + err.message);
    }
  }

  function handlePartsOrderListClick(event) {
    const arrivedBtn = event.target.closest("[data-parts-arrived]");
    const editBtn = event.target.closest("[data-parts-edit]");
    const deleteBtn = event.target.closest("[data-parts-delete]");
    const linkBtn = event.target.closest("[data-parts-link]");
    const openTicketBtn = event.target.closest("[data-parts-open-ticket]");
    if (arrivedBtn) { markArrived(arrivedBtn.dataset.partsArrived); return; }
    if (editBtn) { openPartsOrderForm(PARTS_ORDERS.find((item) => item.id === editBtn.dataset.partsEdit)); return; }
    if (deleteBtn) { deletePartsOrderRow(deleteBtn.dataset.partsDelete); return; }
    if (linkBtn) { linkPartsOrderToTicket(linkBtn.dataset.partsLink, linkBtn.dataset.ticketId); return; }
    if (openTicketBtn) {
      if (typeof window.RPC_OPEN_TICKET_BY_ID === "function") window.RPC_OPEN_TICKET_BY_ID(openTicketBtn.dataset.partsOpenTicket);
      return;
    }
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

  /* ---- PDF upload + AI-extraction review -------------------------------
     Supplier PDFs are small, so they travel to the server in the existing
     PIN-protected request and Gemini reads them there. Nothing is saved to
     parts_orders until the reviewed rows are explicitly confirmed here. */
  function resetReviewState() {
    reviewRows = [];
    reviewUploadUrl = null;
    $("partsOrderReviewVendor").value = "";
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
    const customerName = $("partsOrderReviewCustomerName").value.trim();
    const customerPhone = $("partsOrderReviewCustomerPhone").value.trim();
    const ticketId = $("partsOrderReviewTicketId").value || "";
    try {
      const saved = [];
      for (const row of rows) {
        const data = await partsOrderApi({
          action: "addPartsOrder", batchId: reviewBatchId, vendor, part: row.part.trim(), quantity: row.quantity,
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

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!$("partsOrderFormModal")?.hidden) closePartsOrderForm();
      if (!$("partsOrderReviewModal")?.hidden) closeReviewModal();
    });
  }

  function initPartsOrders() {
    bind();
    loadPartsOrders();
  }

  window.addEventListener("rpc-enter-parts-orders", initPartsOrders);
  window.addEventListener("rpc-tickets", (event) => { tickets = event.detail?.tickets || []; });
})();
