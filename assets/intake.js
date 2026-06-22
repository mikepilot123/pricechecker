/* ============================================================
   Device intake — log devices, track issue + repair status.
   Talks to a Google Apps Script web app that reads/writes a
   dedicated "JQ Reapirs" spreadsheet.

   That sheet is published/public, so by design this stores only
   device + issue + status + notes — no customer name, phone, or
   other personal info. Keep it that way when filling in Notes.

   The script URL + team PIN are stored only in this browser
   (localStorage) — never committed to the repo. See
   apps-script/Code.gs + README for setup.
   ============================================================ */

(function () {
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

  const LS_URL = "rpc_intake_url";
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
    url: localStorage.getItem(LS_URL) || "",
    pin: localStorage.getItem(LS_PIN) || "",
  });
  const isConfigured = () => {
    const c = getCfg();
    return !!c.url && !!c.pin;
  };

  function showSetup(prefill) {
    $("intakeSetup").hidden = false;
    $("intakeMain").hidden = true;
    if (prefill) {
      const c = getCfg();
      $("cfgUrl").value = c.url;
      $("cfgPin").value = c.pin;
    }
  }
  function showMain() {
    $("intakeSetup").hidden = true;
    $("intakeMain").hidden = false;
  }

  $("cfgSave").addEventListener("click", async () => {
    const url = $("cfgUrl").value.trim();
    const pin = $("cfgPin").value.trim();
    const err = $("cfgError");
    err.hidden = true;
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
      err.textContent = "That doesn't look like an Apps Script /exec URL.";
      err.hidden = false;
      return;
    }
    if (!pin) {
      err.textContent = "Enter the team PIN.";
      err.hidden = false;
      return;
    }
    // Validate against the live script before saving.
    $("cfgSave").disabled = true;
    $("cfgSave").textContent = "Connecting…";
    try {
      const res = await api({ action: "list" }, { url, pin });
      if (!res.ok) throw new Error(res.error || "Rejected");
      localStorage.setItem(LS_URL, url);
      localStorage.setItem(LS_PIN, pin);
      TICKETS = res.tickets || [];
      loadedOnce = true;
      showMain();
      renderStatusChips();
      render();
    } catch (e) {
      err.textContent = "Couldn't connect: " + e.message + ". Check the URL and PIN.";
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

  function populateStatusSelect() {
    $("fStatus").innerHTML = STATUSES.map(
      (s) => `<option value="${s}">${s}</option>`
    ).join("");
  }

  function openForm(ticket) {
    editingId = ticket ? ticket.id : null;
    $("intakeForm").hidden = false;
    $("fDevice").value = ticket ? ticket.device || "" : "";
    $("fIssue").value = ticket ? ticket.issue || "" : "";
    $("fStatus").value = ticket ? ticket.status || "Received" : "Received";
    $("fNotes").value = ticket ? ticket.notes || "" : "";
    $("saveForm").textContent = ticket ? "Update device" : "Save device";
    $("formError").hidden = true;
    $("intakeForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("fDevice").focus();
  }
  function closeForm() {
    $("intakeForm").hidden = true;
    editingId = null;
  }

  $("newIntakeBtn").addEventListener("click", () => openForm(null));
  $("cancelForm").addEventListener("click", closeForm);

  $("intakeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      action: editingId ? "update" : "add",
      id: editingId || undefined,
      device: $("fDevice").value.trim(),
      issue: $("fIssue").value.trim(),
      status: $("fStatus").value,
      notes: $("fNotes").value.trim(),
    };
    const err = $("formError");
    err.hidden = true;
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
        issue: ticket.issue,
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
      return [t.device, t.issue, t.id]
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

  function ticketCard(t) {
    const el = document.createElement("div");
    el.className = "ticket";

    const head = document.createElement("div");
    head.className = "ticket-head";
    head.innerHTML = `
      <div class="ticket-main">
        <div class="ticket-device">${esc(t.device || "—")}</div>
        <div class="ticket-issue">${esc(t.issue || "")}</div>
      </div>
      <span class="status-badge ${STATUS_CLASS[t.status] || "st-received"}">${esc(t.status || "—")}</span>`;

    const body = document.createElement("div");
    body.className = "ticket-body";
    body.innerHTML = `
      <div class="ticket-row"><span class="k">Ticket</span><span class="v">${esc(t.id || "")}</span></div>
      <div class="ticket-row"><span class="k">Issue</span><span class="v">${esc(t.issue || "—")}</span></div>
      <div class="ticket-row"><span class="k">Logged</span><span class="v">${esc(fmtDate(t.created))}</span></div>
      <div class="ticket-row"><span class="k">Updated</span><span class="v">${esc(fmtDate(t.updated))}</span></div>
      ${t.notes ? `<div class="ticket-row"><span class="k">Notes</span><span class="v">${esc(t.notes)}</span></div>` : ""}
      <div class="ticket-actions">
        <div class="field-label">Set status</div>
        <div class="status-buttons"></div>
        <button class="ghost-btn ticket-edit-btn">✎ Edit details</button>
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
