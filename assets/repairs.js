/* ============================================================
   Repair tracking — log client devices & update repair status.
   Talks to a Google Apps Script web app that reads/writes a
   private "Repairs" tab in the same spreadsheet.

   The script URL + team PIN are stored only in this browser
   (localStorage) — never committed to the repo — so client data
   stays private. See apps-script/Code.gs + README for setup.
   ============================================================ */

(function () {
  // Status pipeline — keep in sync with apps-script/Code.gs STATUSES.
  const STATUSES = [
    "Received",
    "Diagnosing",
    "Awaiting Approval",
    "In Progress",
    "Awaiting Parts",
    "Ready for Pickup",
    "Collected",
    "Cancelled",
  ];
  const STATUS_CLASS = {
    "Received": "st-received",
    "Diagnosing": "st-diagnosing",
    "Awaiting Approval": "st-approval",
    "In Progress": "st-progress",
    "Awaiting Parts": "st-parts",
    "Ready for Pickup": "st-ready",
    "Collected": "st-collected",
    "Cancelled": "st-cancelled",
  };

  const LS_URL = "rpc_repairs_url";
  const LS_PIN = "rpc_repairs_pin";

  const $ = (id) => document.getElementById(id);

  // State
  let TICKETS = [];
  let statusFilter = "all";
  let editingId = null;
  let loadedOnce = false;

  // ---- View navigation -----------------------------------------------------
  const navBtns = document.querySelectorAll(".nav-btn");
  const views = { prices: $("view-prices"), repairs: $("view-repairs") };
  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      navBtns.forEach((b) => b.classList.toggle("active", b === btn));
      Object.entries(views).forEach(([k, v]) => (v.hidden = k !== target));
      // Refresh button only makes sense on the prices view.
      const rb = $("refreshBtn");
      if (rb) rb.hidden = target !== "prices";
      if (target === "repairs") enterRepairs();
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
    $("repairsSetup").hidden = false;
    $("repairsMain").hidden = true;
    if (prefill) {
      const c = getCfg();
      $("cfgUrl").value = c.url;
      $("cfgPin").value = c.pin;
    }
  }
  function showMain() {
    $("repairsSetup").hidden = true;
    $("repairsMain").hidden = false;
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

  // ---- Enter repairs view --------------------------------------------------
  function enterRepairs() {
    if (!isConfigured()) {
      showSetup(false);
      return;
    }
    showMain();
    if (!loadedOnce) loadTickets();
  }

  async function loadTickets() {
    $("repairLoading").style.display = "block";
    $("repairError").hidden = true;
    try {
      const res = await api({ action: "list" });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TICKETS = res.tickets || [];
      loadedOnce = true;
      renderStatusChips();
      render();
    } catch (e) {
      $("repairList").innerHTML = "";
      $("repairEmpty").hidden = true;
      $("repairError").hidden = false;
      $("repairErrorSub").textContent =
        "Couldn't load repairs (" + e.message + "). Tap ↻ to retry.";
    } finally {
      $("repairLoading").style.display = "none";
    }
  }

  $("reloadRepairs").addEventListener("click", loadTickets);
  $("repairsSettings").addEventListener("click", () => showSetup(true));

  // ---- Form ----------------------------------------------------------------
  populateStatusSelect();

  function populateStatusSelect() {
    $("fStatus").innerHTML = STATUSES.map(
      (s) => `<option value="${s}">${s}</option>`
    ).join("");
  }

  function openForm(ticket) {
    editingId = ticket ? ticket.id : null;
    $("repairForm").hidden = false;
    $("fClient").value = ticket ? ticket.client || "" : "";
    $("fPhone").value = ticket ? ticket.phone || "" : "";
    $("fDevice").value = ticket ? ticket.device || "" : "";
    $("fIssue").value = ticket ? ticket.issue || "" : "";
    $("fPrice").value = ticket ? ticket.price || "" : "";
    $("fStatus").value = ticket ? ticket.status || "Received" : "Received";
    $("fNotes").value = ticket ? ticket.notes || "" : "";
    $("saveForm").textContent = ticket ? "Update ticket" : "Save ticket";
    $("formError").hidden = true;
    $("repairForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("fClient").focus();
  }
  function closeForm() {
    $("repairForm").hidden = true;
    editingId = null;
  }

  $("newRepairBtn").addEventListener("click", () => openForm(null));
  $("cancelForm").addEventListener("click", closeForm);

  $("repairForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      action: editingId ? "update" : "add",
      id: editingId || undefined,
      client: $("fClient").value.trim(),
      phone: $("fPhone").value.trim(),
      device: $("fDevice").value.trim(),
      issue: $("fIssue").value.trim(),
      price: $("fPrice").value.trim(),
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
        client: ticket.client,
        phone: ticket.phone,
        device: ticket.device,
        issue: ticket.issue,
        price: ticket.price,
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
  $("repairSearch").addEventListener("input", render);

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
    const q = $("repairSearch").value.trim().toLowerCase();
    return TICKETS.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return [t.client, t.device, t.phone, t.issue, t.id]
        .map((x) => (x || "").toLowerCase())
        .some((x) => x.includes(q));
    });
  }

  function render() {
    const list = currentList();
    $("repairList").innerHTML = "";
    $("repairEmpty").hidden = list.length > 0;
    $("repairError").hidden = true;
    $("repairCount").textContent = list.length
      ? `${list.length} repair${list.length === 1 ? "" : "s"}`
      : "";
    const frag = document.createDocumentFragment();
    for (const t of list) frag.appendChild(ticketCard(t));
    $("repairList").appendChild(frag);
  }

  function ticketCard(t) {
    const el = document.createElement("div");
    el.className = "ticket";

    const head = document.createElement("div");
    head.className = "ticket-head";
    head.innerHTML = `
      <div class="ticket-main">
        <div class="ticket-device">${esc(t.device || "—")}</div>
        <div class="ticket-client">${esc(t.client || "")}${t.phone ? " · " + esc(t.phone) : ""}</div>
      </div>
      <span class="status-badge ${STATUS_CLASS[t.status] || "st-received"}">${esc(t.status || "—")}</span>`;

    const body = document.createElement("div");
    body.className = "ticket-body";
    body.innerHTML = `
      <div class="ticket-row"><span class="k">Ticket</span><span class="v">${esc(t.id || "")}</span></div>
      <div class="ticket-row"><span class="k">Issue / repair</span><span class="v">${esc(t.issue || "—")}</span></div>
      ${t.price ? `<div class="ticket-row"><span class="k">Quoted</span><span class="v">${fmtPrice(t.price)}</span></div>` : ""}
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
  function fmtPrice(raw) {
    const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    return !isNaN(num) ? "$" + num.toLocaleString() : esc(raw);
  }
  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
})();
