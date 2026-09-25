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
        if (kind === "edit") openEditor(invoice, { onSaved: (saved, savedUrl) => renderCard(el, saved, { url: savedUrl || url }) });
      };
    });
  }

  /* ---- Editor ---------------------------------------------------------- */
  let editing = null; // { invoice, onSaved }

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
          <h3 id="invoiceEditorTitle">Edit invoice</h3>
          <button type="button" class="modal-close" data-inv-close aria-label="Close"><svg class="icon"><use href="#i-xmark"></use></svg></button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="form-field"><label class="field-label" for="invNumber">Invoice #</label><input id="invNumber" class="text-input" autocomplete="off" /></div>
            <div class="form-field"><label class="field-label" for="invTerms">Terms</label><input id="invTerms" class="text-input" list="invTermsList" autocomplete="off" /></div>
            <datalist id="invTermsList"><option value="Due on Receipt"></option><option value="Net 7"></option><option value="Net 15"></option><option value="Net 30"></option></datalist>
            <div class="form-field"><label class="field-label" for="invDate">Invoice date</label><input id="invDate" class="text-input" type="date" /></div>
            <div class="form-field"><label class="field-label" for="invDueDate">Due date</label><input id="invDueDate" class="text-input" type="date" /></div>
            <div class="form-field form-field-full"><label class="field-label" for="invBillName">Bill to</label><input id="invBillName" class="text-input" autocomplete="off" /></div>
            <div class="form-field"><label class="field-label" for="invBillPhone">Phone</label><input id="invBillPhone" class="text-input" type="tel" autocomplete="off" /></div>
            <div class="form-field"><label class="field-label" for="invBillEmail">Email</label><input id="invBillEmail" class="text-input" type="email" autocomplete="off" /></div>
          </div>
          <p class="field-label invoice-items-label">Items</p>
          <div id="invItems" class="invoice-items"></div>
          <button type="button" class="ghost-btn invoice-add-item" data-inv-add-item><svg class="icon"><use href="#i-plus"></use></svg>Add line</button>
          <div class="invoice-editor-totals">
            <div><span>Sub total</span><strong id="invSubTotal"></strong></div>
            <div class="invoice-payment-row">
              <label for="invPaymentMade">Payment made</label>
              <input id="invPaymentMade" class="text-input" type="number" min="0" step="0.01" inputmode="decimal" />
            </div>
            <div class="invoice-balance-row"><span>Balance due</span><strong id="invBalanceDue"></strong></div>
          </div>
          <div class="form-field form-field-full">
            <label class="field-label" for="invNotes">Notes</label>
            <textarea id="invNotes" class="text-input" rows="8"></textarea>
          </div>
          <p id="invError" class="field-error" hidden></p>
        </div>
        <div class="modal-footer"><div class="form-actions">
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
    modal.querySelector("#invItems").addEventListener("input", updateEditorTotals);
    modal.querySelector("#invItems").addEventListener("click", (e) => {
      const remove = e.target.closest("[data-item-remove]");
      if (!remove) return;
      remove.closest(".invoice-item").remove();
      renumberItems();
      updateEditorTotals();
    });
    modal.querySelector("#invPaymentMade").addEventListener("input", updateEditorTotals);
    modal.querySelectorAll("[data-inv-save]").forEach((btn) => btn.addEventListener("click", () => saveEditor(btn)));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) { e.stopPropagation(); closeEditor(); }
    }, true);
    return modal;
  }

  function addItemRow(item) {
    const wrap = $("invItems");
    const row = document.createElement("div");
    row.className = "invoice-item";
    row.innerHTML = `
      <span class="invoice-item-num"></span>
      <div class="invoice-item-fields">
        <input class="text-input" data-item="description" placeholder="Item, e.g. Pixel 7 Pro Screen Replacement" value="${esc(item.description)}" aria-label="Item description" />
        <textarea class="text-input" data-item="detail" rows="1" placeholder="Details (optional)" aria-label="Item details">${esc(item.detail)}</textarea>
        <div class="invoice-item-numbers">
          <label>Qty<input class="text-input" data-item="qty" type="number" min="0" step="1" inputmode="decimal" value="${esc(item.qty ?? 1)}" /></label>
          <label>Rate<input class="text-input" data-item="rate" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(item.rate === "" ? "" : num(item.rate))}" /></label>
          <span class="invoice-item-amount" data-item-amount></span>
        </div>
      </div>
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
    $("invSubTotal").textContent = `${cur}${money(t.subTotal)}`;
    $("invBalanceDue").textContent = `${cur}${money(t.balanceDue)}`;
  }

  function openEditor(invoice, { onSaved } = {}) {
    const modal = ensureEditor();
    editing = { invoice, onSaved };
    $("invoiceEditorTitle").textContent = `Edit invoice ${invoice.number || ""}`;
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
    modal.hidden = false;
    $("invNumber").focus();
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
    if (!items.length) {
      err.textContent = "Add at least one line item.";
      err.hidden = false;
      return;
    }
    if (!$("invBillName").value.trim()) {
      err.textContent = "Enter who the invoice is billed to.";
      err.hidden = false;
      return;
    }
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
      const res = await request({ action: "update", id: editing.invoice.id, invoice: changes });
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

  window.RPC_INVOICE = { buildPdf, downloadPdf, sharePdf, canSharePdf, renderCard, openEditor, totalsOf };
})();
