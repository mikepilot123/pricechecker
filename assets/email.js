/* ============================================================
   Emailing invoices
   ------------------------------------------------------------
   • Settings → Email: link the mailboxes invoices are sent from (Gmail
     with an app password, Zoho Mail, or any SMTP server), test them, pick
     the default.
   • "Send invoice" dialog (Zoho-style): From / To / Cc / Subject /
     Message, attach the invoice PDF, optional "View invoice" link.
   The server side is lib/email.js via api/invoice.js. Uses
   window.RPC_INVOICE_REQUEST (assets/intake.js) and window.RPC_INVOICE
   (assets/invoice.js, for the PDF). Exposes window.RPC_EMAIL.
   ============================================================ */
(() => {
  const $ = (id) => document.getElementById(id);
  const request = (body) => window.RPC_INVOICE_REQUEST(body);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const money = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const displayDate = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  };
  const notify = (message, tone = "info") => {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message, { tone, duration: tone === "error" ? 9000 : 4000 });
  };
  const LAST_SENDER_KEY = "rpc_invoice_email_sender";

  let senders = [];
  let sendersLoaded = false;

  async function loadSenders(force = false) {
    if (sendersLoaded && !force) return senders;
    const res = await request({ action: "senders" });
    senders = res.senders || [];
    sendersLoaded = true;
    return senders;
  }

  const PROVIDERS = {
    gmail: { name: "Gmail", host: "smtp.gmail.com", port: 465 },
    zoho: { name: "Zoho Mail", host: "smtp.zoho.com", port: 465 },
    smtp: { name: "Other (SMTP)", host: "", port: 587 },
  };

  /* ---- Settings → Email ------------------------------------------------ */
  function renderSenderList(message = "") {
    const box = $("emailSenderList");
    if (!box) return;
    const err = $("emailSettingsError");
    err.hidden = !message;
    if (message) err.textContent = message;
    if (!senders.length) {
      box.innerHTML = `<div class="email-empty">
        <svg class="icon" aria-hidden="true"><use href="#i-mail"></use></svg>
        <p><strong>No email account linked yet.</strong><br>Add the mailbox you want invoices to come from — e.g. the shop's Gmail.</p>
      </div>`;
      return;
    }
    box.innerHTML = senders.map((s) => `
      <div class="email-sender${s.isDefault ? " is-default" : ""}">
        <span class="email-sender-icon" aria-hidden="true"><svg class="icon"><use href="#i-mail"></use></svg></span>
        <div class="email-sender-main">
          <p class="email-sender-name">${esc(s.fromName ? `${s.fromName} <${s.fromEmail}>` : s.fromEmail)}
            ${s.isDefault ? `<span class="email-badge">Default</span>` : ""}</p>
          <p class="email-sender-meta">${esc(s.builtIn ? "Built-in mail service (set up on the server)" : `${PROVIDERS[s.provider]?.name || "SMTP"} · ${s.host}:${s.port}`)}
            ${s.lastTestedAt && !s.lastError ? ` · <span class="email-ok">Working</span>` : ""}</p>
          ${s.lastError ? `<p class="email-sender-error">${esc(s.lastError)}</p>` : ""}
        </div>
        <div class="email-sender-actions">
          ${!s.isDefault ? `<button type="button" class="ghost-btn" data-sender-default="${esc(s.id)}">Make default</button>` : ""}
          <button type="button" class="ghost-btn" data-sender-test="${esc(s.id)}">Send test</button>
          ${!s.builtIn ? `<button type="button" class="ghost-btn" data-sender-edit="${esc(s.id)}">Edit</button>
          <button type="button" class="ghost-btn icon-btn danger-btn" data-sender-remove="${esc(s.id)}" aria-label="Remove ${esc(s.fromEmail)}"><svg class="icon"><use href="#i-trash"></use></svg></button>` : ""}
        </div>
      </div>`).join("");
  }

  function showSenderForm(sender) {
    const form = $("emailSenderForm");
    form.hidden = false;
    $("emailAddSender").hidden = true;
    form.dataset.id = sender?.id || "";
    const provider = sender?.provider || "gmail";
    setProvider(provider, !sender);
    $("emailFromName").value = sender ? sender.fromName : "JQ Electronics";
    $("emailFromAddress").value = sender?.fromEmail || "";
    $("emailPassword").value = "";
    $("emailPassword").placeholder = sender ? "Leave blank to keep the saved password" : (provider === "gmail" ? "16-character app password" : "Password");
    $("emailHost").value = sender?.host || PROVIDERS[provider].host;
    $("emailPort").value = sender?.port || PROVIDERS[provider].port;
    $("emailUsername").value = sender?.username && sender.username !== sender.fromEmail ? sender.username : "";
    $("emailMakeDefault").checked = sender ? sender.isDefault : !senders.some((s) => !s.builtIn);
    $("emailFormError").hidden = true;
    $("emailSenderFormTitle").textContent = sender ? `Edit ${sender.fromEmail}` : "Add an email account";
    $("emailFromAddress").focus();
  }

  function hideSenderForm() {
    $("emailSenderForm").hidden = true;
    $("emailAddSender").hidden = false;
  }

  function setProvider(provider, applyPreset = true) {
    document.querySelectorAll("[data-email-provider]").forEach((b) => {
      const on = b.dataset.emailProvider === provider;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    $("emailSenderForm").dataset.provider = provider;
    $("emailGmailHelp").hidden = provider !== "gmail";
    $("emailServerFields").open = provider === "smtp";
    $("emailPasswordLabel").textContent = provider === "gmail" ? "Google app password" : "Password";
    if (applyPreset && PROVIDERS[provider].host) {
      $("emailHost").value = PROVIDERS[provider].host;
      $("emailPort").value = PROVIDERS[provider].port;
    }
  }

  async function saveSenderForm(e) {
    e.preventDefault();
    const form = $("emailSenderForm");
    const err = $("emailFormError");
    err.hidden = true;
    const btn = $("emailSaveSender");
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "Saving…";
    try {
      const res = await request({
        action: "saveSender",
        sender: {
          id: form.dataset.id || "",
          provider: form.dataset.provider,
          fromName: $("emailFromName").value,
          fromEmail: $("emailFromAddress").value,
          password: $("emailPassword").value,
          host: $("emailHost").value,
          port: $("emailPort").value,
          username: $("emailUsername").value,
          isDefault: $("emailMakeDefault").checked,
        },
      });
      senders = res.senders || [];
      hideSenderForm();
      renderSenderList();
      // Prove it works straight away with a test email to itself.
      await runTest(res.sender.id, { quiet: false });
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  async function runTest(id, { quiet = false } = {}) {
    const btn = document.querySelector(`[data-sender-test="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    try {
      const res = await request({ action: "testSender", id });
      senders = res.senders || senders;
      renderSenderList();
      if (!quiet) notify(`Test email sent to ${res.sentTo} — check that inbox.`);
    } catch (ex) {
      await loadSenders(true).catch(() => {});
      renderSenderList(`Test failed: ${ex.message || ex}`);
    }
  }

  function bindSettings() {
    const panel = document.querySelector('[data-settings-panel-section="email"]');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = "1";
    $("emailAddSender").addEventListener("click", () => showSenderForm(null));
    $("emailCancelSender").addEventListener("click", hideSenderForm);
    $("emailSenderForm").addEventListener("submit", saveSenderForm);
    document.querySelectorAll("[data-email-provider]").forEach((b) => {
      b.addEventListener("click", () => setProvider(b.dataset.emailProvider));
    });
    $("emailSenderList").addEventListener("click", async (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      try {
        if (t.dataset.senderTest) await runTest(t.dataset.senderTest);
        if (t.dataset.senderEdit) showSenderForm(senders.find((s) => s.id === t.dataset.senderEdit));
        if (t.dataset.senderDefault) {
          senders = (await request({ action: "defaultSender", id: t.dataset.senderDefault })).senders || senders;
          renderSenderList();
        }
        if (t.dataset.senderRemove) {
          const s = senders.find((x) => x.id === t.dataset.senderRemove);
          if (!window.confirm(`Remove ${s?.fromEmail || "this account"}? Invoices can no longer be sent from it (you can add it again later).`)) return;
          senders = (await request({ action: "deleteSender", id: t.dataset.senderRemove })).senders || [];
          renderSenderList();
        }
      } catch (ex) {
        renderSenderList(ex.message || String(ex));
      }
    });
  }

  async function enterSettings() {
    bindSettings();
    try {
      await loadSenders(true);
      renderSenderList();
    } catch (ex) {
      renderSenderList("Couldn't load email accounts: " + (ex.message || ex));
    }
  }
  window.addEventListener("rpc-enter-email-settings", enterSettings);
  window.addEventListener("rpc-enter-email-settings", enterDesign);

  /* ---- Email design editor (Settings → Email) ------------------------- */
  const design = { saved: null, current: null, placeholders: [], previewPaid: false, previewTimer: 0, lastField: null, bound: false };
  const TEXT_FIELDS = { edSubject: "subject", edHeadingDue: "headingDue", edHeadingPaid: "headingPaid", edMessage: "message", edButton: "buttonText", edFooter: "footerText" };
  const CHECK_FIELDS = { edShowLogo: "showLogo", edShowDueLine: "showDueLine", edShowSummary: "showSummary", edShowItems: "showItems", edShowCustomer: "showCustomerInfo", edShowAddress: "showAddress" };

  function fillDesignForm(t) {
    Object.entries(TEXT_FIELDS).forEach(([id, key]) => { $(id).value = t[key] || ""; });
    Object.entries(CHECK_FIELDS).forEach(([id, key]) => { $(id).checked = !!t[key]; });
    $("edLogoUrl").value = t.logoUrl || "";
    $("edLogoWidth").value = t.logoWidth;
    $("edLogoWidthLabel").textContent = `${t.logoWidth}px`;
    setAccent(t.accentColor, false);
    setHeaderColor(t.headerColor, false);
    setSeg("[data-ed-font]", "edFont", t.font);
    setSeg("[data-ed-align]", "edAlign", t.logoAlign);
  }

  function setSeg(selector, dataKey, value) {
    document.querySelectorAll(selector).forEach((b) => {
      const on = Object.values(b.dataset)[0] === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  function setAccent(color, changed = true) {
    $("edAccent").value = color;
    $("edAccentHex").textContent = color;
    document.querySelectorAll("[data-swatch]").forEach((s) => {
      const on = s.dataset.swatch.toLowerCase() === color.toLowerCase();
      s.classList.toggle("active", on);
      s.setAttribute("aria-checked", on ? "true" : "false");
    });
    if (changed) designChanged();
  }

  function setHeaderColor(color, changed = true) {
    $("edHeaderColor").value = color;
    $("edHeaderHex").textContent = color;
    document.querySelectorAll("[data-hswatch]").forEach((s) => {
      const on = s.dataset.hswatch.toLowerCase() === color.toLowerCase();
      s.classList.toggle("active", on);
      s.setAttribute("aria-checked", on ? "true" : "false");
    });
    if (changed) designChanged();
  }

  function readDesignForm() {
    const t = {};
    Object.entries(TEXT_FIELDS).forEach(([id, key]) => { t[key] = $(id).value; });
    Object.entries(CHECK_FIELDS).forEach(([id, key]) => { t[key] = $(id).checked; });
    t.logoUrl = $("edLogoUrl").value.trim();
    t.logoWidth = Number($("edLogoWidth").value);
    t.accentColor = $("edAccent").value;
    t.headerColor = $("edHeaderColor").value;
    t.font = document.querySelector("[data-ed-font].active")?.dataset.edFont || "modern";
    t.logoAlign = document.querySelector("[data-ed-align].active")?.dataset.edAlign || "left";
    return t;
  }

  function setDesignStatus(text, tone = "") {
    const el = $("emailDesignStatus");
    el.textContent = text;
    el.dataset.tone = tone;
  }

  function designChanged() {
    design.current = readDesignForm();
    const dirty = JSON.stringify(design.current) !== JSON.stringify(design.saved);
    setDesignStatus(dirty ? "Unsaved changes" : "Saved", dirty ? "dirty" : "ok");
    clearTimeout(design.previewTimer);
    design.previewTimer = setTimeout(renderPreview, 350);
  }

  async function renderPreview() {
    try {
      const sender = senders.find((s) => s.isDefault) || senders[0];
      const res = await request({ action: "previewEmail", template: design.current || readDesignForm(), paid: design.previewPaid, senderName: sender?.fromName || "" });
      $("edPreviewSubject").textContent = res.subject;
      $("edPreviewFrame").srcdoc = res.html;
    } catch (ex) {
      $("edPreviewSubject").textContent = "Couldn't render the preview: " + (ex.message || ex);
    }
  }

  function insertPlaceholder(name) {
    const field = design.lastField || $("edMessage");
    const token = `{${name}}`;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.value = field.value.slice(0, start) + token + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + token.length, start + token.length);
    designChanged();
  }

  function bindDesign() {
    if (design.bound) return;
    design.bound = true;
    const form = $("emailDesignForm");
    form.addEventListener("input", (e) => {
      if (e.target.id === "edLogoWidth") $("edLogoWidthLabel").textContent = `${e.target.value}px`;
      if (e.target.id === "edAccent") { setAccent(e.target.value); return; }
      if (e.target.id === "edHeaderColor") { setHeaderColor(e.target.value); return; }
      designChanged();
    });
    form.addEventListener("change", designChanged);
    form.addEventListener("focusin", (e) => { if (e.target.matches(".ed-text")) design.lastField = e.target; });
    document.querySelectorAll("[data-swatch]").forEach((b) => b.addEventListener("click", () => setAccent(b.dataset.swatch)));
    document.querySelectorAll("[data-hswatch]").forEach((b) => b.addEventListener("click", () => setHeaderColor(b.dataset.hswatch)));
    document.querySelectorAll("[data-ed-font]").forEach((b) => b.addEventListener("click", () => { setSeg("[data-ed-font]", "edFont", b.dataset.edFont); designChanged(); }));
    document.querySelectorAll("[data-ed-align]").forEach((b) => b.addEventListener("click", () => { setSeg("[data-ed-align]", "edAlign", b.dataset.edAlign); designChanged(); }));
    document.querySelectorAll("[data-ed-preview]").forEach((b) => b.addEventListener("click", () => {
      design.previewPaid = b.dataset.edPreview === "paid";
      document.querySelectorAll("[data-ed-preview]").forEach((x) => x.classList.toggle("active", x === b));
      renderPreview();
    }));
    document.querySelectorAll("[data-ed-device]").forEach((b) => b.addEventListener("click", () => {
      $("edPreviewFrameWrap").classList.toggle("is-phone", b.dataset.edDevice === "phone");
      document.querySelectorAll("[data-ed-device]").forEach((x) => x.classList.toggle("active", x === b));
    }));
    $("edPlaceholders").addEventListener("mousedown", (e) => {
      const chip = e.target.closest("[data-ph]");
      if (!chip) return;
      e.preventDefault(); // keep the cursor in the field being edited
      insertPlaceholder(chip.dataset.ph);
    });
    $("edPlaceholders").addEventListener("keydown", (e) => {
      const chip = e.target.closest("[data-ph]");
      if (chip && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); insertPlaceholder(chip.dataset.ph); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("edSave");
      btn.disabled = true;
      $("emailDesignError").hidden = true;
      try {
        const res = await request({ action: "saveEmailTemplate", template: readDesignForm() });
        design.saved = res.template;
        fillDesignForm(res.template);
        design.current = readDesignForm();
        design.saved = design.current;
        setDesignStatus("Saved", "ok");
        notify("Email design saved — new invoice emails will use it.");
        renderPreview();
      } catch (ex) {
        $("emailDesignError").textContent = "Couldn't save: " + (ex.message || ex);
        $("emailDesignError").hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    $("edReset").addEventListener("click", async () => {
      if (!window.confirm("Reset the email design to the default? Your wording and style changes will be replaced.")) return;
      try {
        const res = await request({ action: "resetEmailTemplate" });
        fillDesignForm(res.template);
        design.current = readDesignForm();
        design.saved = design.current;
        setDesignStatus("Reset to default", "ok");
        renderPreview();
      } catch (ex) {
        $("emailDesignError").textContent = "Couldn't reset: " + (ex.message || ex);
        $("emailDesignError").hidden = false;
      }
    });
  }

  async function enterDesign() {
    if (!$("emailDesignForm")) return;
    bindDesign();
    try {
      const res = await request({ action: "emailTemplate" });
      design.placeholders = res.placeholders || [];
      $("edPlaceholders").innerHTML = design.placeholders.map((p) => `<button type="button" class="email-ph" data-ph="${esc(p)}">{${esc(p)}}</button>`).join("");
      fillDesignForm(res.template);
      design.current = readDesignForm();
      design.saved = design.current;
      setDesignStatus("Saved", "ok");
      renderPreview();
    } catch (ex) {
      $("emailDesignError").textContent = "Couldn't load the email design: " + (ex.message || ex);
      $("emailDesignError").hidden = false;
    }
  }

  /* ---- Send invoice dialog -------------------------------------------- */
  let composing = null; // { invoice, onSent }

  // Subject + message from the saved email design (Settings → Email →
  // Email design), with this invoice's details filled in by the server.
  async function draftFor(invoice, senderName) {
    try {
      return await request({ action: "emailDraft", id: invoice.id, senderName: senderName || "" });
    } catch (_) {
      return { subject: `Invoice ${invoice.number} from ${invoice.business?.name || "JQ Electronics Ltd."}`, message: "" };
    }
  }

  function ensureCompose() {
    let modal = $("invoiceEmailModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "invoiceEmailModal";
    modal.className = "modal-backdrop";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-panel email-compose-panel" role="dialog" aria-modal="true" aria-labelledby="emailComposeTitle">
        <div class="modal-header">
          <div><p class="modal-eyebrow">Email invoice</p><h3 id="emailComposeTitle">Send invoice</h3></div>
          <button type="button" class="modal-close" data-compose-close aria-label="Close"><svg class="icon"><use href="#i-xmark"></use></svg></button>
        </div>
        <div class="modal-body">
          <div id="emailComposeEmpty" class="email-empty" hidden>
            <svg class="icon" aria-hidden="true"><use href="#i-mail"></use></svg>
            <p><strong>Link an email account first.</strong><br>Invoices are sent from your own mailbox (e.g. the shop's Gmail) so replies come back to you.</p>
            <button type="button" class="primary-btn" data-compose-settings>Link an email account</button>
          </div>
          <form id="emailComposeForm" class="email-compose" autocomplete="off">
            <label class="email-row"><span>From</span>
              <span class="email-from-wrap">
                <select id="emailComposeFrom" class="text-input"></select>
                <button type="button" class="email-link-btn" data-compose-settings>Manage</button>
              </span>
            </label>
            <label class="email-row"><span>To</span><input id="emailComposeTo" class="text-input" type="text" inputmode="email" placeholder="customer@example.com" /></label>
            <label class="email-row" id="emailComposeCcRow" hidden><span>Cc</span><input id="emailComposeCc" class="text-input" type="text" inputmode="email" placeholder="Optional — separate with commas" /></label>
            <button type="button" class="email-link-btn email-add-cc" id="emailComposeAddCc">+ Add Cc</button>
            <label class="email-row"><span>Subject</span><input id="emailComposeSubject" class="text-input" type="text" /></label>
            <label class="email-row email-row-top"><span>Message</span><textarea id="emailComposeMessage" class="text-input" rows="9"></textarea></label>
            <div class="email-options">
              <label class="email-check"><input type="checkbox" id="emailComposeAttach" checked /><span><svg class="icon" aria-hidden="true"><use href="#i-receipt"></use></svg>Attach invoice PDF <small id="emailComposeFile"></small></span></label>
              <label class="email-check"><input type="checkbox" id="emailComposeLink" checked /><span>Include a “View invoice” button (online link)</span></label>
            </div>
            <p id="emailComposeHistory" class="email-history" hidden></p>
            <p id="emailComposeError" class="field-error" hidden></p>
          </form>
        </div>
        <div class="modal-footer"><div class="form-actions">
          <button type="button" class="ghost-btn" data-compose-close>Cancel</button>
          <button type="button" class="primary-btn" id="emailComposeSend"><svg class="icon"><use href="#i-mail"></use></svg>Send</button>
        </div></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-compose-close]").forEach((b) => b.addEventListener("click", closeCompose));
    modal.querySelectorAll("[data-compose-settings]").forEach((b) => b.addEventListener("click", () => {
      closeCompose();
      window.RPC_INVOICE_CLOSE_EDITOR?.();
      window.RPC_OPEN_SETTINGS_PANEL?.("email");
    }));
    $("emailComposeAddCc").addEventListener("click", () => {
      $("emailComposeCcRow").hidden = false;
      $("emailComposeAddCc").hidden = true;
      $("emailComposeCc").focus();
    });
    $("emailComposeFrom").addEventListener("change", async () => {
      // Keep the sign-off in step with the chosen sender if it's untouched.
      const msg = $("emailComposeMessage");
      if (composing && msg.value === composing.lastDefault) {
        const draft = await draftFor(composing.invoice, senderById($("emailComposeFrom").value)?.fromName);
        if (composing && msg.value === composing.lastDefault) {
          composing.lastDefault = draft.message;
          msg.value = draft.message;
        }
      }
    });
    $("emailComposeSend").addEventListener("click", sendCompose);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) { e.stopPropagation(); closeCompose(); }
    }, true);
    return modal;
  }

  const senderById = (id) => senders.find((s) => s.id === id);

  async function openCompose(invoice, { onSent } = {}) {
    const modal = ensureCompose();
    document.body.appendChild(modal); // on top of whatever opened it
    composing = { invoice, onSent, lastDefault: "" };
    $("emailComposeTitle").textContent = `Send invoice ${invoice.number}`;
    $("emailComposeError").hidden = true;
    modal.hidden = false;
    try {
      await loadSenders(true);
    } catch (ex) {
      $("emailComposeError").textContent = "Couldn't load email accounts: " + (ex.message || ex);
      $("emailComposeError").hidden = false;
    }
    const none = !senders.length;
    $("emailComposeEmpty").hidden = !none;
    $("emailComposeForm").hidden = none;
    $("emailComposeSend").hidden = none;
    if (none) return;
    let last = "";
    try { last = localStorage.getItem(LAST_SENDER_KEY) || ""; } catch (_) {}
    const chosen = senderById(last) || senders.find((s) => s.isDefault) || senders[0];
    $("emailComposeFrom").innerHTML = senders.map((s) => `<option value="${esc(s.id)}"${s.id === chosen.id ? " selected" : ""}>${esc(s.fromName ? `${s.fromName} <${s.fromEmail}>` : s.fromEmail)}${s.isDefault ? " (default)" : ""}</option>`).join("");
    $("emailComposeTo").value = invoice.billTo?.email || "";
    $("emailComposeCc").value = "";
    $("emailComposeCcRow").hidden = true;
    $("emailComposeAddCc").hidden = false;
    const draft = await draftFor(invoice, chosen.fromName);
    $("emailComposeSubject").value = draft.subject;
    composing.lastDefault = draft.message;
    $("emailComposeMessage").value = draft.message;
    $("emailComposeAttach").checked = true;
    $("emailComposeLink").checked = true;
    $("emailComposeFile").textContent = `(${String(invoice.number || "invoice").replace(/[^\w.-]+/g, "_")}.pdf)`;
    const history = invoice.emails || [];
    const lastSent = history[history.length - 1];
    $("emailComposeHistory").hidden = !lastSent;
    if (lastSent) {
      const when = new Date(lastSent.sentAt).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
      $("emailComposeHistory").textContent = `Already emailed ${history.length === 1 ? "once" : history.length + " times"} — last sent ${when} to ${(lastSent.to || []).join(", ")}.`;
    }
    (invoice.billTo?.email ? $("emailComposeSubject") : $("emailComposeTo")).focus();
  }

  function closeCompose() {
    const modal = $("invoiceEmailModal");
    if (modal) modal.hidden = true;
    composing = null;
  }

  async function pdfBase64For(invoice) {
    const doc = await window.RPC_INVOICE.buildPdf(invoice);
    return doc.output("datauristring").split(",")[1];
  }

  async function sendCompose() {
    if (!composing) return;
    const err = $("emailComposeError");
    err.hidden = true;
    const to = $("emailComposeTo").value.trim();
    if (!to) {
      err.textContent = "Enter the customer's email address.";
      err.hidden = false;
      $("emailComposeTo").focus();
      return;
    }
    const btn = $("emailComposeSend");
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "Sending…";
    const { invoice, onSent } = composing;
    const senderId = $("emailComposeFrom").value;
    try {
      const res = await request({
        action: "email",
        id: invoice.id,
        senderId,
        to,
        cc: $("emailComposeCc").value,
        subject: $("emailComposeSubject").value,
        message: $("emailComposeMessage").value,
        includeLink: $("emailComposeLink").checked,
        pdfBase64: $("emailComposeAttach").checked ? await pdfBase64For(invoice) : "",
      });
      try { localStorage.setItem(LAST_SENDER_KEY, senderId); } catch (_) {}
      closeCompose();
      notify(`Invoice ${invoice.number} emailed to ${res.sent.to.join(", ")}.`);
      if (onSent) onSent(res.invoice, res.invoiceUrl);
    } catch (ex) {
      err.textContent = "Couldn't send: " + (ex.message || ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  // Check-in "Send invoice to client → Email": sends straight away from the
  // default account with the standard message and the PDF attached.
  async function sendDefault(invoice) {
    await loadSenders(true);
    const sender = senders.find((s) => s.isDefault) || senders[0];
    if (!sender) throw new Error("No email account linked — add one in Settings → Email");
    if (!invoice.billTo?.email) throw new Error("the client has no email address");
    const draft = await draftFor(invoice, sender.fromName);
    const res = await request({
      action: "email",
      id: invoice.id,
      senderId: sender.id,
      to: invoice.billTo.email,
      subject: draft.subject,
      message: draft.message,
      includeLink: true,
      pdfBase64: await pdfBase64For(invoice),
    });
    return res;
  }

  window.RPC_EMAIL = { openCompose, sendDefault, loadSenders };
})();
