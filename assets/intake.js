/* ============================================================
   Device intake — log devices, select one or more issues, track
   status, and keep a timestamped activity log of every change.
   Talks to a Google Apps Script web app that reads/writes a
   dedicated "JQ Reapirs" spreadsheet.

   The Apps Script URL is fixed below (it's not secret on its own —
   every request still requires the team PIN, checked server-side in
   apps-script/Code.gs). Only the PIN is entered once per device and
   stored in localStorage.
   ============================================================ */

(function () {
  // Fixed Apps Script web app URL — update if you ever redeploy to a
  // new URL. The PIN (set server-side in Code.gs) is the real gate.
  const SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbyNDPA3RSYJfpoQ0sWqPZ1Ebyui9xyeVXzC00RDTZ3F0ilOg8nPnNGn9dYqlId2YiBaUw/exec";

  // Status pipeline — keep in sync with apps-script/Code.gs STATUSES.
  const STATUSES = [
    "Received",
    "Diagnosing",
    "Waiting for Parts",
    "In Progress",
    "Repaired",
    "Picked Up",
    "Cancelled",
  ];
  const STATUS_CLASS = {
    "Received": "st-received",
    "Diagnosing": "st-diagnosing",
    "Waiting for Parts": "st-parts",
    "In Progress": "st-progress",
    "Repaired": "st-repaired",
    "Picked Up": "st-pickedup",
    "Cancelled": "st-cancelled",
  };

  // Common issue presets — "Other" reveals a free-text field.
  const ISSUES = [
    "Screen Cracked / Broken",
    "Battery Issue",
    "Charging Port",
    "Won't Power On",
    "Water Damage",
    "Camera Issue",
    "Speaker / Mic Issue",
    "Back Glass Cracked",
    "Software Issue",
    "Diagnostic Needed",
    "Other",
  ];

  const LS_PIN = "rpc_intake_pin";

  const $ = (id) => document.getElementById(id);

  // State
  let TICKETS = [];
  let statusFilter = "all";
  let editingId = null;
  let loadedOnce = false;

  // ---- View navigation -----------------------------------------------------
  const navBtns = document.querySelectorAll(".nav-btn");
  const views = { prices: $("view-prices"), intake: $("view-intake") };
  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      navBtns.forEach((b) => b.classList.toggle("active", b === btn));
      Object.entries(views).forEach(([k, v]) => (v.hidden = k !== target));
      // Refresh button only makes sense on the prices view.
      const rb = $("refreshBtn");
      if (rb) rb.hidden = target !== "prices";
      if (target === "intake") enterIntake();
    });
  });

  // ---- Config --------------------------------------------------------------
  const getCfg = () => ({
    url: SCRIPT_URL,
    pin: localStorage.getItem(LS_PIN) || "",
  });
  const isConfigured = () => !!getCfg().pin;

  function showSetup(prefill) {
    $("intakeSetup").hidden = false;
    $("intakeMain").hidden = true;
    if (prefill) $("cfgPin").value = getCfg().pin;
  }
  function showMain() {
    $("intakeSetup").hidden = true;
    $("intakeMain").hidden = false;
  }

  $("cfgSave").addEventListener("click", async () => {
    const pin = $("cfgPin").value.trim();
    const err = $("cfgError");
    err.hidden = true;
    if (!pin) {
      err.textContent = "Enter the team PIN.";
      err.hidden = false;
      return;
    }
    // Validate against the live script before saving.
    $("cfgSave").disabled = true;
    $("cfgSave").textContent = "Connecting…";
    try {
      const res = await api({ action: "list" }, { url: SCRIPT_URL, pin });
      if (!res.ok) throw new Error(res.error || "Rejected");
      localStorage.setItem(LS_PIN, pin);
      TICKETS = (res.tickets || []).map(normalizeTicket);
      loadedOnce = true;
      showMain();
      renderStatusChips();
      render();
    } catch (e) {
      err.textContent = "Couldn't connect: " + e.message + ". Check the PIN.";
      err.hidden = false;
    } finally {
      $("cfgSave").disabled = false;
      $("cfgSave").textContent = "Save & connect";
    }
  });

  // ---- API -----------------------------------------------------------------
  // GET for reads, POST (text/plain to avoid CORS preflight) for writes.
  async function api(payload, override) {
    const cfg = override || getCfg();
    const body = Object.assign({ pin: cfg.pin }, payload);
    let res;
    if (payload.action === "list") {
      const q = new URLSearchParams({ action: "list", pin: cfg.pin, _: Date.now() });
      res = await fetch(cfg.url + "?" + q.toString(), { method: "GET" });
    } else {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // ---- Enter intake view ---------------------------------------------------
  function enterIntake() {
    if (!isConfigured()) {
      showSetup(false);
      return;
    }
    showMain();
    if (!loadedOnce) loadTickets();
  }

  async function loadTickets() {
    $("intakeLoading").style.display = "block";
    $("intakeError").hidden = true;
    try {
      const res = await api({ action: "list" });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TICKETS = (res.tickets || []).map(normalizeTicket);
      loadedOnce = true;
      renderStatusChips();
      render();
    } catch (e) {
      $("intakeList").innerHTML = "";
      $("intakeEmpty").hidden = true;
      $("intakeError").hidden = false;
      $("intakeErrorSub").textContent =
        "Couldn't load devices (" + e.message + "). Tap Reload to retry.";
    } finally {
      $("intakeLoading").style.display = "none";
    }
  }

  $("reloadIntake").addEventListener("click", loadTickets);
  $("intakeSettings").addEventListener("click", () => showSetup(true));

  // ---- Clear all -------------------------------------------------------------
  function openClearAllModal() {
    if (!TICKETS.length) return;
    $("clearAllPin").value = "";
    $("clearAllError").hidden = true;
    $("clearAllModal").hidden = false;
    $("clearAllPin").focus();
  }
  function closeClearAllModal() {
    $("clearAllModal").hidden = true;
  }
  $("clearAllIntake").addEventListener("click", openClearAllModal);
  $("closeClearAllModal").addEventListener("click", closeClearAllModal);
  $("clearAllModal").addEventListener("click", (e) => {
    if (e.target.id === "clearAllModal") closeClearAllModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("clearAllModal").hidden) closeClearAllModal();
  });

  $("confirmClearAll").addEventListener("click", async () => {
    const err = $("clearAllError");
    err.hidden = true;
    const pin = $("clearAllPin").value.trim();
    if (!pin || pin !== getCfg().pin) {
      err.textContent = "PIN doesn't match — clear all canceled.";
      err.hidden = false;
      return;
    }
    const btn = $("confirmClearAll");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Deleting…";
    try {
      const res = await api({ action: "clear" });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TICKETS = [];
      statusFilter = "all";
      closeForm();
      closeClearAllModal();
      renderStatusChips();
      render();
    } catch (e) {
      err.textContent = "Couldn't clear devices: " + e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // ---- Form ------------------------------------------------------------------
  populateStatusSelect();
  populateIssueTags();

  let selectedIssues = new Set();

  function populateStatusSelect() {
    $("fStatus").innerHTML = STATUSES.map(
      (s) => `<option value="${s}">${s}</option>`
    ).join("");
  }

  function populateIssueTags() {
    const box = $("issueTags");
    box.innerHTML = ISSUES.map(
      (s) => `<button type="button" class="issue-toggle" data-issue="${esc(s)}">${esc(s)}</button>`
    ).join("");
    box.querySelectorAll(".issue-toggle").forEach((btn) => {
      btn.addEventListener("click", () => toggleIssue(btn.dataset.issue, btn));
    });
  }

  function toggleIssue(issue, btn) {
    if (selectedIssues.has(issue)) {
      selectedIssues.delete(issue);
      btn.classList.remove("active");
    } else {
      selectedIssues.add(issue);
      btn.classList.add("active");
    }
    const otherOn = selectedIssues.has("Other");
    $("fIssueOther").hidden = !otherOn;
    if (otherOn) $("fIssueOther").focus();
    updateIssueSummary();
  }

  function updateIssueSummary() {
    const str = buildIssuesString();
    const btn = $("openIssueModal");
    const count = selectedIssues.size;
    $("issueSelectLabel").textContent = count
      ? `${count} issue${count === 1 ? "" : "s"} selected`
      : "Select issues…";
    btn.classList.toggle("has-selection", count > 0);
    $("issueSummary").innerHTML = count ? issueTagsHtml(str) : "";
  }

  // ---- Issue picker modal ---------------------------------------------------
  function openIssueModal() {
    $("issueModal").hidden = false;
  }
  function closeIssueModal() {
    $("issueModal").hidden = true;
    updateIssueSummary();
  }
  $("openIssueModal").addEventListener("click", openIssueModal);
  $("closeIssueModal").addEventListener("click", closeIssueModal);
  $("issueModalDone").addEventListener("click", closeIssueModal);
  $("issueModal").addEventListener("click", (e) => {
    if (e.target.id === "issueModal") closeIssueModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("issueModal").hidden) closeIssueModal();
  });

  // ---- Ticket detail modal -------------------------------------------------
  function openTicketModal(ticket) {
    const hasPhone = !!ticket.phone;
    $("ticketModalBody").innerHTML = `
      <div class="ticket-detail-hero">
        <span class="ticket-device-icon"><svg class="icon"><use href="#i-device"></use></svg></span>
        <div><h4 class="ticket-detail-title">${esc(ticket.device || "Device")}</h4><p class="ticket-detail-id mono">#${esc(ticket.id || "")}</p></div>
        <span class="status-badge ${STATUS_CLASS[ticket.status] || "st-received"}">${esc(ticket.status || "—")}</span>
      </div>
      <section class="ticket-detail-section"><p class="field-label">Customer & device</p><div class="ticket-detail-grid">
        ${detailRow("i-user", "Customer", ticket.customerName || "Unknown customer")}
        ${detailRow("i-phone", "Phone", ticket.phone ? `<a class="ticket-tel" href="tel:${esc(ticket.phone)}">${esc(ticket.phone)}</a>` : "—")}
        ${detailRow("i-device", "Device", ticket.device || "—")}
        ${detailRow("i-clock", "Logged", fmtDate(ticket.created))}
        ${detailRow("i-clock", "Updated", fmtDate(ticket.updated))}
      </div></section>
      <section class="ticket-detail-section"><p class="field-label">Issues</p><div class="issue-tags issue-tags-readonly">${issueTagsHtml(ticket.issues)}</div></section>
      ${ticket.notes ? `<section class="ticket-detail-section"><p class="field-label">Notes</p><p class="ticket-detail-notes">${esc(ticket.notes)}</p></section>` : ""}
      <section class="ticket-detail-section"><p class="field-label">Set status</p><div class="status-buttons" id="ticketModalStatuses"></div></section>
      <section class="ticket-detail-section"><p class="field-label">Activity log</p>${historyHtml(ticket.history)}</section>`;

    const statusBox = $("ticketModalStatuses");
    STATUSES.forEach((status) => {
      const button = document.createElement("button");
      button.className = "status-set" + (status === ticket.status ? " current" : "");
      button.textContent = status;
      button.onclick = async () => {
        if (status === ticket.status) return;
        const updated = await setStatus(ticket, status);
        if (updated) openTicketModal(updated);
      };
      statusBox.appendChild(button);
    });

    $("ticketModalFooter").innerHTML = `
      ${hasPhone ? `<a class="primary-btn" href="tel:${esc(ticket.phone)}"><svg class="icon"><use href="#i-phone"></use></svg>Call client</a>` : ""}
      <button type="button" class="ghost-btn" id="ticketModalEdit"><svg class="icon"><use href="#i-pencil"></use></svg>Edit</button>
      <button type="button" class="ghost-btn danger-btn" id="ticketModalDelete"><svg class="icon"><use href="#i-trash"></use></svg><span class="visually-hidden">Delete</span></button>`;
    $("ticketModalEdit").onclick = () => { closeTicketModal(); openForm(ticket); };
    $("ticketModalDelete").onclick = async () => { if (await deleteTicket(ticket)) closeTicketModal(); };
    $("ticketModal").hidden = false;
    $("closeTicketModal").focus();
  }

  function closeTicketModal() { $("ticketModal").hidden = true; }
  $("closeTicketModal").addEventListener("click", closeTicketModal);
  $("ticketModal").addEventListener("click", (e) => { if (e.target.id === "ticketModal") closeTicketModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("ticketModal").hidden) closeTicketModal(); });

  function detailRow(iconName, label, value) {
    return `<div class="ticket-detail-row"><svg class="icon"><use href="#${iconName}"></use></svg><span class="ticket-detail-label">${esc(label)}</span><span class="ticket-detail-value">${value}</span></div>`;
  }

  function setIssueTags(issuesStr) {
    selectedIssues = new Set();
    $("issueTags").querySelectorAll(".issue-toggle").forEach((b) => b.classList.remove("active"));
    $("fIssueOther").hidden = true;
    $("fIssueOther").value = "";
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    let otherText = "";
    parts.forEach((part) => {
      const match = ISSUES.find((preset) => preset !== "Other" && preset === part);
      if (match) {
        selectedIssues.add(match);
        const btn = $("issueTags").querySelector(`[data-issue="${CSS.escape(match)}"]`);
        if (btn) btn.classList.add("active");
      } else if (part.startsWith("Other:")) {
        otherText = part.slice(6).trim();
      } else {
        otherText = otherText ? otherText + "; " + part : part;
      }
    });
    if (otherText) {
      selectedIssues.add("Other");
      const otherBtn = $("issueTags").querySelector('[data-issue="Other"]');
      if (otherBtn) otherBtn.classList.add("active");
      $("fIssueOther").hidden = false;
      $("fIssueOther").value = otherText;
    }
    updateIssueSummary();
  }

  function buildIssuesString() {
    const parts = [];
    selectedIssues.forEach((s) => {
      if (s !== "Other") parts.push(s);
    });
    if (selectedIssues.has("Other")) {
      const text = $("fIssueOther").value.trim();
      if (text) parts.push("Other: " + text);
    }
    return parts.join(", ");
  }

  function openForm(ticket) {
    editingId = ticket ? ticket.id : null;
    $("intakeFormTitle").textContent = ticket ? "Edit device" : "Log device";
    $("fName").value = ticket ? ticket.customerName || "" : "";
    $("fPhone").value = ticket ? ticket.phone || "" : "";
    $("fDevice").value = ticket ? ticket.device || "" : "";
    $("fStatus").value = ticket ? ticket.status || "Received" : "Received";
    $("fNotes").value = ticket ? ticket.notes || "" : "";
    setIssueTags(ticket ? ticket.issues || "" : "");

    $("saveForm").textContent = ticket ? "Update device" : "Save device";
    $("formError").hidden = true;
    $("intakeFormModal").hidden = false;
    $("fName").focus();
  }
  function closeForm() {
    $("intakeFormModal").hidden = true;
    editingId = null;
  }

  $("newIntakeBtn").addEventListener("click", () => openForm(null));
  $("cancelForm").addEventListener("click", closeForm);
  $("closeIntakeFormModal").addEventListener("click", closeForm);
  $("intakeFormModal").addEventListener("click", (e) => {
    if (e.target.id === "intakeFormModal") closeForm();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("intakeFormModal").hidden) closeForm();
  });

  // ---- Customer info modal --------------------------------------------------
  // Quick-edits a ticket's customer details straight from its card.
  let clientModalTicket = null;

  function openClientModalForTicket(ticket) {
    clientModalTicket = ticket;
    $("clientModalTitle").textContent = "Update customer";
    $("cName").value = ticket.customerName || "";
    $("cPhone").value = ticket.phone || "";
    $("cNotes").value = ticket.notes || "";
    $("saveClientModal").textContent = "Save";
    $("clientModalError").hidden = true;
    $("clientModal").hidden = false;
    $("cName").focus();
  }

  function closeClientModal() {
    $("clientModal").hidden = true;
    clientModalTicket = null;
  }

  $("closeClientModal").addEventListener("click", closeClientModal);
  $("clientModal").addEventListener("click", (e) => {
    if (e.target.id === "clientModal") closeClientModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("clientModal").hidden) closeClientModal();
  });

  $("saveClientModal").addEventListener("click", async () => {
    const err = $("clientModalError");
    err.hidden = true;
    const name = $("cName").value.trim();
    const phone = $("cPhone").value.trim();
    if (!name || !phone) {
      err.textContent = "Enter the customer's name and phone.";
      err.hidden = false;
      return;
    }

    const ticket = clientModalTicket;
    const notes = $("cNotes").value.trim();
    const btn = $("saveClientModal");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Saving…";
    try {
      const res = await api({
        action: "update",
        id: ticket.id,
        customerName: name,
        client: name,
        phone,
        notes,
        device: ticket.device,
        issues: ticket.issues,
        issue: ticket.issues,
        status: ticket.status,
      });
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      renderStatusChips();
      render();
      closeClientModal();
    } catch (e) {
      err.textContent = "Couldn't save: " + e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $("intakeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("formError");
    err.hidden = true;
    if (!$("fName").value.trim() || !$("fPhone").value.trim()) {
      err.textContent = "Enter the customer's name and phone.";
      err.hidden = false;
      return;
    }
    const issuesStr = buildIssuesString();
    if (!issuesStr) {
      err.textContent = "Select at least one issue.";
      err.hidden = false;
      return;
    }
    const payload = {
      action: editingId ? "update" : "add",
      id: editingId || undefined,
      customerName: $("fName").value.trim(),
      // Older deployed backends used `client`; send both names so a
      // frontend update never silently drops customer details.
      client: $("fName").value.trim(),
      phone: $("fPhone").value.trim(),
      device: $("fDevice").value.trim(),
      issues: issuesStr,
      issue: issuesStr,
      status: $("fStatus").value,
      notes: $("fNotes").value.trim(),
    };
    $("saveForm").disabled = true;
    const original = $("saveForm").textContent;
    $("saveForm").textContent = "Saving…";
    try {
      const res = await api(payload);
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      closeForm();
      renderStatusChips();
      render();
    } catch (ex) {
      err.textContent = "Couldn't save: " + ex.message;
      err.hidden = false;
    } finally {
      $("saveForm").disabled = false;
      $("saveForm").textContent = original;
    }
  });

  function mergeTicket(t) {
    if (!t) return;
    t = normalizeTicket(t);
    const i = TICKETS.findIndex((x) => x.id === t.id);
    if (i >= 0) TICKETS[i] = t;
    else TICKETS.unshift(t);
  }

  // ---- Quick status change -------------------------------------------------
  async function setStatus(ticket, status) {
    try {
      const res = await api({
        action: "update",
        id: ticket.id,
        status,
        customerName: ticket.customerName,
        client: ticket.customerName,
        phone: ticket.phone,
        device: ticket.device,
        issues: ticket.issues,
        issue: ticket.issues,
        notes: ticket.notes,
      });
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      renderStatusChips();
      render();
      return normalizeTicket(res.ticket);
    } catch (e) {
      alert("Couldn't update status: " + e.message);
      return null;
    }
  }

  async function deleteTicket(ticket) {
    const label = ticket.customerName || ticket.device || "this record";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      const res = await api({ action: "delete", id: ticket.id });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TICKETS = TICKETS.filter((t) => t.id !== ticket.id);
      renderStatusChips();
      render();
      return true;
    } catch (e) {
      alert("Couldn't delete record: " + e.message);
      return false;
    }
  }

  // ---- Filtering / search --------------------------------------------------
  $("intakeSearch").addEventListener("input", render);

  function renderStatusChips() {
    const counts = { all: TICKETS.length };
    STATUSES.forEach((s) => (counts[s] = TICKETS.filter((t) => t.status === s).length));
    const box = $("statusChips");
    box.innerHTML = "";
    const make = (key, label) => {
      const b = document.createElement("button");
      b.className = "chip" + (key === statusFilter ? " active" : "");
      b.textContent = label;
      b.onclick = () => {
        statusFilter = key;
        [...box.children].forEach((c) => c.classList.remove("active"));
        b.classList.add("active");
        render();
      };
      box.appendChild(b);
    };
    make("all", `All (${counts.all})`);
    STATUSES.forEach((s) => {
      if (counts[s]) make(s, `${s} (${counts[s]})`);
    });
  }

  function currentList() {
    const q = $("intakeSearch").value.trim().toLowerCase();
    return TICKETS.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return [t.device, t.issues, t.id, t.customerName, t.phone]
        .map((x) => (x || "").toLowerCase())
        .some((x) => x.includes(q));
    });
  }

  function render() {
    const list = currentList();
    $("intakeList").innerHTML = "";
    $("intakeEmpty").hidden = list.length > 0;
    $("intakeError").hidden = true;
    $("intakeCount").textContent = list.length
      ? `${list.length} device${list.length === 1 ? "" : "s"}`
      : "";
    const frag = document.createDocumentFragment();
    for (const t of list) frag.appendChild(ticketCard(t));
    $("intakeList").appendChild(frag);
  }

  function issueTagsHtml(issuesStr) {
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return `<span class="issue-chip muted">No issues recorded</span>`;
    return parts.map((p) => `<span class="issue-chip">${esc(p)}</span>`).join("");
  }

  function historyHtml(historyStr) {
    if (!historyStr) return `<p class="empty-sub">No activity recorded yet.</p>`;
    const entries = historyStr.split("\n").filter(Boolean).reverse();
    return `<div class="history-list">${entries
      .map((line) => {
        const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
        const when = m ? fmtDate(m[1]) : "";
        const msg = m ? m[2] : line;
        return `<div class="history-item"><span class="history-dot"></span><div><div class="history-msg">${esc(msg)}</div><div class="history-when mono">${esc(when)}</div></div></div>`;
      })
      .join("")}</div>`;
  }

  function ticketCard(t) {
    const el = document.createElement("div");
    el.className = "ticket";

    const head = document.createElement("div");
    head.className = "ticket-head";
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    head.setAttribute("aria-label", `View details for ${t.device || "device"}`);
    const hasPhone = !!t.phone;
    const phoneLine = hasPhone
      ? `<a class="ticket-phone" href="tel:${esc(t.phone)}" aria-label="Call ${esc(t.customerName || "customer")}"><svg class="icon ticket-phone-icon"><use href="#i-phone"></use></svg>${esc(t.phone)}</a>`
      : `<span class="ticket-phone no-phone">No number on file</span>`;
    head.innerHTML = `
      <span class="ticket-accent ${STATUS_CLASS[t.status] || "st-received"}"></span>
      <div class="ticket-main">
        <div class="ticket-toprow">
          <span class="ticket-num mono">#${esc(t.id || "")}</span>
          <span class="status-badge ${STATUS_CLASS[t.status] || "st-received"}">${esc(t.status || "—")}</span>
        </div>
        <div class="ticket-customer">${esc(t.customerName || "Unknown customer")}</div>
        <div class="ticket-sub">${esc(t.device || "—")}</div>
        ${phoneLine}
        <div class="issue-tags issue-tags-readonly">${issueTagsHtml(t.issues)}</div>
      </div>`;
    const phoneEl = head.querySelector("a.ticket-phone");
    if (phoneEl) phoneEl.onclick = (e) => e.stopPropagation();
    if (phoneEl) phoneEl.onkeydown = (e) => e.stopPropagation();
    head.onclick = () => openTicketModal(t);
    head.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openTicketModal(t);
      }
    };
    el.appendChild(head);
    return el;
  }

  // ---- Device autosuggest (from price list) --------------------------------
  function fillModelList() {
    const names = window.RPC_MODEL_NAMES || [];
    $("modelList").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
  }
  window.addEventListener("rpc-models", fillModelList);
  fillModelList();

  // ---- Helpers -------------------------------------------------------------
  // The original Apps Script API returned `client` and `issue`. The current
  // API returns `customerName` and `issues`. Normalize both versions at the
  // boundary so existing tickets keep their caller details on the dashboard.
  function normalizeTicket(ticket) {
    return Object.assign({}, ticket, {
      customerName: ticket.customerName || ticket.client || "",
      issues: ticket.issues || ticket.issue || "",
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
})();
