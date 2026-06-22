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
      TICKETS = res.tickets || [];
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
      TICKETS = res.tickets || [];
      loadedOnce = true;
      renderStatusChips();
      render();
    } catch (e) {
      $("intakeList").innerHTML = "";
      $("intakeEmpty").hidden = true;
      $("intakeError").hidden = false;
      $("intakeErrorSub").textContent =
        "Couldn't load devices (" + e.message + "). Tap ↻ to retry.";
    } finally {
      $("intakeLoading").style.display = "none";
    }
  }

  $("reloadIntake").addEventListener("click", loadTickets);
  $("intakeSettings").addEventListener("click", () => showSetup(true));

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
    $("intakeForm").hidden = false;
    $("fName").value = ticket ? ticket.customerName || "" : "";
    $("fPhone").value = ticket ? ticket.phone || "" : "";
    $("fDevice").value = ticket ? ticket.device || "" : "";
    $("fStatus").value = ticket ? ticket.status || "Received" : "Received";
    $("fNotes").value = ticket ? ticket.notes || "" : "";
    setIssueTags(ticket ? ticket.issues || "" : "");

    $("saveForm").textContent = ticket ? "Update device" : "Save device";
    $("formError").hidden = true;
    $("intakeForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("fName").focus();
  }
  function closeForm() {
    $("intakeForm").hidden = true;
    editingId = null;
  }

  $("newIntakeBtn").addEventListener("click", () => openForm(null));
  $("cancelForm").addEventListener("click", closeForm);

  $("intakeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("formError");
    err.hidden = true;
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
      phone: $("fPhone").value.trim(),
      device: $("fDevice").value.trim(),
      issues: issuesStr,
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
        device: ticket.device,
        issues: ticket.issues,
        notes: ticket.notes,
      });
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      renderStatusChips();
      render();
    } catch (e) {
      alert("Couldn't update status: " + e.message);
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
    const hasPhone = !!t.phone;
    head.innerHTML = `
      <span class="ticket-accent ${STATUS_CLASS[t.status] || "st-received"}"></span>
      <div class="ticket-main">
        <div class="ticket-toprow">
          <span class="ticket-num mono">#${esc(t.id || "")}</span>
          <span class="status-badge ${STATUS_CLASS[t.status] || "st-received"}">${esc(t.status || "—")}</span>
        </div>
        <div class="ticket-customer">${esc(t.customerName || "Unknown customer")}</div>
        <div class="ticket-sub">${esc(t.device || "—")}</div>
        <div class="issue-tags issue-tags-readonly">${issueTagsHtml(t.issues)}</div>
      </div>
      <a class="ticket-call${hasPhone ? "" : " disabled"}" href="${hasPhone ? `tel:${esc(t.phone)}` : "#"}" title="${hasPhone ? "Call " + esc(t.customerName || "customer") : "No phone on file"}" aria-label="Call customer">📞</a>`;
    head.querySelector(".ticket-call").onclick = (e) => e.stopPropagation();

    const body = document.createElement("div");
    body.className = "ticket-body";
    body.innerHTML = `
      <div class="ticket-row"><span class="k">Customer</span><span class="v">${esc(t.customerName || "—")}</span></div>
      <div class="ticket-row"><span class="k">Phone</span><span class="v">${t.phone ? `<a class="ticket-tel" href="tel:${esc(t.phone)}">${esc(t.phone)}</a>` : "—"}</span></div>
      <div class="ticket-row"><span class="k">Device</span><span class="v">${esc(t.device || "—")}</span></div>
      <div class="ticket-row"><span class="k">Logged</span><span class="v mono">${esc(fmtDate(t.created))}</span></div>
      <div class="ticket-row"><span class="k">Updated</span><span class="v mono">${esc(fmtDate(t.updated))}</span></div>
      ${t.notes ? `<div class="ticket-row"><span class="k">Notes</span><span class="v">${esc(t.notes)}</span></div>` : ""}
      <div class="ticket-actions">
        <div class="field-label">Set status</div>
        <div class="status-buttons"></div>
        <button class="ghost-btn ticket-edit-btn">✎ Edit details</button>
      </div>
      <div class="ticket-actions">
        <div class="field-label">Activity log</div>
        ${historyHtml(t.history)}
      </div>`;

    const sb = body.querySelector(".status-buttons");
    STATUSES.forEach((s) => {
      const b = document.createElement("button");
      b.className = "status-set" + (s === t.status ? " current" : "");
      b.textContent = s;
      b.onclick = (e) => {
        e.stopPropagation();
        if (s !== t.status) setStatus(t, s);
      };
      sb.appendChild(b);
    });
    body.querySelector(".ticket-edit-btn").onclick = (e) => {
      e.stopPropagation();
      openForm(t);
    };

    head.onclick = () => el.classList.toggle("open");
    el.appendChild(head);
    el.appendChild(body);
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
