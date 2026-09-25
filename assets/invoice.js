/* ============================================================
   Check-in invoices: Zoho-style PDF + in-app editor
   ------------------------------------------------------------
   The server (lib/invoices.js, api/invoice.js) stores each invoice as
   structured data. This file turns one into a PDF laid out like the shop's
   Zoho invoices, lets staff edit it, and renders the small invoice card
   shown after a device is logged and in a repair's details.

   window.RPC_INVOICE_REQUEST(body) is provided by assets/intake.js (it owns
   the API URL and PIN). Exposes window.RPC_INVOICE.
   ============================================================ */
(() => {
  const $ = (id) => document.getElementById(id);
  const request = (body) => {
    if (typeof window.RPC_INVOICE_REQUEST !== "function") throw new Error("Invoices aren't available yet");
    return window.RPC_INVOICE_REQUEST(body);
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const num = (v) => {
    const n = Number(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const money = (v) => num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const displayDate = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  };

  function totalsOf(invoice) {
    const items = invoice.items || [];
    const subTotal = num(items.reduce((sum, it) => sum + num(it.qty || 1) * num(it.rate), 0));
    const paymentMade = num(invoice.paymentMade);
    return { subTotal, total: subTotal, paymentMade, balanceDue: num(subTotal - paymentMade) };
  }

  /* ---- PDF ------------------------------------------------------------ */
  let jsPdfLoading = null;
  function loadJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jsPdfLoading) {
      jsPdfLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "assets/vendor/jspdf.umd.min.js?v=3.0.1";
        s.onload = () => (window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error("PDF generator failed to load")));
        s.onerror = () => { jsPdfLoading = null; reject(new Error("Couldn't load the PDF generator — check the connection.")); };
        document.head.appendChild(s);
      });
    }
    return jsPdfLoading;
  }

  // Coordinates are A4 points, taken from the shop's Zoho invoice so the
  // two look the same side by side.
  const PAGE = { left: 46, right: 569, valueRight: 561, top: 50, bottom: 790 };
  const INK = [51, 51, 51];
  const MUTED = [102, 102, 102];

  async function buildPdf(invoice) {
    const JsPDF = await loadJsPdf();
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const cur = invoice.currency || "TTD";
    const t = totalsOf(invoice);
    const b = invoice.business || {};
    const { left: L, right: R, valueRight: VR } = PAGE;

    const font = (style, size, color = INK) => {
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(...color);
    };

    // From block
    font("bold", 10);
    doc.text(b.name || "JQ Electronics Ltd.", L, 68);
    font("normal", 9);
    let y = 80;
    for (const line of [...(b.addressLines || []), b.email].filter(Boolean)) {
      doc.text(String(line), L, y);
      y += 12;
    }

    // Title block
    font("normal", 28, [0, 0, 0]);
    doc.text("INVOICE", R, 87, { align: "right" });
    font("bold", 10);
    doc.text(`# ${invoice.number || ""}`, R, 105, { align: "right" });
    font("bold", 8);
    doc.text("Balance Due", R, 132, { align: "right" });
    font("bold", 12);
    doc.text(`${cur}${money(t.balanceDue)}`, R, 147, { align: "right" });

    // Dates + bill to
    const dateRows = [["Invoice Date :", displayDate(invoice.invoiceDate)], ["Terms :", invoice.terms || "Due on Receipt"], ["Due Date :", displayDate(invoice.dueDate)]];
    dateRows.forEach(([label, value], i) => {
      font("normal", 10);
      doc.text(label, 457, 189 + i * 21, { align: "right" });
      font("normal", 9);
      doc.text(String(value || ""), VR, 189 + i * 21, { align: "right" });
    });
    font("normal", 10);
    doc.text("Bill To", L, 222);
    font("bold", 9);
    doc.text(invoice.billTo?.name || "", L, 235);

    // Items table
    const drawHeader = (top) => {
      doc.setFillColor(60, 61, 58);
      doc.rect(L, top, R - L, 24, "F");
      doc.setDrawColor(90, 91, 88);
      doc.setLineWidth(0.5);
      [78, 380, 434, 490].forEach((x) => doc.line(x, top, x, top + 24));
      font("normal", 9, [255, 255, 255]);
      const base = top + 15;
      doc.text("#", 57, base);
      doc.text("Item & Description", 86, base);
      doc.text("Qty", 425, base, { align: "right" });
      doc.text("Rate", 482, base, { align: "right" });
      doc.text("Amount", VR, base, { align: "right" });
      return top + 24;
    };
    let rowTop = drawHeader(255);
    (invoice.items || []).forEach((item, i) => {
      font("normal", 9);
      const descLines = doc.splitTextToSize(item.description || "", 285);
      const detailLines = item.detail ? doc.splitTextToSize(item.detail, 285) : [];
      const lineCount = Math.max(1, descLines.length + detailLines.length);
      const height = 14 + (lineCount - 1) * 12 + 14;
      if (rowTop + height > PAGE.bottom) {
        doc.addPage();
        rowTop = drawHeader(PAGE.top);
      }
      let base = rowTop + 14;
      font("normal", 9);
      doc.text(String(i + 1), 58, base);
      doc.text(num(item.qty || 1).toFixed(2), 425, base, { align: "right" });
      doc.text(money(item.rate), 482, base, { align: "right" });
      doc.text(money(num(item.qty || 1) * num(item.rate)), VR, base, { align: "right" });
      descLines.forEach((line) => { doc.text(line, 86, base); base += 12; });
      font("normal", 9, MUTED);
      detailLines.forEach((line) => { doc.text(line, 86, base); base += 12; });
      rowTop += height;
      doc.setDrawColor(173, 173, 173);
      doc.setLineWidth(0.5);
      doc.line(L, rowTop, R, rowTop);
    });

    // Totals
    if (rowTop + 120 > PAGE.bottom) { doc.addPage(); rowTop = PAGE.top; }
    let ty = rowTop + 15;
    const totalRow = (label, value, { bold = false, color = INK } = {}) => {
      font(bold ? "bold" : "normal", 9);
      doc.text(label, 457, ty, { align: "right" });
      font(bold ? "bold" : "normal", 9, color);
      doc.text(value, VR, ty, { align: "right" });
      ty += 28;
    };
    totalRow("Sub Total", money(t.subTotal));
    totalRow("Total", `${cur}${money(t.total)}`, { bold: true });
    if (t.paymentMade) totalRow("Payment Made", `(-) ${money(t.paymentMade)}`, { color: [224, 43, 39] });
    doc.setFillColor(245, 244, 243);
    doc.rect(308, ty - 16, R - 308, 28, "F");
    totalRow("Balance Due", `${cur}${money(t.balanceDue)}`, { bold: true });

    // Notes
    const notes = String(invoice.notes || "").trim();
    if (notes) {
      let ny = ty + 32;
      if (ny + 40 > PAGE.bottom) { doc.addPage(); ny = PAGE.top; }
      font("normal", 10);
      doc.text("Notes", L, ny);
      ny += 16;
      font("normal", 8);
      for (const para of notes.split("\n")) {
        const lines = para.trim() ? doc.splitTextToSize(para, R - L) : [""];
        for (const line of lines) {
          if (ny > PAGE.bottom) { doc.addPage(); ny = PAGE.top; font("normal", 8); }
          if (line) doc.text(line, L, ny);
          ny += 10.4;
        }
      }
    }

    // Page numbers, bottom right like Zoho.
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      font("normal", 8);
      doc.text(String(p), 561, 809, { align: "right" });
    }
    doc.setProperties({ title: `Invoice ${invoice.number || ""}`, author: b.name || "JQ Electronics" });
    return doc;
  }

  const pdfName = (invoice) => `${String(invoice.number || "invoice").replace(/[^\w.-]+/g, "_")}.pdf`;

  async function downloadPdf(invoice) {
    const doc = await buildPdf(invoice);
    doc.save(pdfName(invoice));
  }

  function canSharePdf() {
    try {
      return typeof navigator.canShare === "function"
        && navigator.canShare({ files: [new File([""], "x.pdf", { type: "application/pdf" })] });
    } catch (_) {
      return false;
    }
  }

  async function sharePdf(invoice) {
    const doc = await buildPdf(invoice);
    const file = new File([doc.output("blob")], pdfName(invoice), { type: "application/pdf" });
    try {
      await navigator.share({ files: [file], title: `Invoice ${invoice.number}` });
    } catch (err) {
      if (err && err.name === "AbortError") return; // closed the share sheet
      throw err;
    }
  }

  /* ---- Invoice card (success step, repair details) -------------------- */
  // Renders into `el` and keeps itself up to date after edits.
  function renderCard(el, invoice, { url = "" } = {}) {
    if (!el) return;
    const t = totalsOf(invoice);
    const itemCount = (invoice.items || []).length;
    el.hidden = false;
    el.innerHTML = `
      <div class="invoice-card">
        <div class="invoice-card-head">
          <span class="invoice-card-icon" aria-hidden="true"><svg class="icon"><use href="#i-receipt"></use></svg></span>
          <div class="invoice-card-id">
            <p class="invoice-card-num">Invoice ${esc(invoice.number)}</p>
            <p class="invoice-card-sub">${esc(invoice.billTo?.name || "")} · ${itemCount} item${itemCount === 1 ? "" : "s"} · ${esc(invoice.currency || "TTD")}${esc(money(t.total))}</p>
          </div>
          <div class="invoice-card-due"><span>Balance due</span><strong>${esc(invoice.currency || "TTD")}${esc(money(t.balanceDue))}</strong></div>
        </div>
        <div class="invoice-card-actions">
          <button type="button" class="primary-btn" data-inv-card="pdf"><svg class="icon"><use href="#i-download"></use></svg>Download PDF</button>
          ${canSharePdf() ? `<button type="button" class="ghost-btn" data-inv-card="share"><svg class="icon"><use href="#i-chat"></use></svg>Share PDF</button>` : ""}
          <button type="button" class="ghost-btn" data-inv-card="edit"><svg class="icon"><use href="#i-pencil"></use></svg>Edit invoice</button>
          ${url ? `<a class="ghost-btn" href="${esc(url)}" target="_blank" rel="noopener">Open link</a>` : ""}
        </div>
        <p class="field-error invoice-card-error" hidden></p>
      </div>`;
    const error = el.querySelector(".invoice-card-error");
    const busy = async (btn, fn) => {
      error.hidden = true;
      btn.disabled = true;
      try { await fn(); } catch (err) {
        error.textContent = err.message || String(err);
        error.hidden = false;
      } finally { btn.disabled = false; }
    };
    el.querySelectorAll("[data-inv-card]").forEach((btn) => {
      btn.onclick = () => {
        const kind = btn.dataset.invCard;
        if (kind === "pdf") busy(btn, () => downloadPdf(invoice));
        if (kind === "share") busy(btn, () => sharePdf(invoice));
        if (kind === "edit") openEditor(invoice, {
          onSaved: (saved, savedUrl) => renderCard(el, saved, { url: savedUrl || url }),
          onDeleted: () => { el.innerHTML = `<div class="invoice-card"><p class="invoice-card-deleted">Invoice ${esc(invoice.number)} was deleted.</p></div>`; },
        });
      };
    });
  }

  /* ---- Editor ---------------------------------------------------------- */
  let editing = null; // { invoice, onSaved }

  // The editor is the invoice itself: the same sheet as the PDF, with every
  // field editable in place (click a value to change it).
  function ensureEditor() {
    let modal = $("invoiceEditorModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "invoiceEditorModal";
    modal.className = "modal-backdrop invoice-editor-backdrop";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-panel invoice-editor-panel" role="dialog" aria-modal="true" aria-labelledby="invoiceEditorTitle">
        <div class="modal-header">
          <div>
            <h3 id="invoiceEditorTitle">Edit invoice</h3>
            <p class="invoice-editor-hint">Click any value on the invoice to change it.</p>
          </div>
          <button type="button" class="modal-close" data-inv-close aria-label="Close"><svg class="icon"><use href="#i-xmark"></use></svg></button>
        </div>
        <div class="modal-body invoice-editor-body">
          <label class="inv-log-bar" id="invLogBar" hidden>
            <input type="checkbox" id="invLogRepairs" checked />
            <span>
              <strong>Log these devices as repairs</strong>
              <small id="invLogPreview">Add a line like “Pixel 7 Pro Screen Replacement” and the repair is logged on save.</small>
            </span>
          </label>
          <div class="inv-sheet">
            <section class="inv-top">
              <div class="inv-from" id="invFrom"></div>
              <div class="inv-title">
                <p class="inv-word">INVOICE</p>
                <label class="inv-number"># <input id="invNumber" class="inv-inline inv-inline-bold" autocomplete="off" aria-label="Invoice number" /></label>
                <p class="inv-bal-label">Balance Due</p>
                <p class="inv-bal" id="invHeadBalance"></p>
              </div>
            </section>

            <section class="inv-meta">
              <div class="inv-bill">
                <p class="inv-muted-label">Bill To</p>
                <input id="invBillName" class="inv-inline inv-inline-bold" autocomplete="off" placeholder="Customer name" aria-label="Bill to name" />
                <input id="invBillPhone" class="inv-inline inv-inline-small" type="tel" autocomplete="off" placeholder="Phone (not printed)" aria-label="Phone" />
                <input id="invBillEmail" class="inv-inline inv-inline-small" type="email" autocomplete="off" placeholder="Email (not printed)" aria-label="Email" />
              </div>
              <div class="inv-dates">
                <label><span>Invoice Date :</span><input id="invDate" class="inv-inline" type="date" /></label>
                <label><span>Terms :</span><input id="invTerms" class="inv-inline" list="invTermsList" autocomplete="off" /></label>
                <datalist id="invTermsList"><option value="Due on Receipt"></option><option value="Net 7"></option><option value="Net 15"></option><option value="Net 30"></option></datalist>
                <label><span>Due Date :</span><input id="invDueDate" class="inv-inline" type="date" /></label>
              </div>
            </section>

            <div class="inv-table" role="table" aria-label="Invoice items">
              <div class="inv-row inv-head" role="row">
                <span role="columnheader">#</span>
                <span role="columnheader">Item &amp; Description</span>
                <span role="columnheader" class="inv-num-col">Qty</span>
                <span role="columnheader" class="inv-num-col">Rate</span>
                <span role="columnheader" class="inv-num-col">Amount</span>
                <span aria-hidden="true"></span>
              </div>
              <div id="invItems" class="invoice-items"></div>
            </div>
            <button type="button" class="inv-add-line" data-inv-add-item><svg class="icon"><use href="#i-plus"></use></svg>Add line</button>

            <div class="inv-totals">
              <div><span>Sub Total</span><span id="invSubTotal"></span></div>
              <div class="inv-strong"><span>Total</span><span id="invTotal"></span></div>
              <label class="inv-paid"><span>Payment Made</span><span class="inv-paid-value">(-) <input id="invPaymentMade" class="inv-inline inv-inline-num" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" aria-label="Payment made" /></span></label>
              <div class="inv-due"><span>Balance Due</span><span id="invBalanceDue"></span></div>
            </div>

            <section class="inv-notes">
              <p class="inv-muted-label">Notes</p>
              <textarea id="invNotes" class="inv-inline inv-notes-input" rows="10" aria-label="Notes"></textarea>
            </section>
          </div>
          <p id="invError" class="field-error" hidden></p>
        </div>
        <div class="modal-footer"><div class="form-actions">
          <button type="button" class="ghost-btn danger-btn invoice-delete-btn" data-inv-delete aria-label="Delete invoice"><svg class="icon"><use href="#i-trash"></use></svg><span>Delete</span></button>
          <button type="button" class="ghost-btn" data-inv-close>Cancel</button>
          <button type="button" class="ghost-btn" data-inv-save="pdf"><svg class="icon"><use href="#i-download"></use></svg>Save &amp; PDF</button>
          <button type="button" class="primary-btn" data-inv-save="only"><svg class="icon"><use href="#i-check"></use></svg>Save</button>
        </div></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-inv-close]").forEach((btn) => btn.addEventListener("click", closeEditor));
    modal.querySelector("[data-inv-add-item]").addEventListener("click", () => {
      addItemRow({ description: "", detail: "", qty: 1, rate: "" });
      updateEditorTotals();
      const rows = modal.querySelectorAll(".invoice-item");
      rows[rows.length - 1]?.querySelector("[data-item=description]")?.focus();
    });
    modal.querySelector("#invItems").addEventListener("input", (e) => {
      if (e.target.matches("textarea")) autoGrow(e.target);
      updateEditorTotals();
      updateLogPreview();
    });
    modal.querySelector("#invLogRepairs").addEventListener("change", updateLogPreview);
    modal.querySelector("#invItems").addEventListener("click", (e) => {
      const remove = e.target.closest("[data-item-remove]");
      if (!remove) return;
      remove.closest(".invoice-item").remove();
      renumberItems();
      updateEditorTotals();
    });
    modal.querySelector("#invPaymentMade").addEventListener("input", updateEditorTotals);
    modal.querySelector("#invNotes").addEventListener("input", (e) => autoGrow(e.target));
    modal.querySelectorAll("[data-inv-save]").forEach((btn) => btn.addEventListener("click", () => saveEditor(btn)));
    modal.querySelector("[data-inv-delete]").addEventListener("click", async (e) => {
      if (!editing?.invoice?.id) return;
      const { invoice, onDeleted } = editing;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        if (await deleteInvoiceWithConfirm(invoice)) {
          closeEditor();
          if (onDeleted) onDeleted(invoice);
        }
      } catch (err) {
        $("invError").textContent = "Couldn't delete the invoice: " + (err.message || err);
        $("invError").hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) { e.stopPropagation(); closeEditor(); }
    }, true);
    return modal;
  }

  // New invoices only: what "Log these devices as repairs" will create.
  function updateLogPreview() {
    const bar = $("invLogBar");
    if (!bar || bar.hidden) return;
    const preview = $("invLogPreview");
    if (!$("invLogRepairs").checked) {
      preview.textContent = "Only the invoice will be saved — no repair is logged.";
      return;
    }
    const lines = typeof window.RPC_INVOICE_REPAIR_PREVIEW === "function" ? window.RPC_INVOICE_REPAIR_PREVIEW(readItems()) : [];
    preview.textContent = lines.length
      ? `On save, logs ${lines.length} repair${lines.length === 1 ? "" : "s"} (status Received): ${lines.join(" · ")}`
      : "Add a line like “Pixel 7 Pro Screen Replacement” and the repair is logged on save.";
  }

  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
  }

  function addItemRow(item) {
    const wrap = $("invItems");
    const row = document.createElement("div");
    row.className = "inv-row invoice-item";
    row.setAttribute("role", "row");
    row.innerHTML = `
      <span class="invoice-item-num" role="cell"></span>
      <div class="invoice-item-desc" role="cell">
        <input class="inv-inline" data-item="description" placeholder="Item, e.g. Pixel 7 Pro Screen Replacement" value="${esc(item.description)}" aria-label="Item description" />
        <textarea class="inv-inline inv-inline-detail" data-item="detail" rows="1" placeholder="Add details (optional)" aria-label="Item details">${esc(item.detail)}</textarea>
      </div>
      <label class="inv-num-col" role="cell"><span class="inv-cell-label">Qty</span><input class="inv-inline inv-inline-num" data-item="qty" type="number" min="0" step="1" inputmode="decimal" value="${esc(item.qty ?? 1)}" aria-label="Quantity" /></label>
      <label class="inv-num-col" role="cell"><span class="inv-cell-label">Rate</span><input class="inv-inline inv-inline-num" data-item="rate" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${esc(item.rate === "" ? "" : num(item.rate))}" aria-label="Rate" /></label>
      <span class="inv-num-col invoice-item-amount" role="cell"><span class="inv-cell-label">Amount</span><span data-item-amount></span></span>
      <button type="button" class="invoice-item-remove" data-item-remove aria-label="Remove line"><svg class="icon"><use href="#i-trash"></use></svg></button>`;
    wrap.appendChild(row);
    renumberItems();
  }

  function renumberItems() {
    document.querySelectorAll("#invItems .invoice-item").forEach((row, i) => {
      row.querySelector(".invoice-item-num").textContent = String(i + 1);
    });
  }

  function readItems() {
    return [...document.querySelectorAll("#invItems .invoice-item")].map((row) => ({
      description: row.querySelector("[data-item=description]").value.trim(),
      detail: row.querySelector("[data-item=detail]").value.trim(),
      qty: num(row.querySelector("[data-item=qty]").value) || 1,
      rate: num(row.querySelector("[data-item=rate]").value),
    })).filter((it) => it.description || it.rate);
  }

  function updateEditorTotals() {
    const cur = editing?.invoice?.currency || "TTD";
    document.querySelectorAll("#invItems .invoice-item").forEach((row) => {
      const qty = num(row.querySelector("[data-item=qty]").value) || 1;
      const rate = num(row.querySelector("[data-item=rate]").value);
      row.querySelector("[data-item-amount]").textContent = money(qty * rate);
    });
    const t = totalsOf({ items: readItems(), paymentMade: $("invPaymentMade").value });
    $("invSubTotal").textContent = money(t.subTotal);
    $("invTotal").textContent = `${cur}${money(t.total)}`;
    $("invBalanceDue").textContent = `${cur}${money(t.balanceDue)}`;
    $("invHeadBalance").textContent = `${cur}${money(t.balanceDue)}`;
  }

  function notify(message, tone = "info") {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message, { tone, duration: tone === "error" ? 9000 : 4000 });
  }

  // Shared by the editor and the Invoices list. Returns true once deleted.
  async function deleteInvoiceWithConfirm(invoice) {
    const t = totalsOf(invoice);
    const ok = window.confirm(
      `Delete invoice ${invoice.number} for ${invoice.billTo?.name || "this customer"} (${invoice.currency || "TTD"}${money(t.total)})?\n\n`
      + "It will disappear from the Invoices list and its customer link will stop working."
    );
    if (!ok) return false;
    await request({ action: "delete", id: invoice.id });
    return true;
  }

  function openEditor(invoice, { onSaved, onDeleted } = {}) {
    const modal = ensureEditor();
    editing = { invoice, onSaved, onDeleted };
    modal.querySelector("[data-inv-delete]").hidden = !invoice.id;
    const canLog = !invoice.id && typeof window.RPC_LOG_REPAIRS_FOR_INVOICE === "function";
    $("invLogBar").hidden = !canLog;
    $("invLogRepairs").checked = canLog;
    const b = invoice.business || {};
    $("invFrom").innerHTML = `<p class="inv-from-name">${esc(b.name || "JQ Electronics Ltd.")}</p>`
      + [...(b.addressLines || []), b.email].filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("");
    $("invoiceEditorTitle").textContent = invoice.id ? `Edit invoice ${invoice.number || ""}` : "New invoice";
    $("invNumber").placeholder = invoice.id ? "" : "Auto on save";
    $("invNumber").value = invoice.number || "";
    $("invTerms").value = invoice.terms || "Due on Receipt";
    $("invDate").value = invoice.invoiceDate || "";
    $("invDueDate").value = invoice.dueDate || "";
    $("invBillName").value = invoice.billTo?.name || "";
    $("invBillPhone").value = invoice.billTo?.phone || "";
    $("invBillEmail").value = invoice.billTo?.email || "";
    $("invPaymentMade").value = num(invoice.paymentMade) || "";
    $("invNotes").value = invoice.notes || "";
    $("invItems").innerHTML = "";
    (invoice.items || []).forEach(addItemRow);
    if (!(invoice.items || []).length) addItemRow({ description: "", detail: "", qty: 1, rate: "" });
    $("invError").hidden = true;
    updateEditorTotals();
    updateLogPreview();
    modal.hidden = false;
    modal.querySelector(".invoice-editor-body").scrollTop = 0;
    modal.querySelectorAll("textarea").forEach(autoGrow);
  }

  function closeEditor() {
    const modal = $("invoiceEditorModal");
    if (modal) modal.hidden = true;
    editing = null;
  }

  async function saveEditor(btn) {
    if (!editing) return;
    const err = $("invError");
    err.hidden = true;
    const items = readItems();
    const fail = (message, focusEl) => {
      err.textContent = message;
      err.hidden = false;
      err.scrollIntoView({ block: "nearest" });
      focusEl?.focus();
    };
    if (!$("invBillName").value.trim()) return fail("Enter who the invoice is billed to.", $("invBillName"));
    if (!items.length) return fail("Add at least one line item.", document.querySelector("#invItems [data-item=description]"));
    const changes = {
      number: $("invNumber").value.trim(),
      terms: $("invTerms").value.trim(),
      invoiceDate: $("invDate").value,
      dueDate: $("invDueDate").value || $("invDate").value,
      billTo: {
        name: $("invBillName").value.trim(),
        phone: $("invBillPhone").value.trim(),
        email: $("invBillEmail").value.trim(),
      },
      items,
      paymentMade: num($("invPaymentMade").value),
      notes: $("invNotes").value,
    };
    const buttons = document.querySelectorAll("#invoiceEditorModal [data-inv-save]");
    buttons.forEach((b) => { b.disabled = true; });
    const original = btn.innerHTML;
    btn.textContent = "Saving…";
    try {
      // No id yet = a new invoice from the Invoices tab; it's only created on
      // save, so cancelling never leaves a blank invoice (or a used number).
      const isNew = !editing.invoice.id;
      const logRepairs = isNew && !$("invLogBar").hidden && $("invLogRepairs").checked;
      let res = isNew
        ? await request({ action: "create", ...changes })
        : await request({ action: "update", id: editing.invoice.id, invoice: changes });
      if (logRepairs) {
        // The invoice is saved either way; if logging a repair fails, say so
        // rather than losing the invoice.
        try {
          btn.textContent = "Logging repairs…";
          const tickets = await window.RPC_LOG_REPAIRS_FOR_INVOICE(res.invoice);
          if (tickets.length) {
            res = await request({ action: "update", id: res.invoice.id, invoice: { ticketIds: tickets.map((t) => t.id) } });
            notify(`Invoice ${res.invoice.number} saved and ${tickets.length} repair${tickets.length === 1 ? "" : "s"} logged.`);
          }
        } catch (logErr) {
          notify(`Invoice ${res.invoice.number} was saved, but the repair couldn't be logged: ${logErr.message || logErr}. Log it from the Repairs tab.`, "error");
        }
      }
      const { onSaved } = editing;
      if (btn.dataset.invSave === "pdf") await downloadPdf(res.invoice);
      closeEditor();
      if (onSaved) onSaved(res.invoice, res.invoiceUrl);
    } catch (e) {
      err.textContent = "Couldn't save the invoice: " + (e.message || e);
      err.hidden = false;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      btn.innerHTML = original;
    }
  }

  /* ---- Invoices tab ---------------------------------------------------- */
  // Zoho-style list: payment summary, status filters, search, and one row per
  // invoice with its status and balance. Row → editor; quick actions to record
  // a payment or download the PDF.
  const list = { invoices: [], defaults: null, filter: "all", query: "", loaded: false, loading: false };

  const todayYmd = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dayDiff = (fromYmd, toYmd) => Math.round((Date.parse(toYmd + "T00:00:00Z") - Date.parse(fromYmd + "T00:00:00Z")) / 86400000);

  // Paid / partially paid / overdue / due — worked out from the balance and
  // due date, the way Zoho labels them.
  function invoiceStatus(inv, today = todayYmd()) {
    const t = totalsOf(inv);
    if (t.balanceDue <= 0.004) return { key: "paid", label: t.total > 0 ? "Paid" : "No charge", tone: "paid" };
    const due = inv.dueDate || inv.invoiceDate || today;
    const late = dayDiff(due, today);
    const partial = t.paymentMade > 0;
    if (late > 0) return { key: "overdue", partial, label: `Overdue by ${late} day${late === 1 ? "" : "s"}`, tone: "overdue" };
    if (partial) return { key: "partial", partial, label: "Partially paid", tone: "partial" };
    if (late === 0) return { key: "unpaid", label: "Due today", tone: "due" };
    return { key: "unpaid", label: `Due in ${-late} day${late === -1 ? "" : "s"}`, tone: "due" };
  }

  const FILTERS = [
    ["all", "All"],
    ["unpaid", "Unpaid"],
    ["overdue", "Overdue"],
    ["partial", "Partially paid"],
    ["paid", "Paid"],
  ];
  function matchesFilter(inv, filter) {
    const s = invoiceStatus(inv);
    if (filter === "all") return true;
    if (filter === "unpaid") return s.key !== "paid";
    if (filter === "partial") return !!s.partial;
    return s.key === filter;
  }

  async function loadInvoiceList() {
    if (list.loading) return;
    list.loading = true;
    if (!list.loaded) $("invListStatus").textContent = "Loading invoices…";
    try {
      const res = await request({ action: "list" });
      list.invoices = res.invoices || [];
      list.defaults = res.defaults || null;
      list.loaded = true;
      renderInvoiceList();
    } catch (err) {
      $("invListStatus").textContent = "Couldn't load invoices: " + (err.message || err);
    } finally {
      list.loading = false;
    }
  }

  function renderInvoiceList() {
    if (!$("invList")) return;
    const today = todayYmd();
    const cur = list.invoices[0]?.currency || "TTD";
    const month = today.slice(0, 7);

    // Summary
    let outstanding = 0, dueToday = 0, soon = 0, overdue = 0, collected = 0;
    for (const inv of list.invoices) {
      const t = totalsOf(inv);
      if ((inv.invoiceDate || "").startsWith(month)) collected += t.paymentMade;
      if (t.balanceDue <= 0.004) continue;
      outstanding += t.balanceDue;
      const late = dayDiff(inv.dueDate || inv.invoiceDate || today, today);
      if (late > 0) overdue += t.balanceDue;
      else if (late === 0) dueToday += t.balanceDue;
      else if (late >= -30) soon += t.balanceDue;
    }
    $("invSumOutstanding").textContent = `${cur}${money(outstanding)}`;
    $("invSumToday").textContent = `${cur}${money(dueToday)}`;
    $("invSumSoon").textContent = `${cur}${money(soon)}`;
    $("invSumOverdue").textContent = `${cur}${money(overdue)}`;
    $("invSumCollected").textContent = `${cur}${money(collected)}`;

    // Filter chips with counts
    $("invFilterChips").innerHTML = FILTERS.map(([key, label]) => {
      const count = list.invoices.filter((inv) => matchesFilter(inv, key)).length;
      return `<button type="button" class="inv-chip${list.filter === key ? " active" : ""}" role="tab" aria-selected="${list.filter === key}" data-inv-filter="${key}">${esc(label)} <span>${count}</span></button>`;
    }).join("");

    const q = list.query.trim().toLowerCase();
    const rows = list.invoices
      .filter((inv) => matchesFilter(inv, list.filter))
      .filter((inv) => !q || [inv.number, inv.billTo?.name, inv.billTo?.phone, inv.billTo?.email, ...(inv.items || []).map((i) => i.description)]
        .some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));

    $("invListStatus").textContent = list.invoices.length
      ? `${rows.length} of ${list.invoices.length} invoice${list.invoices.length === 1 ? "" : "s"}`
      : "";

    if (!rows.length) {
      $("invList").innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="icon"><use href="#i-invoice"></use></svg></div>
        <p class="empty-title">${list.invoices.length ? "No invoices match" : "No invoices yet"}</p>
        <p class="empty-sub">${list.invoices.length ? "Try another filter or search." : "Invoices are created automatically when a device is logged."}</p></div>`;
      return;
    }

    $("invList").innerHTML = `
      <div class="inv-list-row inv-list-header" aria-hidden="true">
        <span>Date</span><span>Invoice #</span><span>Customer</span><span>Status</span><span>Due date</span>
        <span class="num">Amount</span><span class="num">Balance due</span><span></span>
      </div>
      ${rows.map((inv) => {
        const t = totalsOf(inv);
        const s = invoiceStatus(inv, today);
        return `<div class="inv-list-row" role="button" tabindex="0" data-inv-open="${esc(inv.id)}" aria-label="Open invoice ${esc(inv.number)} for ${esc(inv.billTo?.name || "customer")}">
          <span class="inv-c-date">${esc(displayDate(inv.invoiceDate))}</span>
          <span class="inv-c-num">${esc(inv.number)}</span>
          <span class="inv-c-name">${esc(inv.billTo?.name || "—")}</span>
          <span class="inv-c-status"><span class="inv-status inv-status-${s.tone}">${esc(s.label)}</span></span>
          <span class="inv-c-due"><span class="inv-m-label">Due </span>${esc(displayDate(inv.dueDate))}</span>
          <span class="num inv-c-amount">${esc(cur)}${esc(money(t.total))}</span>
          <span class="num inv-c-balance"><span class="inv-m-label">Balance </span>${esc(cur)}${esc(money(t.balanceDue))}</span>
          <span class="inv-c-actions">
            ${t.balanceDue > 0.004 ? `<button type="button" class="ghost-btn inv-row-btn" data-inv-pay="${esc(inv.id)}">Record payment</button>` : ""}
            <button type="button" class="ghost-btn icon-btn inv-row-btn" data-inv-pdf="${esc(inv.id)}" aria-label="Download PDF for ${esc(inv.number)}"><svg class="icon"><use href="#i-download"></use></svg></button>
            <button type="button" class="ghost-btn icon-btn inv-row-btn inv-row-delete" data-inv-del="${esc(inv.id)}" aria-label="Delete invoice ${esc(inv.number)}"><svg class="icon"><use href="#i-trash"></use></svg></button>
          </span>
        </div>`;
      }).join("")}`;
  }

  function removeFromList(invoice) {
    list.invoices = list.invoices.filter((x) => x.id !== invoice.id);
    renderInvoiceList();
  }

  function replaceInList(saved) {
    const i = list.invoices.findIndex((x) => x.id === saved.id);
    if (i >= 0) list.invoices[i] = { ...list.invoices[i], ...saved };
    else list.invoices.unshift(saved);
    renderInvoiceList();
  }

  // Record payment: a small sheet with the balance prefilled; the amount is
  // added to the invoice's Payment Made.
  function openPaymentDialog(inv) {
    let modal = $("invPayModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "invPayModal";
      modal.className = "modal-backdrop";
      modal.hidden = true;
      modal.innerHTML = `
        <div class="modal-panel inv-pay-panel" role="dialog" aria-modal="true" aria-labelledby="invPayTitle">
          <div class="modal-header">
            <h3 id="invPayTitle">Record payment</h3>
            <button type="button" class="modal-close" data-pay-close aria-label="Close"><svg class="icon"><use href="#i-xmark"></use></svg></button>
          </div>
          <div class="modal-body">
            <p id="invPaySummary" class="inv-pay-summary"></p>
            <div class="form-field">
              <label class="field-label" for="invPayAmount">Amount received</label>
              <input id="invPayAmount" class="text-input" type="number" min="0" step="0.01" inputmode="decimal" />
            </div>
            <p id="invPayError" class="field-error" hidden></p>
          </div>
          <div class="modal-footer"><div class="form-actions">
            <button type="button" class="ghost-btn" data-pay-close>Cancel</button>
            <button type="button" class="primary-btn" id="invPaySave"><svg class="icon"><use href="#i-check"></use></svg>Record payment</button>
          </div></div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-pay-close]").forEach((b) => b.addEventListener("click", () => { modal.hidden = true; }));
    }
    const t = totalsOf(inv);
    const cur = inv.currency || "TTD";
    $("invPaySummary").innerHTML = `<strong>${esc(inv.number)}</strong> · ${esc(inv.billTo?.name || "")}<br>Total ${esc(cur)}${esc(money(t.total))} · Paid ${esc(cur)}${esc(money(t.paymentMade))} · <strong>Balance ${esc(cur)}${esc(money(t.balanceDue))}</strong>`;
    $("invPayAmount").value = t.balanceDue.toFixed(2);
    $("invPayError").hidden = true;
    $("invPaySave").onclick = async () => {
      const amount = num($("invPayAmount").value);
      if (amount <= 0) {
        $("invPayError").textContent = "Enter the amount received.";
        $("invPayError").hidden = false;
        return;
      }
      const btn = $("invPaySave");
      btn.disabled = true;
      try {
        const res = await request({ action: "update", id: inv.id, invoice: { paymentMade: num(t.paymentMade + amount) } });
        modal.hidden = true;
        replaceInList(res.invoice);
      } catch (err) {
        $("invPayError").textContent = "Couldn't record the payment: " + (err.message || err);
        $("invPayError").hidden = false;
      } finally {
        btn.disabled = false;
      }
    };
    modal.hidden = false;
    $("invPayAmount").focus();
    $("invPayAmount").select();
  }

  function newInvoiceDraft() {
    const today = todayYmd();
    return {
      id: "",
      number: "",
      invoiceDate: today,
      dueDate: today,
      terms: "Due on Receipt",
      billTo: { name: "", phone: "", email: "" },
      items: [],
      paymentMade: 0,
      notes: list.defaults?.notes || "",
      currency: "TTD",
      business: list.defaults?.business || null,
    };
  }

  function bindInvoiceList() {
    const view = $("view-invoices");
    if (!view || view.dataset.bound) return;
    view.dataset.bound = "1";
    $("invListRefresh").addEventListener("click", loadInvoiceList);
    $("invListNew").addEventListener("click", () => {
      openEditor(newInvoiceDraft(), { onSaved: (saved) => replaceInList(saved) });
    });
    $("invListSearch").addEventListener("input", (e) => { list.query = e.target.value; renderInvoiceList(); });
    $("invFilterChips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-inv-filter]");
      if (!chip) return;
      list.filter = chip.dataset.invFilter;
      renderInvoiceList();
    });
    const byId = (id) => list.invoices.find((x) => x.id === id);
    $("invList").addEventListener("click", async (e) => {
      const pay = e.target.closest("[data-inv-pay]");
      const pdf = e.target.closest("[data-inv-pdf]");
      const del = e.target.closest("[data-inv-del]");
      if (del) {
        e.stopPropagation();
        const inv = byId(del.dataset.invDel);
        del.disabled = true;
        try {
          if (await deleteInvoiceWithConfirm(inv)) removeFromList(inv);
        } catch (err) {
          $("invListStatus").textContent = "Couldn't delete the invoice: " + (err.message || err);
        } finally {
          del.disabled = false;
        }
        return;
      }
      const row = e.target.closest("[data-inv-open]");
      if (pay) { e.stopPropagation(); openPaymentDialog(byId(pay.dataset.invPay)); return; }
      if (pdf) {
        e.stopPropagation();
        pdf.disabled = true;
        try { await downloadPdf(byId(pdf.dataset.invPdf)); } catch (err) { $("invListStatus").textContent = err.message || String(err); }
        finally { pdf.disabled = false; }
        return;
      }
      if (row) openEditor(byId(row.dataset.invOpen), { onSaved: (saved) => replaceInList(saved), onDeleted: removeFromList });
    });
    $("invList").addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-inv-open]")) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  window.addEventListener("rpc-enter-invoices", () => {
    bindInvoiceList();
    loadInvoiceList();
  });

  window.RPC_INVOICE = { buildPdf, downloadPdf, sharePdf, canSharePdf, renderCard, openEditor, totalsOf, invoiceStatus };
})();
