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
        s.src = "assets/vendor/jspdf.umd.min.js?v=4.2.1";
        s.onload = () => (window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error("PDF generator failed to load")));
        s.onerror = () => { jsPdfLoading = null; reject(new Error("Couldn't load the PDF generator — check the connection.")); };
        document.head.appendChild(s);
      });
    }
    return jsPdfLoading;
  }

  // The layout itself lives in lib/invoice-pdf.js, shared with the server
  // (the "View invoice" link in emails opens the same PDF).
  let pdfModule = null;
  function loadPdfModule() {
    pdfModule ||= import("../lib/invoice-pdf.js?v=1").catch((err) => { pdfModule = null; throw err; });
    return pdfModule;
  }

  async function buildPdf(invoice) {
    const [JsPDF, { drawInvoicePdf }] = await Promise.all([loadJsPdf(), loadPdfModule()]);
    return drawInvoicePdf(JsPDF, invoice);
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
          <button type="button" class="ghost-btn" data-inv-card="email"><svg class="icon"><use href="#i-mail"></use></svg>Email</button>
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
        if (kind === "email") window.RPC_EMAIL?.openCompose(invoice, { onSent: (sent, sentUrl) => renderCard(el, sent, { url: sentUrl || url }) });
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
                <div class="inv-combo">
                  <input id="invBillName" class="inv-inline inv-inline-bold" autocomplete="off" placeholder="Customer name or phone" aria-label="Bill to name" aria-autocomplete="list" aria-controls="invCustList" aria-expanded="false" />
                  <div id="invCustList" class="inv-cust-list" role="listbox" hidden></div>
                </div>
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

            <div id="invSuggest" class="inv-suggest" hidden></div>
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
          <button type="button" class="ghost-btn" data-inv-save="email"><svg class="icon"><use href="#i-mail"></use></svg>Save &amp; email</button>
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
    modal.querySelector("#invBillPhone").addEventListener("input", updateLogPreview);
    modal.querySelector("#invBillName").addEventListener("input", updateLogPreview);
    modal.querySelector("#invItems").addEventListener("click", (e) => {
      const remove = e.target.closest("[data-item-remove]");
      if (!remove) return;
      remove.closest(".invoice-item").remove();
      renumberItems();
      updateEditorTotals();
    });
    modal.querySelector("#invPaymentMade").addEventListener("input", updateEditorTotals);
    bindCustomerSuggest();
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

  /* ---- Customer lookup + repair suggestions ----------------------------
     Typing in Bill To offers customers already in the system (saved
     directory + past repairs). Picking one fills name, phone and email,
     puts their device on the first empty line, and shows that device's
     suggested repairs; clicking one fills the line with its name and price. */
  const suggest = { devices: [], device: "", issues: "", matches: [], active: -1 };

  function bindCustomerSuggest() {
    const input = $("invBillName");
    const listEl = $("invCustList");
    const close = () => {
      listEl.hidden = true;
      input.setAttribute("aria-expanded", "false");
      suggest.active = -1;
    };
    const show = () => {
      if (typeof window.RPC_CUSTOMER_SUGGEST !== "function") return;
      suggest.matches = window.RPC_CUSTOMER_SUGGEST(input.value);
      if (!suggest.matches.length) return close();
      listEl.innerHTML = suggest.matches.map((c, i) => `
        <button type="button" class="inv-cust-option" role="option" data-cust="${i}" aria-selected="false">
          <strong>${esc(c.name)}</strong>
          <span>${esc([c.phone, c.devices[0] ? "Last: " + c.devices[0].device : ""].filter(Boolean).join(" · "))}</span>
        </button>`).join("");
      listEl.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const highlight = (i) => {
      suggest.active = i;
      listEl.querySelectorAll(".inv-cust-option").forEach((el, j) => {
        el.classList.toggle("active", j === i);
        el.setAttribute("aria-selected", j === i ? "true" : "false");
      });
    };
    input.addEventListener("input", show);
    // If customers/repairs were still loading when typing started, show the
    // matches as soon as they arrive.
    suggest.refresh = () => { if (document.activeElement === input && input.value.trim().length >= 2) show(); };
    input.addEventListener("keydown", (e) => {
      if (listEl.hidden) return;
      const n = suggest.matches.length;
      if (e.key === "ArrowDown") { e.preventDefault(); highlight((suggest.active + 1) % n); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight((suggest.active - 1 + n) % n); }
      else if (e.key === "Enter" && suggest.active >= 0) { e.preventDefault(); pickCustomer(suggest.matches[suggest.active]); close(); }
      else if (e.key === "Escape") { e.stopPropagation(); close(); }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    // mousedown so the choice lands before the input's blur closes the list.
    listEl.addEventListener("mousedown", (e) => {
      const opt = e.target.closest("[data-cust]");
      if (!opt) return;
      e.preventDefault();
      pickCustomer(suggest.matches[Number(opt.dataset.cust)]);
      close();
    });
    $("invSuggest").addEventListener("click", (e) => {
      const dev = e.target.closest("[data-suggest-device]");
      if (dev) {
        const d = suggest.devices[Number(dev.dataset.suggestDevice)];
        setSuggestDevice(d.device, d.issues);
        return;
      }
      const rep = e.target.closest("[data-suggest-repair]");
      if (rep) addSuggestedRepair(Number(rep.dataset.suggestRepair));
      const openExisting = e.target.closest("[data-open-existing]");
      if (openExisting) {
        const x = (suggest.existing || [])[Number(openExisting.dataset.openExisting)];
        if (!x) return;
        // Carry over anything typed on the new invoice as extra lines.
        const typed = readItems();
        const merged = { ...x.invoice, items: [...(x.invoice.items || []), ...typed.filter((t) => !(x.invoice.items || []).some((i) => i.description === t.description))] };
        const { onSaved } = editing || {};
        closeEditor();
        openEditor(merged, { onSaved: (saved, url) => { replaceInList(saved); if (onSaved) onSaved(saved, url); } });
      }
    });
  }

  function pickCustomer(c) {
    if (!c) return;
    const set = (id, v) => { const el = $(id); el.value = v || ""; el.dispatchEvent(new Event("input", { bubbles: true })); };
    $("invBillName").value = c.name;
    set("invBillPhone", c.phone);
    set("invBillEmail", c.email);
    suggest.devices = c.devices || [];
    checkExistingInvoice(c);
    if (suggest.devices.length) {
      const first = suggest.devices[0];
      // Their most recent device goes on the first empty line.
      const empty = [...document.querySelectorAll("#invItems .invoice-item")]
        .find((row) => !row.querySelector("[data-item=description]").value.trim());
      if (empty) {
        const desc = empty.querySelector("[data-item=description]");
        desc.value = first.device;
        desc.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setSuggestDevice(first.device, first.issues);
    } else {
      renderSuggest();
    }
  }

  // Picking a client with an open repair that's already invoiced (new
  // invoices only): offer that invoice, so they keep one invoice per job.
  async function checkExistingInvoice(c) {
    suggest.existing = [];
    if (editing?.invoice?.id || typeof window.RPC_OPEN_INVOICED_REPAIRS !== "function") return;
    try {
      if (!list.loaded) {
        const res = await request({ action: "list" });
        list.invoices = res.invoices || [];
        list.defaults = res.defaults || list.defaults;
        list.loaded = true;
      }
      suggest.existing = window.RPC_OPEN_INVOICED_REPAIRS(c, list.invoices);
    } catch (_) {
      suggest.existing = [];
    }
    renderSuggest();
  }

  function setSuggestDevice(device, issues) {
    suggest.device = device;
    suggest.issues = issues || "";
    renderSuggest();
  }

  function currentRepairSuggestions() {
    return suggest.device && typeof window.RPC_REPAIR_SUGGESTIONS === "function"
      ? window.RPC_REPAIR_SUGGESTIONS(suggest.device, suggest.issues)
      : [];
  }

  function renderSuggest() {
    const box = $("invSuggest");
    if (!box) return;
    const repairs = currentRepairSuggestions();
    const existing = suggest.existing || [];
    if (!suggest.device && !existing.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = `
      ${existing.map((x, i) => `<div class="inv-existing">
        <p><strong>${esc(x.invoice.billTo?.name || "This client")} already has invoice ${esc(x.invoice.number)}</strong>
        for their open ${esc(x.ticket.device || "repair")} (${esc(x.ticket.status)}). Add these items there to keep one invoice for the job.</p>
        <button type="button" class="primary-btn" data-open-existing="${i}"><svg class="icon" aria-hidden="true"><use href="#i-pencil"></use></svg>Open ${esc(x.invoice.number)} instead</button>
      </div>`).join("")}
      ${suggest.device ? `
      ${suggest.devices.length > 1 ? `<div class="inv-suggest-row"><span class="inv-suggest-label">Their devices</span>
        ${suggest.devices.map((d, i) => `<button type="button" class="inv-suggest-chip${d.device === suggest.device ? " active" : ""}" data-suggest-device="${i}">${esc(d.device)}</button>`).join("")}</div>` : ""}
      <div class="inv-suggest-row"><span class="inv-suggest-label">Suggested repairs · ${esc(suggest.device)}</span>
        ${repairs.map((r, i) => `<button type="button" class="inv-suggest-chip inv-suggest-repair${r.fromRepair ? " is-match" : ""}" data-suggest-repair="${i}" title="${r.fromRepair ? "Matches the issue on their repair" : "Add this repair"}">
          <svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>${esc(r.label)}${r.rate != null ? ` <span>${esc(money(r.rate))}</span>` : ""}</button>`).join("")}
      </div>
      <p class="inv-suggest-note">Suggestions aren't printed. Click one to add it as a line${repairs.some((r) => r.fromRepair) ? " — highlighted ones match the issue they came in with" : ""}.</p>` : ""}`;
  }

  // Fills the line that holds just this device's name (from picking the
  // customer) or an empty one; otherwise adds a new line.
  function addSuggestedRepair(index) {
    const s = currentRepairSuggestions()[index];
    if (!s) return;
    const rows = [...document.querySelectorAll("#invItems .invoice-item")];
    const deviceKey = suggest.device.trim().toLowerCase();
    let row = rows.find((r) => {
      const v = r.querySelector("[data-item=description]").value.trim().toLowerCase();
      return v === deviceKey || v === "";
    });
    if (!row) {
      addItemRow({ description: "", detail: "", qty: 1, rate: "" });
      const all = document.querySelectorAll("#invItems .invoice-item");
      row = all[all.length - 1];
    }
    const desc = row.querySelector("[data-item=description]");
    desc.value = `${suggest.device} ${s.label}`;
    const rate = row.querySelector("[data-item=rate]");
    if (s.rate != null) rate.value = s.rate;
    desc.dispatchEvent(new Event("input", { bubbles: true }));
    if (s.rate == null) rate.focus();
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
    const billTo = { name: $("invBillName").value, phone: $("invBillPhone").value };
    const lines = typeof window.RPC_INVOICE_REPAIR_PREVIEW === "function" ? window.RPC_INVOICE_REPAIR_PREVIEW(readItems(), billTo) : [];
    preview.textContent = lines.length
      ? `On save: ${lines.join(" · ")}. Fees and accessories are added to the repair, not logged separately.`
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

  // Keeps linked repairs' sale/paid amounts in step with the invoice (see
  // RPC_SYNC_REPAIRS_FROM_INVOICE in assets/intake.js). Never blocks a save.
  async function syncRepairs(invoice) {
    if (typeof window.RPC_SYNC_REPAIRS_FROM_INVOICE !== "function") return;
    try {
      const { updated } = await window.RPC_SYNC_REPAIRS_FROM_INVOICE(invoice);
      if (updated) notify(`Invoice saved — ${updated} repair${updated === 1 ? "" : "s"} updated to match.`);
    } catch (err) {
      notify(`Invoice saved, but the repair couldn't be updated: ${err.message || err}`, "error");
    }
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
    // Same layer as other windows, so move it last to open on top of
    // whatever launched it (e.g. the dashboard's Sales breakdown).
    document.body.appendChild(modal);
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
    suggest.devices = [];
    suggest.device = "";
    suggest.issues = "";
    suggest.existing = [];
    renderSuggest();
    if (typeof window.RPC_PREPARE_CUSTOMER_SUGGEST === "function") {
      Promise.resolve(window.RPC_PREPARE_CUSTOMER_SUGGEST()).then(() => suggest.refresh && suggest.refresh());
    }
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
      if (!isNew) await syncRepairs(res.invoice);
      if (logRepairs) {
        // The invoice is saved either way; if logging a repair fails, say so
        // rather than losing the invoice.
        try {
          btn.textContent = "Logging repairs…";
          const { tickets, created, reused } = await window.RPC_LOG_REPAIRS_FOR_INVOICE(res.invoice);
          if (tickets.length) {
            res = await request({ action: "update", id: res.invoice.id, invoice: { ticketIds: tickets.map((t) => t.id) } });
            // Sale amounts and payment come from the invoice, once.
            await window.RPC_SYNC_REPAIRS_FROM_INVOICE?.(res.invoice);
            const parts = [];
            if (reused) parts.push(`${reused} existing repair${reused === 1 ? "" : "s"} updated`);
            if (created) parts.push(`${created} new repair${created === 1 ? "" : "s"} logged`);
            notify(`Invoice ${res.invoice.number} saved — ${parts.join(" and ")}.`);
          }
        } catch (logErr) {
          notify(`Invoice ${res.invoice.number} was saved, but the repair couldn't be logged: ${logErr.message || logErr}. Log it from the Repairs tab.`, "error");
        }
      }
      const { onSaved } = editing;
      if (btn.dataset.invSave === "pdf") await downloadPdf(res.invoice);
      closeEditor();
      if (onSaved) onSaved(res.invoice, res.invoiceUrl);
      if (btn.dataset.invSave === "email") {
        window.RPC_EMAIL?.openCompose(res.invoice, { onSent: (sent, url) => { if (onSaved) onSaved(sent, url); } });
      }
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

    const rows = visibleInvoices();

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
        <span>Invoice</span><span>Customer</span><span>Status</span>
        <span class="num">Amount</span><span class="num">Paid</span><span class="num">Balance</span><span></span>
      </div>
      ${rows.map((inv) => {
        const t = totalsOf(inv);
        const s = invoiceStatus(inv, today);
        const who = esc(inv.billTo?.name || "customer");
        const itemsText = (inv.items || []).map((i) => i.description).filter(Boolean).join(" · ");
        const balanceHtml = t.balanceDue > 0.004
          ? `<span class="bal-pill is-due">${esc(cur)}${esc(money(t.balanceDue))} due</span>
             <button type="button" class="bal-mark" data-inv-markpaid="${esc(inv.id)}" aria-label="Mark ${who}'s ${esc(cur)}${esc(money(t.balanceDue))} balance as paid"><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>Mark paid</button>`
          : t.balanceDue < -0.004
            ? `<span class="bal-pill is-credit">${esc(cur)}${esc(money(-t.balanceDue))} over</span>`
            : `<span class="bal-pill is-paid"><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>Paid</span>`;
        return `<div class="inv-list-row" role="button" tabindex="0" data-inv-open="${esc(inv.id)}" aria-label="Open invoice ${esc(inv.number)} for ${who}">
          <span class="inv-c-inv">
            <span class="inv-num-line">
              <span class="inv-num-btn" title="Edit invoice ${esc(inv.number)}"><svg class="icon" aria-hidden="true"><use href="#i-pencil"></use></svg><span>${esc(inv.number)}</span></span>
              ${(inv.emails || []).length ? `<span class="inv-sent" title="Emailed ${esc(new Date(inv.emails[inv.emails.length - 1].sentAt).toLocaleString())} to ${esc((inv.emails[inv.emails.length - 1].to || []).join(", "))}"><svg class="icon" aria-hidden="true"><use href="#i-mail"></use></svg><span class="visually-hidden">Emailed</span></span>` : ""}
            </span>
            <small>${esc(displayDate(inv.invoiceDate))}${inv.dueDate && inv.dueDate !== inv.invoiceDate ? ` · Due ${esc(displayDate(inv.dueDate))}` : ""}</small>
          </span>
          <span class="inv-c-name">
            <strong>${esc(inv.billTo?.name || "—")}</strong>
            ${itemsText ? `<small title="${esc(itemsText)}">${esc(itemsText)}</small>` : ""}
          </span>
          <span class="inv-c-status"><span class="inv-pill inv-pill-${s.tone}">${esc(s.label)}</span></span>
          <span class="inv-money inv-c-amount"><span class="sales-m-label">Amount</span><strong>${esc(cur)}${esc(money(t.total))}</strong></span>
          <span class="inv-money inv-c-paid">
            <span class="sales-m-label">Paid</span>
            <label class="money-field"><span aria-hidden="true">$</span><input class="sales-amt inv-paid-input" type="text" inputmode="decimal" autocomplete="off" data-inv-paid="${esc(inv.id)}" value="${esc(money(t.paymentMade))}" aria-label="Amount paid on invoice ${esc(inv.number)}" /></label>
          </span>
          <span class="inv-money inv-c-balance"><span class="sales-m-label">Balance</span>${balanceHtml}</span>
          <span class="inv-c-actions">
            <button type="button" class="ghost-btn icon-btn inv-row-btn" data-inv-email="${esc(inv.id)}" aria-label="Email invoice ${esc(inv.number)}" title="Email invoice"><svg class="icon"><use href="#i-mail"></use></svg></button>
            <button type="button" class="ghost-btn icon-btn inv-row-btn" data-inv-pdf="${esc(inv.id)}" aria-label="Download PDF for ${esc(inv.number)}" title="Download PDF"><svg class="icon"><use href="#i-download"></use></svg></button>
            <button type="button" class="ghost-btn icon-btn inv-row-btn inv-row-delete" data-inv-del="${esc(inv.id)}" aria-label="Delete invoice ${esc(inv.number)}" title="Delete invoice"><svg class="icon"><use href="#i-trash"></use></svg></button>
          </span>
        </div>`;
      }).join("")}`;
  }

  function removeFromList(invoice) {
    list.invoices = list.invoices.filter((x) => x.id !== invoice.id);
    renderInvoiceList();
  }

  // What the list is showing right now (filter + search), newest first.
  function visibleInvoices() {
    const q = list.query.trim().toLowerCase();
    return list.invoices
      .filter((inv) => matchesFilter(inv, list.filter))
      .filter((inv) => !q || [inv.number, inv.billTo?.name, inv.billTo?.phone, inv.billTo?.email, ...(inv.items || []).map((i) => i.description)]
        .some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  // CSV of the invoices currently listed (so a filter or search narrows it),
  // one row per invoice plus a totals row. Opens in Excel/Numbers/Sheets.
  function exportInvoicesCsv() {
    const rows = visibleInvoices();
    const today = todayYmd();
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const amt = (v) => num(v).toFixed(2);
    const lines = [["Invoice date", "Invoice #", "Customer", "Phone", "Email", "Items", "Status", "Due date", "Total (TTD)", "Paid (TTD)", "Balance due (TTD)"]];
    let total = 0, paid = 0, balance = 0;
    for (const inv of rows) {
      const t = totalsOf(inv);
      total += t.total; paid += t.paymentMade; balance += t.balanceDue;
      lines.push([
        inv.invoiceDate, inv.number, inv.billTo?.name, inv.billTo?.phone, inv.billTo?.email,
        (inv.items || []).map((i) => `${i.description}${num(i.qty) !== 1 ? ` x${num(i.qty)}` : ""} (${money(num(i.qty || 1) * num(i.rate))})`).join("; "),
        invoiceStatus(inv, today).label, inv.dueDate, amt(t.total), amt(t.paymentMade), amt(t.balanceDue),
      ]);
    }
    lines.push([]);
    lines.push(["Total", "", `${rows.length} invoice${rows.length === 1 ? "" : "s"}`, "", "", "", "", "", amt(total), amt(paid), amt(balance)]);
    const csv = "\ufeff" + lines.map((r) => r.map(cell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoices-${list.filter === "all" ? "all" : list.filter}-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function replaceInList(saved) {
    const i = list.invoices.findIndex((x) => x.id === saved.id);
    if (i >= 0) list.invoices[i] = { ...list.invoices[i], ...saved };
    else list.invoices.unshift(saved);
    renderInvoiceList();
  }

  // Paid is edited in place (same as the dashboard's Sales breakdown):
  // saved on Enter or when the field is left; "Mark paid" settles the
  // balance. Linked repairs are updated to match.
  const parseMoney = (raw) => {
    const cleaned = String(raw ?? "").replace(/[$,\s]/g, "");
    return cleaned === "" ? NaN : Math.round(Number(cleaned) * 100) / 100;
  };

  async function saveInvoicePaid(inv, value, { input, button } = {}) {
    const row = $("invList").querySelector(`[data-inv-open="${CSS.escape(inv.id)}"]`);
    if (!Number.isFinite(value) || value < 0) {
      if (input) {
        const field = input.closest(".money-field") || input;
        field.classList.add("is-invalid");
        input.value = input.defaultValue;
        setTimeout(() => field.classList.remove("is-invalid"), 1500);
      }
      return;
    }
    if (value === num(inv.paymentMade)) { if (input) input.value = input.defaultValue; return; }
    row?.classList.add("is-saving");
    if (button) button.disabled = true;
    try {
      const res = await request({ action: "update", id: inv.id, invoice: { paymentMade: value } });
      replaceInList(res.invoice);
      const fresh = $("invList").querySelector(`[data-inv-open="${CSS.escape(inv.id)}"]`);
      fresh?.classList.add("is-saved");
      setTimeout(() => fresh?.classList.remove("is-saved"), 1200);
      await syncRepairs(res.invoice);
    } catch (err) {
      row?.classList.remove("is-saving");
      if (input) input.value = input.defaultValue;
      if (button) button.disabled = false;
      notify("Couldn't save the payment: " + (err.message || err), "error");
    }
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
    $("invListExport").addEventListener("click", exportInvoicesCsv);
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
      if (e.target.closest(".money-field")) { e.stopPropagation(); return; }
      const emailBtn = e.target.closest("[data-inv-email]");
      if (emailBtn) {
        e.stopPropagation();
        const inv = byId(emailBtn.dataset.invEmail);
        if (inv) window.RPC_EMAIL?.openCompose(inv, { onSent: (sent) => replaceInList(sent) });
        return;
      }
      const markPaid = e.target.closest("[data-inv-markpaid]");
      if (markPaid) {
        e.stopPropagation();
        const inv = byId(markPaid.dataset.invMarkpaid);
        if (inv) saveInvoicePaid(inv, totalsOf(inv).total, { button: markPaid });
        return;
      }
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
      if (pdf) {
        e.stopPropagation();
        pdf.disabled = true;
        try { await downloadPdf(byId(pdf.dataset.invPdf)); } catch (err) { $("invListStatus").textContent = err.message || String(err); }
        finally { pdf.disabled = false; }
        return;
      }
      if (row) openEditor(byId(row.dataset.invOpen), { onSaved: (saved) => replaceInList(saved), onDeleted: removeFromList });
    });
    $("invList").addEventListener("focusin", (e) => {
      if (e.target.matches(".inv-paid-input")) setTimeout(() => e.target.select(), 0);
    });
    $("invList").addEventListener("change", (e) => {
      const input = e.target.closest(".inv-paid-input");
      if (!input) return;
      const inv = byId(input.dataset.invPaid);
      if (inv) saveInvoicePaid(inv, parseMoney(input.value), { input });
    });
    $("invList").addEventListener("keydown", (e) => {
      if (e.target.matches(".inv-paid-input")) {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); e.target.blur(); }
        if (e.key === "Escape") { e.stopPropagation(); e.target.value = e.target.defaultValue; e.target.blur(); }
        return;
      }
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

  window.RPC_INVOICE_CLOSE_EDITOR = closeEditor;
  window.RPC_INVOICE = { buildPdf, downloadPdf, sharePdf, canSharePdf, renderCard, openEditor, totalsOf, invoiceStatus };
})();
