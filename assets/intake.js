/* ============================================================
   Device check-in — log devices, select one or more issues, track
   status, and keep a timestamped activity log of every change.
   Talks to a Vercel serverless API (api/intake.js) backed by Postgres,
   which mirrors the old Google Apps Script backend's request/response
   shape exactly.

   The API URL is fixed below (it's not secret on its own — every
   request still requires the team PIN, checked server-side). Only the
   PIN is entered once per device and stored in localStorage.
   ============================================================ */

(function () {
  // Stable production alias for the Vercel project (auto-updates on every
  // push to main) — update if the project or domain ever changes.
    const SCRIPT_URL = "https://pricechecker-cyan.vercel.app/api/intake";
    const INVENTORY_URL = "https://pricechecker-cyan.vercel.app/api/inventory";
  const MEDIA_UPLOAD_URL = "https://pricechecker-cyan.vercel.app/api/media-upload";
  const INVOICE_URL = "https://pricechecker-cyan.vercel.app/api/invoice";
  // Ticket media now uploads straight to Cloudflare R2 via a presigned PUT
  // URL (api/media-upload.js issues it) instead of Vercel Blob's client
  // helper — no CDN-loaded library needed, it's a plain fetch() PUT.
  const MEDIA_MAX_BYTES = 50 * 1024 * 1024; // mirror api/media-upload.js's authoritative cap
  const MEDIA_ALLOWED_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "video/mp4",
    "video/quicktime",
    "video/webm",
  ]);

  // Status pipeline — keep in sync with apps-script/Code.gs STATUSES.
  const STATUSES = [
    "Received",
    "Diagnosing",
    "Waiting for Parts",
    "Part to be Ordered",
    "Part Ordered",
    "In Progress",
    "Repaired",
    "Checked Out - Waiting on Client",
    "No Fix",
    "Picked Up",
    "Cancelled",
  ];
  const STATUS_CLASS = {
    "Received": "st-received",
    "Diagnosing": "st-diagnosing",
    "Waiting for Parts": "st-parts",
    "Part to be Ordered": "st-parts-needed",
    "Part Ordered": "st-parts-ordered",
    "In Progress": "st-progress",
    "Repaired": "st-repaired",
    "Checked Out - Waiting on Client": "st-checked-out",
    "No Fix": "st-no-fix",
    "Picked Up": "st-pickedup",
    "Cancelled": "st-cancelled",
  };
  const ACTIVE_REPAIR_STATUSES = new Set([
    "Received",
    "Diagnosing",
    "Waiting for Parts",
    "Part to be Ordered",
    "Part Ordered",
    "In Progress",
  ]);
  // Every status where the repair is blocked on a part — keep in sync with
  // lib/tickets.js PARTS_STATUSES.
  const PARTS_STATUSES = new Set(["Waiting for Parts", "Part to be Ordered", "Part Ordered"]);
  // Repair-check "open for N days" alert only applies to tickets stuck in
  // one of these statuses — keep in sync with lib/tickets.js REPAIR_CHECK_STATUSES.
  const REPAIR_CHECK_ALERT_STATUSES = new Set(["Received", "Waiting for Parts"]);
  // "Stuck" means more than this many days since being logged — keep in
  // sync with lib/tickets.js REPAIR_CHECK_MIN_DAYS.
  const REPAIR_CHECK_ALERT_MIN_DAYS = 2;

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
  const TICKET_PAGE_SIZE = 12;
  const DEFAULT_TECHNICIANS = ["Liana", "Michael", "Marcus"];

  const $ = (id) => document.getElementById(id);
  // Skip autofocus on touch devices so opening a form doesn't immediately
  // pop the on-screen keyboard and shove the layout around.
  const isTouchDevice = () => window.matchMedia("(pointer: coarse)").matches;
  const focusUnlessTouch = (el) => {
    if (el && !isTouchDevice()) el.focus();
  };

  // State
  let TICKETS = [];
  let TECHNICIANS = [];
  let CUSTOMERS = [];
  let statusFilter = "all";
  let editingId = null;
  let formStep = 1;
  // Highest step the user has validated their way to in this form session —
  // lets the progress-step numbers jump straight to any already-visited step.
  let maxStepReached = 1;
  // Devices already confirmed via "Add another device" for the client
  // currently being checked in — each becomes its own ticket on save.
  let formDevices = [];
  // True when the form was opened from a Prices-tab repair click — device and
  // issue are already known, so the wizard skips straight to Payment.
  let quickLogMode = false;
  let loadedOnce = false;
  let visibleTicketCount = TICKET_PAGE_SIZE;
  // If Check In is not configured yet, retain a price-row selection until the
  // user has manually connected the Check In tab.
  let pendingLogDevice = null;
  let technicianModalTicket = null;
  let statusModalTicket = null;
  let suppressTechnicianFocusOpen = false;
  let INVENTORY_ITEMS = [];
  let inventoryLoadPromise = null;

  // ---- Toasts ---------------------------------------------------------------
  // In-app notification strip replacing raw browser alert() popups. Exposed
  // as window.RPC_TOAST so the other per-view modules (appointments,
  // dashboard, …) can reuse it — this file loads before them.
  function toast(message, { tone = "error", duration = 6000 } = {}) {
    let box = document.getElementById("appToasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "appToasts";
      box.className = "app-toasts";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    const el = document.createElement("div");
    el.className = `app-toast${tone === "error" ? " is-error" : ""}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 350);
    }, duration);
  }
  window.RPC_TOAST = toast;

  // ---- View navigation -----------------------------------------------------
  const navBtns = document.querySelectorAll(".nav-btn[data-target]");
  const settingsNavBtn = $("intakeSettings");
  const views = {
    dashboard: $("view-dashboard"),
    targets: $("view-targets"),
    leads: $("view-leads"),
    appointments: $("view-appointments"),
    prices: $("view-prices"),
    diagnostics: $("view-diagnostics"),
    "parts-checker": $("view-parts-checker"),
    intake: $("view-intake"),
    inventory: $("view-inventory"),
    account: $("view-account"),
    reminders: $("view-reminders"),
  };
  function setActiveNav(target) {
    navBtns.forEach((b) => {
      const active = b.dataset.target === target;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (settingsNavBtn) settingsNavBtn.classList.toggle("active", target === "settings");
  }
  function showView(target) {
    Object.entries(views).forEach(([k, v]) => (v.hidden = k !== target));
  }
  const LS_LAST_VIEW = "rpc_last_view";
  function navigateTo(target) {
    // Expenses used to be a top-level tab and is now a panel under Account.
    // Keep the old name working: it's stored in localStorage as the last view
    // on every device that has used the app so far.
    if (target === "expenses") {
      navigateTo("account");
      setAccountPanel("expenses");
      return;
    }
    setActiveNav(target);
    showView(target);
    try { localStorage.setItem(LS_LAST_VIEW, target); } catch (_) {}
    if (target === "dashboard") window.dispatchEvent(new Event("rpc-enter-dashboard"));
    if (target === "targets") window.dispatchEvent(new Event("rpc-enter-targets"));
    if (target === "leads") window.dispatchEvent(new Event("rpc-enter-leads"));
    if (target === "appointments") window.dispatchEvent(new Event("rpc-enter-appointments"));
    if (target === "diagnostics") window.dispatchEvent(new Event("rpc-enter-diagnostics"));
    if (target === "parts-checker") window.dispatchEvent(new Event("rpc-enter-parts-checker"));
    if (target === "intake") enterIntake();
    if (target === "inventory") window.dispatchEvent(new Event("rpc-enter-inventory"));
    if (target === "account") window.dispatchEvent(new Event("rpc-enter-account"));
    if (target === "reminders") window.dispatchEvent(new Event("rpc-enter-reminders"));
  }
  window.RPC_SHOW_VIEW = navigateTo;
  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateTo(btn.dataset.target);
      const mobileRepairParent = btn.dataset.target === "intake"
        && window.matchMedia("(max-width: 899.98px)").matches
        && document.body.classList.contains("nav-open");
      if (mobileRepairParent) return;
      closeNavDrawer();
    });
  });
  // Restore whichever tab was open last time, once every module further down
  // the script list (dashboard.js, appointments.js, ...) has registered its
  // "rpc-enter-*" listener — DOMContentLoaded fires after all of them run.
  document.addEventListener("DOMContentLoaded", () => {
    let saved = null;
    try { saved = localStorage.getItem(LS_LAST_VIEW); } catch (_) {}
    if (saved && views[saved]) navigateTo(saved);
  });

  // ---- Mobile nav drawer ----------------------------------------------------
  const navMenuToggle = $("navMenuToggle");
  const navBackdrop = $("navBackdrop");
  const navDrawerClose = $("navDrawerClose");
  function openNavDrawer() {
    document.body.classList.add("nav-open");
    if (navBackdrop) navBackdrop.hidden = false;
    navMenuToggle?.setAttribute("aria-expanded", "true");
  }
  function closeNavDrawer() {
    document.body.classList.remove("nav-open");
    navMenuToggle?.setAttribute("aria-expanded", "false");
    if (navBackdrop) setTimeout(() => navBackdrop.hidden = true, 250);
  }
  navMenuToggle?.addEventListener("click", () => {
    document.body.classList.contains("nav-open") ? closeNavDrawer() : openNavDrawer();
  });
  navBackdrop?.addEventListener("click", closeNavDrawer);
  navDrawerClose?.addEventListener("click", closeNavDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNavDrawer();
  });

  // ---- Config --------------------------------------------------------------
  const getCfg = () => ({
    url: SCRIPT_URL,
    pin: localStorage.getItem(LS_PIN) || "",
  });
  const isConfigured = () => !!getCfg().pin;

  // ---- Settings sub-tabs -----------------------------------------------------
  // General / Technicians / Customers / Prices, so a page that used to be one
  // long scroll of unrelated sections reads as separate destinations. Same
  // subnav pattern as Appointments/Targets (.appt-subnav / .appt-panel).
  function setSettingsPanel(panel) {
    document.querySelectorAll("[data-settings-panel-section]").forEach((section) => {
      section.hidden = section.dataset.settingsPanelSection !== panel;
    });
    document.querySelectorAll(".appt-subnav-btn[data-settings-panel]").forEach((btn) => {
      const active = btn.dataset.settingsPanel === panel;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  document.querySelectorAll(".appt-subnav-btn[data-settings-panel]").forEach((btn) => {
    btn.addEventListener("click", () => setSettingsPanel(btn.dataset.settingsPanel));
  });

  // ---- Account sub-tabs ------------------------------------------------------
  // Overview / Card payments / Payouts / Expenses. Expenses was its own
  // top-level tab until the card takings ledger arrived and gave it siblings —
  // its markup moved in here untouched, so assets/dashboard.js still drives it
  // by the same element ids.
  function setAccountPanel(panel) {
    document.querySelectorAll("[data-account-panel-section]").forEach((section) => {
      section.hidden = section.dataset.accountPanelSection !== panel;
    });
    document.querySelectorAll(".appt-subnav-btn[data-account-panel]").forEach((btn) => {
      const active = btn.dataset.accountPanel === panel;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    // Expenses loads on the event it has always loaded on; the card-takings
    // panels get their own so assets/account.js can refresh what's on screen.
    if (panel === "expenses") window.dispatchEvent(new Event("rpc-enter-expenses"));
    else window.dispatchEvent(new CustomEvent("rpc-account-panel", { detail: { panel } }));
  }
  window.RPC_ACCOUNT_PANEL = setAccountPanel;
  document.querySelectorAll(".appt-subnav-btn[data-account-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateTo("account");
      setAccountPanel(btn.dataset.accountPanel);
      closeNavDrawer();
    });
  });

  // ---- Repairs sub-tabs -------------------------------------------------------
  // "Existing repairs" (in progress) / "Completed Repairs" (was its own top-level
  // nav item — merged in here as a second sub-tab, same as Appointments'
  // Create/View split). Switching to "completed" re-fires the load that used to
  // run on navigating to the standalone view, so both halves (check-in tickets
  // here, appointments in assets/appointments.js) stay fresh.
  //
  function setRepairsPanel(panel) {
    document.querySelectorAll("[data-repairs-panel-section]").forEach((section) => {
      section.hidden = section.dataset.repairsPanelSection !== panel;
    });
    document.querySelectorAll(".appt-subnav-btn[data-repairs-panel]").forEach((btn) => {
      const active = btn.dataset.repairsPanel === panel;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (panel === "completed") window.dispatchEvent(new Event("rpc-enter-completed-repairs"));
  }
  document.querySelectorAll(".appt-subnav-btn[data-repairs-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateTo("intake");
      setRepairsPanel(btn.dataset.repairsPanel);
      closeNavDrawer();
    });
  });

  function showSetup(prefill) {
    $("intakeSetup").hidden = false;
    $("intakeMain").hidden = true;
    $("settingsMaintenance").hidden = !prefill;
    if (prefill) $("cfgPin").value = getCfg().pin;
    if (prefill && isConfigured()) {
      loadTechnicians();
      loadCustomers();
    }
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
      visibleTicketCount = TICKET_PAGE_SIZE;
      loadedOnce = true;
      showMain();
      renderStatusChips();
      render();
      publishTickets();
      if (pendingLogDevice) {
        const detail = pendingLogDevice;
        pendingLogDevice = null;
        applyLogDevicePrefill(detail);
      }
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
      await loadTechnicians();
      visibleTicketCount = TICKET_PAGE_SIZE;
      loadedOnce = true;
      renderStatusChips();
      render();
      publishTickets();
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

  function publishTickets() {
    window.RPC_INTAKE_TICKETS = TICKETS.slice();
    window.dispatchEvent(new CustomEvent("rpc-tickets", { detail: { tickets: TICKETS.slice() } }));
  }

  $("reloadIntake").addEventListener("click", loadTickets);
  settingsNavBtn?.addEventListener("click", () => {
    setActiveNav("settings");
    showView("intake");
    showSetup(true);
    closeNavDrawer();
  });
  $("closeIntakeSettings").addEventListener("click", () => {
    setActiveNav("intake");
    enterIntake();
  });

  // ---- Inventory used by repair tickets -----------------------------------
  async function loadInventoryForForm() {
    if (Array.isArray(window.RPC_INVENTORY_ITEMS) && window.RPC_INVENTORY_ITEMS.length) {
      INVENTORY_ITEMS = window.RPC_INVENTORY_ITEMS.slice();
      return INVENTORY_ITEMS;
    }
    if (window.RPC_LOAD_INVENTORY) {
      const result = await window.RPC_LOAD_INVENTORY({ force: false });
      INVENTORY_ITEMS = (result && result.items) || window.RPC_INVENTORY_ITEMS || [];
      return INVENTORY_ITEMS;
    }
    if (inventoryLoadPromise) return inventoryLoadPromise;
    inventoryLoadPromise = fetch(INVENTORY_URL + "?_=" + Date.now(), { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((data) => {
        if (!data.ok) throw new Error(data.error || "Rejected");
        INVENTORY_ITEMS = data.items || [];
        window.RPC_INVENTORY_ITEMS = INVENTORY_ITEMS.slice();
        return INVENTORY_ITEMS;
      })
      .finally(() => { inventoryLoadPromise = null; });
    return inventoryLoadPromise;
  }

  window.addEventListener("rpc-inventory", (e) => {
    INVENTORY_ITEMS = (e.detail && e.detail.items) || window.RPC_INVENTORY_ITEMS || [];
    updateInventoryOptions($("fInventoryItem")?.value || "");
  });

  function repairNeedsInventory(issuesStr) {
    const text = String(issuesStr || "").toLowerCase();
    if (/battery/.test(text)) return "BATTERIES";
    if (/screen|lcd|display|front glass/.test(text)) return "SCREENS";
    return "";
  }

  function matchingInventoryItems(device, issuesStr) {
    const wantedSection = repairNeedsInventory(issuesStr);
    if (!wantedSection) return [];
    const model = normalizeDeviceText(device);
    return INVENTORY_ITEMS.filter((item) => {
      if (item.section !== wantedSection) return false;
      if (!model) return true;
      return inventoryDeviceMatches(model, normalizeDeviceText(item.device || item.item || ""));
    });
  }

  function normalizeDeviceText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\bapple\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inventoryDeviceMatches(device, inventoryDevice) {
    if (!device || !inventoryDevice) return false;
    return device === inventoryDevice || device.includes(inventoryDevice) || inventoryDevice.includes(device);
  }

  function updateInventoryOptions(selectedKey = "") {
    const select = $("fInventoryItem");
    if (!select) return;
    const device = $("fDevice").value.trim();
    const issues = buildIssuesString();
    const suggested = matchingInventoryItems(device, issues);
    const suggestedKeys = new Set(suggested.map((item) => item.key));
    const available = INVENTORY_ITEMS.filter((item) => item.quantity > 0 || item.key === selectedKey);
    const other = available.filter((item) => !suggestedKeys.has(item.key));
    const parts = [`<option value="">No stock item used</option>`];
    if (suggested.length) {
      parts.push(`<optgroup label="Suggested">`);
      suggested.forEach((item) => parts.push(inventoryOptionHtml(item, selectedKey)));
      parts.push(`</optgroup>`);
    }
    if (other.length) {
      parts.push(`<optgroup label="All inventory">`);
      other.forEach((item) => parts.push(inventoryOptionHtml(item, selectedKey)));
      parts.push(`</optgroup>`);
    }
    select.innerHTML = parts.join("");
    const hasSelectedKey = selectedKey && Array.from(select.options).some((option) => option.value === selectedKey);
    select.value = hasSelectedKey ? selectedKey : "";
    const hint = $("inventoryHint");
    const need = repairNeedsInventory(issues);
    if (!need) {
      hint.textContent = "Choose a stock item only if this repair uses one.";
    } else if (suggested.length) {
      hint.textContent = `${suggested.length} matching ${need.toLowerCase()} item${suggested.length === 1 ? "" : "s"} found.`;
    } else {
      hint.textContent = `No matching ${need.toLowerCase()} stock found for this device.`;
    }
  }

  function inventoryOptionHtml(item, selectedKey) {
    const isSelected = item.key === selectedKey;
    const disabled = item.quantity <= 0 && !isSelected;
    const bits = [item.item || item.device || item.label, item.quality, item.section].filter(Boolean);
    const label = `${bits.join(" · ")} — ${item.quantity} in stock${item.note ? " · " + item.note : ""}`;
    return `<option value="${esc(item.key)}"${disabled ? " disabled" : ""}>${esc(label)}</option>`;
  }

  function refreshInventoryAfterStockChange() {
    if (window.RPC_LOAD_INVENTORY) {
      window.RPC_LOAD_INVENTORY({ force: true }).catch(() => {});
    } else {
      INVENTORY_ITEMS = [];
    }
  }

  // ---- Technician roster ----------------------------------------------------
  function normalizeTechnicians(list) {
    return (list || [])
      .map((t) => ({ id: t.id || t.name, name: String(t.name || "").trim() }))
      .filter((t) => t.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function loadTechnicians() {
    try {
      const res = await api({ action: "listTechnicians" });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TECHNICIANS = normalizeTechnicians(res.technicians);
      renderTechnicianSettings();
      return TECHNICIANS;
    } catch (e) {
      renderTechnicianSettings("Couldn't load technicians: " + e.message);
      return TECHNICIANS;
    }
  }

  function technicianNamesWithLegacy(ticket) {
    const names = new Set(DEFAULT_TECHNICIANS.concat(TECHNICIANS.map((t) => t.name)));
    if (ticket && ticket.technician) names.add(ticket.technician);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  function findCanonicalTechnicianName(name, ticket = technicianModalTicket) {
    const wanted = String(name || "").trim().toLowerCase();
    if (!wanted) return "";
    return technicianNamesWithLegacy(ticket).find((candidate) => candidate.toLowerCase() === wanted) || "";
  }

  function isDefaultTechnician(name) {
    return DEFAULT_TECHNICIANS.some((defaultName) => defaultName.toLowerCase() === String(name || "").toLowerCase());
  }

  function renderTechnicianSettings(message = "") {
    const box = $("technicianSettingsList");
    if (!box) return;
    const err = $("technicianSettingsError");
    err.hidden = !message;
    if (message) err.textContent = message;
    if (!TECHNICIANS.length) {
      box.innerHTML = `<p class="empty-sub">No technicians created yet.</p>`;
      return;
    }
    box.innerHTML = TECHNICIANS.map((tech) => `
      <div class="technician-row">
        <span><svg class="icon"><use href="#i-user"></use></svg>${esc(tech.name)}</span>
        ${isDefaultTechnician(tech.name)
          ? `<small class="technician-default">Default</small>`
          : `<button type="button" class="ghost-btn technician-delete" data-tech="${esc(tech.name)}" aria-label="Delete ${esc(tech.name)}"><svg class="icon"><use href="#i-trash"></use></svg></button>`}
      </div>
    `).join("");
    box.querySelectorAll(".technician-delete").forEach((btn) => {
      btn.addEventListener("click", () => deleteTechnician(btn.dataset.tech || ""));
    });
  }

  async function createTechnician(name) {
    const cleanName = String(name || "").trim().replace(/\s+/g, " ");
    if (!cleanName) throw new Error("Technician name is required");
    const res = await api({ action: "addTechnician", name: cleanName });
    if (!res.ok) throw new Error(res.error || "Rejected");
    TECHNICIANS = normalizeTechnicians(res.technicians);
    renderTechnicianSettings();
    return findCanonicalTechnicianName(cleanName) || cleanName;
  }

  async function addTechnicianFromSettings() {
    const input = $("newTechnicianName");
    const name = input.value.trim();
    const err = $("technicianSettingsError");
    err.hidden = true;
    if (!name) {
      err.textContent = "Enter a technician name.";
      err.hidden = false;
      return;
    }
    const btn = $("addTechnician");
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      await createTechnician(name);
      input.value = "";
    } catch (e) {
      err.textContent = "Couldn't add technician: " + e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  async function deleteTechnician(name) {
    if (!name) return;
    if (!window.confirm(`Delete technician "${name}" from the roster? Existing tickets keep their assignment.`)) return;
    const err = $("technicianSettingsError");
    err.hidden = true;
    try {
      const res = await api({ action: "deleteTechnician", name });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TECHNICIANS = normalizeTechnicians(res.technicians);
      renderTechnicianSettings();
    } catch (e) {
      err.textContent = "Couldn't delete technician: " + e.message;
      err.hidden = false;
    }
  }

  $("addTechnician").addEventListener("click", addTechnicianFromSettings);
  $("newTechnicianName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTechnicianFromSettings();
    }
  });

  // ---- Customer directory -----------------------------------------------------
  // Read-only here: every check-in's name/phone/email is saved server-side
  // into a shared customers table (lib/customers.js), matched by phone
  // number, whenever a device is logged or edited. This just lists what's
  // already been saved — there's no separate "add customer" flow.
  async function loadCustomers() {
    try {
      const res = await api({ action: "listCustomers" });
      if (!res.ok) throw new Error(res.error || "Rejected");
      CUSTOMERS = res.customers || [];
      renderCustomerSettings();
    } catch (e) {
      renderCustomerSettings("Couldn't load customers: " + e.message);
    }
  }

  function renderCustomerSettings(message = "") {
    const box = $("customerSettingsList");
    if (!box) return;
    const err = $("customerSettingsError");
    if (err) {
      err.hidden = !message;
      if (message) err.textContent = message;
    }
    const q = ($("customerSearch")?.value || "").trim().toLowerCase();
    const list = !q ? CUSTOMERS : CUSTOMERS.filter((c) =>
      [c.name, c.phone, c.email].map((x) => (x || "").toLowerCase()).some((x) => x.includes(q)));
    const countEl = $("customerCount");
    if (countEl) {
      countEl.textContent = CUSTOMERS.length
        ? `Showing ${list.length} of ${CUSTOMERS.length} customer${CUSTOMERS.length === 1 ? "" : "s"}`
        : "";
    }
    if (!CUSTOMERS.length) {
      box.innerHTML = `<p class="empty-sub">No customers saved yet — they're added automatically when a device is logged.</p>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = `<p class="empty-sub">No customers match your search.</p>`;
      return;
    }
    box.innerHTML = list.map((c) => `
      <div class="customer-row">
        <div class="customer-row-main">
          <div class="customer-name">${esc(c.name || "Unknown customer")}</div>
          <div class="customer-meta">
            ${c.phone
              ? `<a class="customer-phone" href="tel:${esc(c.phone)}"><svg class="icon"><use href="#i-phone"></use></svg>${esc(c.phone)}</a>`
              : `<span class="customer-phone no-phone">No number</span>`}
            ${c.email ? `<span class="customer-email">${esc(c.email)}</span>` : ""}
          </div>
        </div>
        <div class="customer-stats">
          <span class="customer-count">${c.ticketCount} device${c.ticketCount === 1 ? "" : "s"}</span>
          <span class="customer-last">${c.lastTicketAt ? "Last visit " + fmtDate(c.lastTicketAt) : "No repairs yet"}</span>
        </div>
      </div>
    `).join("");
  }

  $("customerSearch")?.addEventListener("input", () => renderCustomerSettings());

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
  // Backdrop clicks deliberately do NOT close modals: these are data-entry
  // sheets used on a shop tablet, and one stray tap outside the panel used to
  // throw away a half-filled form. Closing is always an explicit action — the
  // X, Cancel/Done, or Escape.
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
      visibleTicketCount = TICKET_PAGE_SIZE;
      statusFilter = "all";
      refreshInventoryAfterStockChange();
      closeForm();
      closeClearAllModal();
      renderStatusChips();
      render();
      publishTickets();
      if (res.backup) toast(`Deleted ${res.deletedCount} record${res.deletedCount === 1 ? "" : "s"}. Backup ${res.backup.id} is ready to restore if needed.`, { tone: "info" });
    } catch (e) {
      err.textContent = "Couldn't clear devices: " + e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // ---- Backup restore ------------------------------------------------------
  async function openRestoreBackupModal() {
    const err = $("restoreBackupError");
    err.hidden = true;
    $("backupSelect").innerHTML = "";
    $("restoreBackupEmpty").hidden = true;
    $("confirmRestoreBackup").disabled = true;
    $("restoreBackupModal").hidden = false;
    try {
      const res = await api({ action: "listBackups" });
      if (!res.ok) throw new Error(res.error || "Rejected");
      const backups = res.backups || [];
      $("restoreBackupEmpty").hidden = backups.length > 0;
      $("backupSelect").hidden = backups.length === 0;
      $("confirmRestoreBackup").disabled = backups.length === 0;
      $("backupSelect").innerHTML = backups.map((backup) =>
        `<option value="${esc(backup.id)}">${esc(fmtDate(backup.created))} · ${Number(backup.count) || 0} record${Number(backup.count) === 1 ? "" : "s"}</option>`
      ).join("");
      if (backups.length) $("backupSelect").focus();
    } catch (e) {
      err.textContent = "Couldn't load backups: " + e.message;
      err.hidden = false;
    }
  }

  function closeRestoreBackupModal() { $("restoreBackupModal").hidden = true; }
  $("restoreIntake").addEventListener("click", openRestoreBackupModal);
  $("closeRestoreBackupModal").addEventListener("click", closeRestoreBackupModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("restoreBackupModal").hidden) closeRestoreBackupModal();
  });

  $("confirmRestoreBackup").addEventListener("click", async () => {
    const id = $("backupSelect").value;
    const err = $("restoreBackupError");
    err.hidden = true;
    if (!id) return;
    if (!window.confirm("Restore this check-in backup? Your current records will first be saved as a new backup.")) return;
    const btn = $("confirmRestoreBackup");
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.textContent = "Restoring…";
    try {
      const res = await api({ action: "restoreBackup", id: id });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TICKETS = (res.tickets || []).map(normalizeTicket);
      statusFilter = "all";
      visibleTicketCount = TICKET_PAGE_SIZE;
      refreshInventoryAfterStockChange();
      renderStatusChips();
      render();
      publishTickets();
      closeRestoreBackupModal();
      toast(`Restored ${res.restoredCount} record${res.restoredCount === 1 ? "" : "s"}. Your previous check-in list is backed up as ${res.backup.id}.`, { tone: "info" });
    } catch (e) {
      err.textContent = "Couldn't restore backup: " + e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
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
    updateInventoryOptions($("fInventoryItem")?.value || "");
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("issueModal").hidden) closeIssueModal();
  });

  // ---- Ticket detail modal -------------------------------------------------
  function parseHistoryEntries(historyStr) {
    if (!historyStr) return [];
    return historyStr
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
        return { when: m ? m[1] : "", msg: m ? m[2] : line };
      })
      .reverse();
  }

  // Internal note log, keyed by ticket id. Cached here so the badge count can
  // include notes already fetched without refetching on every render.
  const TICKET_NOTES = Object.create(null);

  function activityLogCount(ticket) {
    return (
      parseHistoryEntries(ticket.history).length +
      (ticket.notes ? 1 : 0) +
      (TICKET_NOTES[ticket.id]?.length || 0) +
      splitIssueParts(ticket.issues).long.length
    );
  }

  function activityLogBtnHtml(ticket, id) {
    const count = activityLogCount(ticket);
    const label = count
      ? `View ${count} update${count === 1 ? "" : "s"} and notes`
      : "View updates and notes";
    const shortLabel = count
      ? `${count} update${count === 1 ? "" : "s"} / note${count === 1 ? "" : "s"}`
      : "Updates & notes";
    return `<button type="button" class="activity-log-btn" id="${id}" aria-label="${esc(label)}" title="${esc(shortLabel)}">
      <svg class="icon" aria-hidden="true"><use href="#i-note"></use></svg>
      ${count ? `<span class="activity-log-badge" aria-hidden="true">${count}</span>` : ""}
    </button>`;
  }

  function bindActivityLogBtn(btn, ticket) {
    if (!btn) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      openActivityLogModal(ticket);
    };
    btn.onkeydown = (e) => e.stopPropagation();
  }

  function noteWhenLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  function ticketNoteListHtml(ticket) {
    const logged = TICKET_NOTES[ticket.id] || [];
    const items = logged.map((n) => `
      <div class="ticket-note-item" data-note-id="${esc(n.id)}">
        <div class="ticket-note-body">
          <p class="ticket-note-text">${esc(n.note)}</p>
          <span class="ticket-note-when mono">${esc(noteWhenLabel(n.created))}</span>
        </div>
        <button type="button" class="ticket-note-delete" data-delete-note="${esc(n.id)}" aria-label="Delete note">
          <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
        </button>
      </div>`);
    // The check-in note isn't part of the log and can't be deleted from here —
    // it belongs to the ticket form and prints on the invoice.
    if (ticket.notes) {
      items.push(`
        <div class="ticket-note-item is-checkin">
          <div class="ticket-note-body">
            <p class="ticket-note-text">${esc(ticket.notes)}</p>
            <span class="ticket-note-when">From check-in</span>
          </div>
        </div>`);
    }
    if (!items.length) return `<p class="ticket-note-empty">No notes yet.</p>`;
    return items.join("");
  }

  function activityLogBodyHtml(ticket) {
    const sections = [];
    const longIssueParts = splitIssueParts(ticket.issues).long;
    if (longIssueParts.length) {
      sections.push(`<section class="activity-log-section">
        <p class="field-label">Issue details</p>
        ${longIssueParts.map((p) => `<p class="ticket-detail-notes activity-log-note">${esc(p)}</p>`).join("")}
      </section>`);
    }
    // Notes are editable in place: type and press Enter to append one. The
    // list below is the internal log; ticket.notes (written at check-in and
    // printed on the customer's invoice) is shown as the oldest entry so
    // nothing that used to be visible here disappears.
    sections.push(`<section class="activity-log-section">
      <p class="field-label">Notes</p>
      <form id="ticketNoteForm" class="ticket-note-form" autocomplete="off">
        <input id="ticketNoteInput" class="text-input ticket-note-input"
          placeholder="Add a note, then press Enter" aria-label="Add a note" />
      </form>
      <p id="ticketNoteError" class="field-error" hidden></p>
      <div id="ticketNoteList" class="ticket-note-list">${ticketNoteListHtml(ticket)}</div>
    </section>`);
    const entries = parseHistoryEntries(ticket.history);
    if (entries.length) {
      sections.push(`<section class="activity-log-section">
        <p class="field-label">Updates</p>
        <div class="history-list">${entries
          .map(({ when, msg }) =>
            `<div class="history-item"><span class="history-dot"></span><div><div class="history-msg">${esc(msg)}</div><div class="history-when mono">${esc(when ? fmtDate(when) : "")}</div></div></div>`
          )
          .join("")}</div>
      </section>`);
    }
    if (!sections.length) return `<p class="empty-sub">No updates or notes recorded yet.</p>`;
    return sections.join("");
  }

  let activityLogTicket = null;

  function openActivityLogModal(ticket) {
    activityLogTicket = ticket;
    $("activityLogTitle").textContent = ticket.device || "Updates & notes";
    $("activityLogBody").innerHTML = activityLogBodyHtml(ticket);
    $("activityLogModal").hidden = false;
    bindTicketNoteForm(ticket);
    // Focus the note box rather than the close button — adding a note is what
    // this modal is usually opened to do.
    ($("ticketNoteInput") || $("closeActivityLogModal")).focus();
    loadTicketNotes(ticket);
  }

  // Notes are fetched per ticket rather than shipped with the ticket list —
  // the list is polled often and most tickets' notes are never looked at.
  async function loadTicketNotes(ticket) {
    try {
      const data = await api({ action: "listTicketNotes", ticketId: ticket.id });
      TICKET_NOTES[ticket.id] = data.notes || [];
      if (activityLogTicket && activityLogTicket.id === ticket.id) refreshTicketNoteList(ticket);
    } catch (_) {
      // Offline or rejected — the check-in note still renders, and adding a
      // note will surface its own error if that fails too.
    }
  }

  function refreshTicketNoteList(ticket) {
    const list = $("ticketNoteList");
    if (list) list.innerHTML = ticketNoteListHtml(ticket);
  }

  function bindTicketNoteForm(ticket) {
    const form = $("ticketNoteForm");
    const input = $("ticketNoteInput");
    const err = $("ticketNoteError");
    const list = $("ticketNoteList");
    if (!form || !input) return;

    async function submitNote() {
      const note = input.value.trim();
      if (!note) return;
      if (err) err.hidden = true;
      input.disabled = true;
      try {
        const data = await api({ action: "addTicketNote", ticketId: ticket.id, note });
        TICKET_NOTES[ticket.id] = data.notes || [];
        input.value = "";
        refreshTicketNoteList(ticket);
      } catch (e) {
        if (err) { err.textContent = "Couldn't add the note: " + e.message; err.hidden = false; }
      } finally {
        input.disabled = false;
        input.focus();
      }
    }

    // Enter is handled explicitly rather than relying on the form's implicit
    // submission: this form has no submit button (by design — the whole point
    // is type-and-press-Enter), and without one the browser doesn't reliably
    // fire submit. Verified: it does not fire here.
    input.onkeydown = (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      submitNote();
    };
    // Kept so the form still behaves if a submit control is ever added.
    form.onsubmit = (event) => {
      event.preventDefault();
      submitNote();
    };

    if (list) {
      list.onclick = async (event) => {
        const btn = event.target.closest("[data-delete-note]");
        if (!btn) return;
        if (!window.confirm("Delete this note?")) return;
        btn.disabled = true;
        try {
          const data = await api({ action: "deleteTicketNote", ticketId: ticket.id, noteId: btn.dataset.deleteNote });
          TICKET_NOTES[ticket.id] = data.notes || [];
          refreshTicketNoteList(ticket);
        } catch (e) {
          btn.disabled = false;
          if (err) { err.textContent = "Couldn't delete the note: " + e.message; err.hidden = false; }
        }
      };
    }
  }

  function closeActivityLogModal() {
    $("activityLogModal").hidden = true;
    activityLogTicket = null;
  }

  $("closeActivityLogModal").addEventListener("click", closeActivityLogModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("activityLogModal").hidden) closeActivityLogModal();
  });

  let currentModalTicket = null;

  const INLINE_EDIT_FIELDS = {
    customerName: { type: "text", required: true },
    phone: { type: "tel", required: false },
    email: { type: "email", required: false },
    device: { type: "text", required: true },
    repairDueDate: { type: "date", required: false },
    repairCost: { type: "number", required: false },
    amountPaid: { type: "number", required: false },
    // Method and card type are one choice to staff ("how did they pay?") but
    // two fields to the server, so the option value carries both and
    // saveInlineEdit splits it back apart on the way out.
    paymentMethod: {
      type: "select",
      required: false,
      options: [
        { value: "", label: "Not recorded" },
        { value: "cash", label: "Cash" },
        { value: "card:debit", label: "Card — Debit" },
        { value: "card:credit", label: "Card — Credit" },
        { value: "transfer", label: "Bank transfer" },
      ],
    },
  };

  const PAYMENT_METHOD_LABELS = {
    "": "Not recorded",
    cash: "Cash",
    "card:debit": "Card — Debit",
    "card:credit": "Card — Credit",
    transfer: "Bank transfer",
  };
  /** The single value the picker works in, from the ticket's two fields. */
  function paymentMethodValue(ticket) {
    if (ticket.paymentMethod !== "card") return ticket.paymentMethod || "";
    return "card:" + (ticket.cardType === "credit" ? "credit" : "debit");
  }

  function fieldDisplayHtml(field, ticket) {
    switch (field) {
      case "customerName": return esc(ticket.customerName || "Unknown customer");
      case "phone": return ticket.phone ? `<a class="ticket-tel" href="tel:${esc(ticket.phone)}">${esc(ticket.phone)}</a>` : "—";
      case "email": return ticket.email ? `<a class="ticket-tel" href="mailto:${esc(ticket.email)}">${esc(ticket.email)}</a>` : "—";
      case "device": return esc(ticket.device || "—");
      case "repairDueDate": return esc(repairDueDateLabel(ticket.repairDueDate));
      case "repairCost": return formatMoney(ticket.repairCost);
      case "amountPaid": return formatMoney(ticket.amountPaid);
      case "paymentMethod": {
        const label = PAYMENT_METHOD_LABELS[paymentMethodValue(ticket)] || "Not recorded";
        // A card payment isn't in the shop's hands yet, so say so here rather
        // than letting "paid" read as "collected".
        return ticket.paymentMethod === "card"
          ? `${esc(label)} <span class="ticket-card-hint">· in the card takings ledger</span>`
          : esc(label);
      }
      default: return "—";
    }
  }

  function openTicketModal(ticket) {
    currentModalTicket = ticket;
    const hasPhone = !!ticket.phone;
    const technician = ticket.technician || "Unassigned";
    const issueSummary = issueSummaryText(ticket.issues);
    $("ticketModalBody").innerHTML = `
      <div class="ticket-detail-hero">
        <span class="ticket-device-icon"><svg class="icon"><use href="#${deviceTypeIcon(ticket.device)}"></use></svg></span>
        <div class="ticket-detail-hero-main">
          <h4 class="ticket-detail-title">${esc(ticket.device || "Device")}</h4>
          ${issueSummary ? `<p class="ticket-detail-issue">${esc(issueSummary)}</p>` : ""}
          <p class="ticket-detail-id mono">#${esc(ticket.id || "")}</p>
        </div>
        <div class="ticket-detail-hero-actions">
          ${activityLogBtnHtml(ticket, "ticketModalActivity")}
          <button type="button" class="status-badge status-badge-btn ${STATUS_CLASS[ticket.status] || "st-received"}" id="ticketModalStatus" aria-label="Change status (currently ${esc(ticket.status || "—")})">${esc(ticket.status || "—")}</button>
        </div>
      </div>
      <section class="ticket-detail-section"><p class="field-label">Customer & device</p><div class="ticket-detail-grid">
        ${detailRow("i-user", "Customer", fieldDisplayHtml("customerName", ticket), "", "customerName")}
        ${detailRow("i-phone", "Phone", fieldDisplayHtml("phone", ticket), "", "phone")}
        ${detailRow("i-mail", "Email", fieldDisplayHtml("email", ticket), "", "email")}
        ${detailRow("i-device", "Device", fieldDisplayHtml("device", ticket), "", "device")}
        ${detailRow("i-user", "Technician", esc(technician))}
        ${detailRow("i-calendar", "Due date", fieldDisplayHtml("repairDueDate", ticket), repairCheckAlertReason(ticket) ? "repair-due-alert-text" : "", "repairDueDate")}
        ${detailRow("i-tools", "Stock used", esc(ticket.inventoryItemLabel || "No stock item used"))}
      </div></section>
      <section class="ticket-detail-section"><p class="field-label">Payment</p><div class="ticket-detail-grid">
        ${detailRow("i-cash", "Repair cost", fieldDisplayHtml("repairCost", ticket), "money-positive", "repairCost")}
        ${detailRow("i-cash", "Amount paid", fieldDisplayHtml("amountPaid", ticket), "money-positive", "amountPaid")}
        ${detailRow("i-cash", "Balance due", formatMoney(balanceDue(ticket.repairCost, ticket.amountPaid)), balanceTone(ticket.repairCost, ticket.amountPaid))}
        ${detailRow("i-cash", "Paid by", fieldDisplayHtml("paymentMethod", ticket), "", "paymentMethod")}
      </div></section>
      <section class="ticket-detail-section"><p class="field-label">Issues</p><div class="issue-tags issue-tags-readonly">${issueTagsHtml(ticket.issues)}</div></section>
      <section class="ticket-detail-section"><p class="field-label">Photos & videos</p>
        <div class="ticket-media-gallery" id="ticketMediaGallery"><p class="ops-empty ticket-media-loading">Loading…</p></div>
        <label class="ghost-btn ticket-media-add-btn" id="ticketMediaAddBtn">
          <svg class="icon"><use href="#i-camera"></use></svg><span>Add photo/video</span>
          <input type="file" accept="image/*,video/*" capture="environment" hidden id="ticketMediaInput" />
        </label>
        <p class="field-error" id="ticketMediaError" hidden></p>
      </section>`;

    const notifyUrl = whatsAppNotifyUrl(ticket);
    $("ticketModalFooter").innerHTML = `
      ${hasPhone ? `<a class="primary-btn" href="tel:${esc(ticket.phone)}"><svg class="icon"><use href="#i-phone"></use></svg>Call client</a>` : ""}
      ${notifyUrl ? `<a class="ghost-btn whatsapp-btn" href="${esc(notifyUrl)}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-chat"></use></svg>WhatsApp</a>` : ""}
      <button type="button" class="ghost-btn" id="ticketModalAssign"><svg class="icon"><use href="#i-user"></use></svg>${ticket.technician ? "Reassign" : "Assign"}</button>
      <button type="button" class="ghost-btn" id="ticketModalEdit"><svg class="icon"><use href="#i-pencil"></use></svg>Edit</button>
      <button type="button" class="ghost-btn danger-btn" id="ticketModalDelete"><svg class="icon"><use href="#i-trash"></use></svg><span class="visually-hidden">Delete</span></button>`;
    bindActivityLogBtn($("ticketModalActivity"), ticket);
    $("ticketModalStatus").onclick = () => { closeTicketModal(); openStatusModalForTicket(ticket); };
    $("ticketModalAssign").onclick = () => { closeTicketModal(); openTechnicianModalForTicket(ticket); };
    $("ticketModalEdit").onclick = () => { closeTicketModal(); openForm(ticket); };
    $("ticketModalDelete").onclick = async () => { if (await deleteTicket(ticket)) closeTicketModal(); };
    bindTicketMediaControls(ticket);
    loadTicketMedia(ticket);
    $("ticketModal").hidden = false;
    $("closeTicketModal").focus();
  }

  // Lets other tabs (Reminders) jump straight to a specific repair ticket.
  async function openTicketById(id) {
    navigateTo("intake");
    closeNavDrawer();
    if (!loadedOnce) await loadTickets();
    const ticket = TICKETS.find((t) => t.id === id);
    if (ticket) openTicketModal(ticket);
    else if (typeof window.RPC_TOAST === "function") window.RPC_TOAST("Couldn't find that repair ticket — it may have been deleted.");
  }
  window.RPC_OPEN_TICKET_BY_ID = openTicketById;

  function closeTicketModal() {
    closeMediaViewer();
    $("ticketModal").hidden = true;
    currentModalTicket = null;
    activeTicketMedia = [];
  }
  $("closeTicketModal").addEventListener("click", closeTicketModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMediaViewerOpen()) return;
    if (e.key === "Escape" && !$("ticketModal").hidden) closeTicketModal();
  });

  $("ticketModalBody").addEventListener("click", (e) => {
    const pencilBtn = e.target.closest("[data-edit-field]");
    if (pencilBtn) { startInlineEdit(pencilBtn.closest(".ticket-detail-row"), pencilBtn.dataset.editField); return; }
    const saveBtn = e.target.closest("[data-save-field]");
    if (saveBtn) { saveInlineEdit(saveBtn.closest(".ticket-detail-row"), saveBtn.dataset.saveField); return; }
    const cancelBtn = e.target.closest("[data-cancel-field]");
    if (cancelBtn) { renderDetailRowStatic(cancelBtn.closest(".ticket-detail-row"), cancelBtn.dataset.cancelField); return; }
  });

  function startInlineEdit(rowEl, field) {
    if (!rowEl || !currentModalTicket) return;
    const cfg = INLINE_EDIT_FIELDS[field];
    if (!cfg) return;
    const currentValue = currentModalTicket[field] == null ? "" : currentModalTicket[field];
    const control = cfg.type === "select"
      ? `<select class="text-input select-input ticket-inline-input">${cfg.options.map((opt) =>
          `<option value="${esc(opt.value)}"${opt.value === paymentMethodValue(currentModalTicket) ? " selected" : ""}>${esc(opt.label)}</option>`).join("")}</select>`
      : `<input type="${cfg.type}" class="text-input ticket-inline-input" value="${esc(currentValue)}" ${cfg.type === "number" ? 'min="0" step="0.01"' : ""} />`;
    rowEl.querySelector(".ticket-detail-value").outerHTML = `
      <span class="ticket-detail-value ticket-detail-editing">
        ${control}
        <button type="button" class="icon-btn ghost-btn" data-save-field="${field}" aria-label="Save"><svg class="icon"><use href="#i-check"></use></svg></button>
        <button type="button" class="icon-btn ghost-btn" data-cancel-field="${field}" aria-label="Cancel"><svg class="icon"><use href="#i-xmark"></use></svg></button>
      </span>`;
    rowEl.querySelector(".ticket-inline-input")?.focus();
    rowEl.querySelector("[data-edit-field]")?.remove();
  }

  function renderDetailRowStatic(rowEl, field) {
    if (!rowEl || !currentModalTicket) return;
    rowEl.querySelector(".ticket-detail-value")?.remove();
    const valueClass = field === "repairCost" || field === "amountPaid"
      ? "money-positive"
      : field === "repairDueDate" && repairCheckAlertReason(currentModalTicket)
        ? "repair-due-alert-text"
        : "";
    rowEl.insertAdjacentHTML("beforeend", detailValueHtml(fieldDisplayHtml(field, currentModalTicket), valueClass, field));
    // Balance due has no pencil of its own — it's derived from these two
    // fields, so it must be recomputed whenever either one saves, or it's
    // left showing stale math that looks like the edit didn't take.
    if (field === "repairCost" || field === "amountPaid") refreshBalanceDueRow();
  }

  function refreshBalanceDueRow() {
    if (!currentModalTicket) return;
    const labels = document.querySelectorAll("#ticketModalBody .ticket-detail-label");
    for (const label of labels) {
      if (label.textContent.trim() !== "Balance due") continue;
      const row = label.closest(".ticket-detail-row");
      const valueEl = row?.querySelector(".ticket-detail-value");
      if (!valueEl) break;
      valueEl.textContent = formatMoney(balanceDue(currentModalTicket.repairCost, currentModalTicket.amountPaid));
      valueEl.className = "ticket-detail-value " + balanceTone(currentModalTicket.repairCost, currentModalTicket.amountPaid);
      break;
    }
  }

  const FIELD_LABELS = {
    customerName: "Customer",
    phone: "Phone",
    email: "Email",
    device: "Device",
    repairDueDate: "Due date",
    repairCost: "Repair cost",
    amountPaid: "Amount paid",
    paymentMethod: "Payment method",
  };

  async function saveInlineEdit(rowEl, field) {
    if (!rowEl || !currentModalTicket) return;
    const cfg = INLINE_EDIT_FIELDS[field];
    const input = rowEl.querySelector(".ticket-inline-input");
    if (!cfg || !input) return;
    const raw = input.value.trim();
    input.classList.remove("field-error-input");
    if (cfg.required && !raw) {
      input.classList.add("field-error-input");
      toast(`${FIELD_LABELS[field] || "This field"} can't be empty.`);
      return;
    }
    // Numbers must be a valid non-negative amount — the server rejects
    // anything else, so catch it here with a clear message rather than
    // letting the request bounce back as a generic failure.
    if (cfg.type === "number" && raw !== "" && !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      input.classList.add("field-error-input");
      toast(`${FIELD_LABELS[field] || "Amount"} must be a valid amount (e.g. 950 or 950.00).`);
      return;
    }
    const value = cfg.type === "number" ? (raw === "" ? null : Number(raw)) : raw;
    const saveBtn = rowEl.querySelector("[data-save-field]");
    if (saveBtn) saveBtn.disabled = true;
    // "card:credit" is one choice on screen but paymentMethod + cardType to
    // the API, which is what drives the card takings ledger.
    const payload = field === "paymentMethod"
      ? { paymentMethod: raw.startsWith("card") ? "card" : raw, cardType: raw.startsWith("card") ? raw.split(":")[1] : "" }
      : { [field]: value };
    try {
      const res = await api(Object.assign({ action: "update", id: currentModalTicket.id }, payload));
      if (!res.ok) throw new Error(res.error || "Save failed");
      mergeTicket(res.ticket);
      currentModalTicket = TICKETS.find((t) => t.id === currentModalTicket.id) || currentModalTicket;
      renderDetailRowStatic(rowEl, field);
      render();
      // A card payment (or a change to one) has just moved money in the
      // takings ledger, so don't leave the Account tab showing a stale balance.
      if (field === "paymentMethod" || field === "amountPaid") {
        if (typeof window.RPC_ACCOUNT_REFRESH === "function") window.RPC_ACCOUNT_REFRESH();
      }
      toast(`${FIELD_LABELS[field] || "Change"} saved.`, { tone: "info", duration: 2500 });
    } catch (err) {
      if (saveBtn) saveBtn.disabled = false;
      input.classList.add("field-error-input");
      // Never fail silently — a slow cold start, a dropped connection, or a
      // rejected value should tell staff what happened instead of looking
      // like the button did nothing.
      toast(`Couldn't save ${FIELD_LABELS[field] || "change"}: ${err.message}. Check your connection and try again.`);
    }
  }

  function detailValueHtml(value, valueClass, field) {
    const pencil = field ? `<button type="button" class="icon-btn ghost-btn ticket-detail-edit-btn" data-edit-field="${field}" aria-label="Edit"><svg class="icon"><use href="#i-pencil"></use></svg></button>` : "";
    return `<span class="ticket-detail-value ${valueClass}">${value}</span>${pencil}`;
  }

  function detailRow(iconName, label, value, valueClass = "", field = "") {
    return `<div class="ticket-detail-row"><svg class="icon"><use href="#${iconName}"></use></svg><span class="ticket-detail-label">${esc(label)}</span>${detailValueHtml(value, valueClass, field)}</div>`;
  }

  // ---- In-app media viewer -------------------------------------------------
  let activeTicketMedia = [];
  let mediaViewerItems = [];
  let mediaViewerIndex = 0;

  function isMediaViewerOpen() {
    const modal = $("mediaViewerModal");
    return !!modal && !modal.hidden;
  }

  function mediaViewerCurrentItem() {
    return mediaViewerItems[mediaViewerIndex] || null;
  }

  function mediaViewerLabel(item, index, total) {
    const kind = item?.type === "video" ? "Video" : "Photo";
    return `${kind} ${index + 1} of ${total}`;
  }

  function renderMediaViewer() {
    const item = mediaViewerCurrentItem();
    const stage = $("mediaViewerStage");
    if (!item || !stage) return;
    const total = mediaViewerItems.length;
    const label = mediaViewerLabel(item, mediaViewerIndex, total);
    $("mediaViewerTitle").textContent = item.type === "video" ? "Device video" : "Device photo";
    $("mediaViewerMeta").textContent = currentModalTicket?.device || "Device media";
    $("mediaViewerCounter").textContent = label;
    $("mediaViewerOpenOriginal").href = item.url;
    $("mediaViewerOpenOriginal").hidden = String(item.url || "").startsWith("blob:");
    $("mediaViewerPrev").disabled = total < 2;
    $("mediaViewerNext").disabled = total < 2;
    stage.innerHTML = item.type === "video"
      ? `<video class="media-viewer-media" src="${esc(item.url)}" controls autoplay playsinline preload="metadata"></video>`
      : `<img class="media-viewer-media" src="${esc(item.url)}" alt="${esc(label)}" />`;
  }

  function openMediaViewer(items, index = 0) {
    const cleanItems = (items || []).filter((item) => item && item.url);
    if (!cleanItems.length) return;
    mediaViewerItems = cleanItems;
    mediaViewerIndex = Math.min(Math.max(Number(index) || 0, 0), mediaViewerItems.length - 1);
    renderMediaViewer();
    $("mediaViewerModal").hidden = false;
    $("closeMediaViewer")?.focus();
  }

  function closeMediaViewer() {
    const modal = $("mediaViewerModal");
    if (!modal || modal.hidden) return;
    const media = $("mediaViewerStage")?.querySelector("video");
    if (media) media.pause();
    modal.hidden = true;
    $("mediaViewerStage").innerHTML = "";
    mediaViewerItems = [];
    mediaViewerIndex = 0;
  }

  function stepMediaViewer(delta) {
    if (!mediaViewerItems.length) return;
    mediaViewerIndex = (mediaViewerIndex + delta + mediaViewerItems.length) % mediaViewerItems.length;
    renderMediaViewer();
  }

  $("closeMediaViewer")?.addEventListener("click", closeMediaViewer);
  $("mediaViewerPrev")?.addEventListener("click", () => stepMediaViewer(-1));
  $("mediaViewerNext")?.addEventListener("click", () => stepMediaViewer(1));
  document.addEventListener("keydown", (e) => {
    if (!isMediaViewerOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeMediaViewer();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopImmediatePropagation();
      stepMediaViewer(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopImmediatePropagation();
      stepMediaViewer(1);
    }
  });

  // ---- Ticket media (photos & videos of the physical device) ----------------
  // Files upload from the browser straight to Cloudflare R2: api/media-upload.js
  // (phase 1) validates the file and returns a short-lived presigned PUT URL,
  // the browser PUTs the file bytes straight to R2 (phase 2), then the
  // resulting URL is recorded in the ticket_media table via the normal
  // intake API. This keeps big videos off the JSON API, which has a
  // ~4.5MB request-size ceiling.

  function ticketMediaItemHtml(item, index) {
    const inner = item.type === "video"
      ? `<video src="${esc(item.url)}" muted playsinline preload="metadata"></video><span class="ticket-media-play"><svg class="icon"><use href="#i-play"></use></svg></span>`
      : `<img src="${esc(item.url)}" alt="Device photo" loading="lazy" />`;
    return `<div class="ticket-media-item" data-media-id="${esc(item.id)}">
      <button type="button" class="ticket-media-link" data-open-media="${index}" aria-label="View ${item.type}">${inner}</button>
      <button type="button" class="ticket-media-delete" data-delete-media="${esc(item.id)}" aria-label="Delete"><svg class="icon"><use href="#i-xmark"></use></svg></button>
    </div>`;
  }

  function renderTicketMedia(items) {
    const gallery = $("ticketMediaGallery");
    if (!gallery) return;
    activeTicketMedia = Array.isArray(items) ? items : [];
    gallery.innerHTML = items.length
      ? items.map(ticketMediaItemHtml).join("")
      : `<p class="ops-empty">No photos or videos yet.</p>`;
  }

  async function loadTicketMedia(ticket) {
    const gallery = $("ticketMediaGallery");
    if (!gallery) return;
    try {
      const res = await api({ action: "listMedia", ticketId: ticket.id });
      if (!res.ok) throw new Error(res.error || "Couldn't load media");
      // The modal may have moved on to another ticket while this was in flight.
      if (!currentModalTicket || currentModalTicket.id !== ticket.id) return;
      renderTicketMedia(res.media || []);
    } catch (err) {
      gallery.innerHTML = `<p class="ops-empty">Couldn't load photos — ${esc(err.message)}</p>`;
    }
  }

  function setTicketMediaError(message) {
    const el = $("ticketMediaError");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  async function uploadTicketMedia(ticket, file) {
    const type = file.type.startsWith("video/") ? "video" : "photo";
    if (!MEDIA_ALLOWED_TYPES.has(file.type)) {
      throw new Error("That file type isn't supported — use a photo (JPEG/PNG/WEBP/HEIC) or video (MP4/MOV/WEBM).");
    }
    if (file.size > MEDIA_MAX_BYTES) {
      throw new Error("That file is over 50MB — trim the video or pick a smaller one.");
    }

    // Phase 1: ask the API for a presigned R2 upload URL (also re-validates
    // type/size and the PIN server-side — the client checks above are just
    // for a fast, friendly error before spending the round trip).
    const presignRes = await fetch(MEDIA_UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: getCfg().pin,
        ticketId: ticket.id,
        filename: file.name,
        contentType: file.type,
        size: file.size,
      }),
    });
    const presign = await presignRes.json().catch(() => ({}));
    if (!presignRes.ok || !presign.ok) {
      throw new Error(presign.error || "Couldn't prepare upload");
    }

    // Phase 2: PUT the file bytes straight to R2 using that URL.
    const putRes = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!putRes.ok) {
      throw new Error("Upload to storage failed — try again");
    }

    const res = await api({ action: "addMedia", ticketId: ticket.id, url: presign.url, type, key: presign.key });
    if (!res.ok) throw new Error(res.error || "Upload saved to storage but not recorded — try again");
    return res.media;
  }

  function bindTicketMediaControls(ticket) {
    const input = $("ticketMediaInput");
    const addBtn = $("ticketMediaAddBtn");
    const gallery = $("ticketMediaGallery");
    if (!input || !gallery) return;

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      setTicketMediaError("");
      addBtn.classList.add("is-uploading");
      const label = addBtn.querySelector("span");
      const originalText = label.textContent;
      label.textContent = "Uploading…";
      try {
        await uploadTicketMedia(ticket, file);
        await loadTicketMedia(ticket);
      } catch (err) {
        setTicketMediaError(err.message);
      } finally {
        addBtn.classList.remove("is-uploading");
        label.textContent = originalText;
      }
    });

    gallery.addEventListener("click", async (e) => {
      const openBtn = e.target.closest("[data-open-media]");
      if (openBtn) {
        openMediaViewer(activeTicketMedia, Number(openBtn.dataset.openMedia));
        return;
      }
      const btn = e.target.closest("[data-delete-media]");
      if (!btn) return;
      e.preventDefault();
      if (!window.confirm("Delete this photo/video?")) return;
      btn.disabled = true;
      try {
        const res = await api({ action: "deleteMedia", id: btn.dataset.deleteMedia });
        if (!res.ok) throw new Error(res.error || "Delete failed");
        await loadTicketMedia(ticket);
      } catch (err) {
        btn.disabled = false;
        setTicketMediaError(err.message);
      }
    });
  }

  // ---- Pending media in the Log Device wizard --------------------------------
  // Photos/videos picked during the form are queued locally (the ticket
  // doesn't exist yet) and uploaded right after the save succeeds.
  let pendingFormMedia = []; // [{ file, url, type }]

  function resetPendingFormMedia() {
    pendingFormMedia.forEach((item) => URL.revokeObjectURL(item.url));
    pendingFormMedia = [];
    renderPendingFormMedia();
    const err = $("fMediaError");
    if (err) { err.hidden = true; err.textContent = ""; }
  }

  function renderPendingFormMedia() {
    const strip = $("fMediaPending");
    if (!strip) return;
    strip.hidden = !pendingFormMedia.length;
    strip.innerHTML = pendingFormMedia.map((item, i) => `
      <div class="ticket-media-item">
        <button type="button" class="ticket-media-link" data-pending-open="${i}" aria-label="Preview ${item.type}">
        ${item.type === "video"
          ? `<video src="${item.url}" muted playsinline preload="metadata"></video><span class="ticket-media-play"><svg class="icon"><use href="#i-play"></use></svg></span>`
          : `<img src="${item.url}" alt="Pending photo" />`}
        </button>
        <button type="button" class="ticket-media-delete" data-pending-remove="${i}" aria-label="Remove"><svg class="icon"><use href="#i-xmark"></use></svg></button>
      </div>`).join("");
  }

  $("fMediaInput")?.addEventListener("change", () => {
    const input = $("fMediaInput");
    const err = $("fMediaError");
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (err) { err.hidden = true; err.textContent = ""; }
    if (file.size > MEDIA_MAX_BYTES) {
      if (err) { err.textContent = "That file is over 50MB — trim the video or pick a smaller one."; err.hidden = false; }
      return;
    }
    pendingFormMedia.push({
      file,
      url: URL.createObjectURL(file),
      type: file.type.startsWith("video/") ? "video" : "photo",
    });
    renderPendingFormMedia();
  });

  $("fMediaPending")?.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-pending-open]");
    if (openBtn) {
      openMediaViewer(pendingFormMedia, Number(openBtn.dataset.pendingOpen));
      return;
    }
    const btn = e.target.closest("[data-pending-remove]");
    if (!btn) return;
    const removed = pendingFormMedia.splice(Number(btn.dataset.pendingRemove), 1)[0];
    if (removed) URL.revokeObjectURL(removed.url);
    renderPendingFormMedia();
  });

  // Uploads a queued batch of files once its ticket exists. Failures never
  // undo the saved check-in. When narrate is on (the common single-device
  // save), progress is written into the success screen; otherwise — several
  // devices uploading in the background at once — failures surface as a toast
  // instead, so concurrent uploads don't stomp on the same message.
  async function uploadMediaQueueForTicket(ticket, queue, { narrate = false } = {}) {
    if (!queue || !queue.length || !ticket?.id) return;
    const msg = $("formSuccessMessage");
    const baseText = narrate ? msg.textContent : "";
    let failed = 0;
    for (let i = 0; i < queue.length; i++) {
      if (narrate) msg.textContent = `${baseText} Uploading ${queue[i].type} ${i + 1} of ${queue.length}…`;
      try {
        await uploadTicketMedia(ticket, queue[i].file);
      } catch (_) {
        failed++;
      }
      URL.revokeObjectURL(queue[i].url);
    }
    if (narrate) {
      msg.textContent = failed
        ? `${baseText} ${queue.length - failed} of ${queue.length} files uploaded — ${failed} failed. You can retry from the ticket's Photos & videos section.`
        : `${baseText} ${queue.length} ${queue.length === 1 ? "file" : "files"} uploaded.`;
    } else if (failed) {
      toast(`${failed} of ${queue.length} file(s) for ${ticket.device || "a device"} failed to upload — retry from the ticket's Photos & videos section.`);
    }
  }

  async function sendInvoiceForTicket(ticket, delivery) {
    if (!ticket?.id) return "";
    try {
      const res = await fetch(INVOICE_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          pin: getCfg().pin,
          delivery,
          ticketId: ticket.id,
          customerName: ticket.customerName,
          phone: ticket.phone,
          email: ticket.email,
          device: ticket.device,
          issues: ticket.issues,
          status: ticket.status,
          notes: ticket.notes,
          repairCost: ticket.repairCost,
          amountPaid: ticket.amountPaid,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Invoice failed");
      if (delivery === "whatsapp") {
        if (data.whatsappUrl) window.open(data.whatsappUrl, "_blank", "noopener");
        return data.invoiceNumber
          ? `Invoice ${data.invoiceNumber} was created; WhatsApp is ready to send.`
          : "Invoice was created; WhatsApp is ready to send.";
      }
      if (data.emailSent) {
        return data.invoiceNumber
          ? `Invoice ${data.invoiceNumber} was emailed to the client.`
          : "The invoice was emailed to the client.";
      }
      return data.invoiceNumber
        ? `Invoice ${data.invoiceNumber} was created, but the email did not send. Open the invoice link and send it manually.`
        : "The invoice was created, but the email did not send. Open the invoice link and send it manually.";
    } catch (err) {
      return "The invoice could not be sent: " + err.message;
    }
  }

  function formatMoney(value) {
    if (value == null || value === "") return "—";
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";
    return "TT$" + amount.toLocaleString("en-TT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function balanceDue(repairCost, amountPaid) {
    if (repairCost == null || repairCost === "") return null;
    const cost = Number(repairCost);
    const paid = amountPaid == null || amountPaid === "" ? 0 : Number(amountPaid);
    return Number.isFinite(cost) && Number.isFinite(paid) ? cost - paid : null;
  }

  // ---- WhatsApp client notifications ----------------------------------------
  // Turns a locally-written phone number into the full international format
  // wa.me requires. Numbers here are Trinidad & Tobago (+1 868): staff type
  // them as 7 digits ("345-3937"), 10 digits ("8686820138"), or full 11.
  function whatsAppNumber(phone) {
    const digits = String(phone || "").replace(/\D+/g, "");
    if (digits.length === 7) return "1868" + digits;
    if (digits.length === 10 && digits.startsWith("868")) return "1" + digits;
    if (digits.length === 11 && digits.startsWith("1868")) return digits;
    // Anything longer probably already includes a country code.
    if (digits.length >= 11) return digits;
    return "";
  }

  // Prefilled status message — the everyday "your device is ready" text that
  // staff otherwise had to phone in (it's literally the dashboard's default
  // action card). Special-cases Repaired with the balance due.
  function whatsAppNotifyUrl(ticket) {
    const number = whatsAppNumber(ticket.phone);
    if (!number) return "";
    const firstName = (ticket.customerName || "").trim().split(/\s+/)[0] || "there";
    let text;
    if (ticket.status === "Repaired") {
      text = `Hi ${firstName}, great news! your device has been repaired and is ready for pick up.`;
    } else {
      const device = ticket.device || "your device";
      text = `Hi ${firstName}, an update from JQ Electronics on your ${device}: it is now marked "${ticket.status || "in progress"}". We'll keep you posted.`;
    }
    return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  }

  function balanceTone(repairCost, amountPaid) {
    const balance = balanceDue(repairCost, amountPaid);
    if (balance == null) return "";
    return balance > 0 ? "money-due" : "money-positive";
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

  function setQuickLogMode(on) {
    quickLogMode = on;
    $("intakeFormModal").classList.toggle("quick-log", on);
    $("repairCostField").hidden = on;
    $("quotedPriceSummary").hidden = !on;
  }

  // ---- Multiple devices for one client --------------------------------------
  // "Add another device" snapshots the device/issue/status/inventory/notes/media
  // currently on Step 2 into formDevices, then clears those fields so staff can
  // enter the next device. Each entry becomes its own ticket on save, sharing
  // the customer details entered once on Step 1.
  function clearFormDevices() {
    formDevices.forEach((d) => (d.media || []).forEach((m) => URL.revokeObjectURL(m.url)));
    formDevices = [];
    renderAddedDevices();
  }

  function renderAddedDevices() {
    const wrap = $("addedDevicesWrap");
    const list = $("addedDevicesList");
    if (!wrap || !list) return;
    wrap.hidden = !formDevices.length;
    updateExtraDeviceControls();
    list.innerHTML = formDevices.map((d, i) => `
      <div class="added-device-item">
        <div class="added-device-main">
          <div class="added-device-name">${esc(d.device || "Device")}</div>
          <div class="added-device-issues">${esc(issueSummaryText(d.issues) || "No issues selected")}</div>
        </div>
        <button type="button" class="icon-btn ghost-btn added-device-remove" data-remove-device="${i}" aria-label="Remove ${esc(d.device || "device")}">
          <svg class="icon"><use href="#i-xmark"></use></svg>
        </button>
      </div>
    `).join("");
  }

  $("addedDevicesList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-device]");
    if (!btn) return;
    const idx = Number(btn.dataset.removeDevice);
    const removed = formDevices.splice(idx, 1)[0];
    if (removed) (removed.media || []).forEach((m) => URL.revokeObjectURL(m.url));
    renderAddedDevices();
  });

  $("addAnotherDevice")?.addEventListener("click", () => {
    const err = $("formError");
    err.hidden = true;
    if (!$("fDevice").value.trim()) {
      err.textContent = "Enter the device model.";
      err.hidden = false;
      return;
    }
    const issuesStr = buildIssuesString();
    if (!issuesStr) {
      err.textContent = "Select at least one issue.";
      err.hidden = false;
      return;
    }
    const inventoryOption = $("fInventoryItem").selectedOptions[0];
    formDevices.push({
      device: $("fDevice").value.trim(),
      issues: issuesStr,
      status: $("fStatus").value,
      inventoryItemKey: $("fInventoryItem").value,
      inventoryItemLabel: $("fInventoryItem").value && inventoryOption ? inventoryOption.textContent : "",
      repairDueDate: $("fRepairDueDate").value,
      notes: $("fNotes").value.trim(),
      media: pendingFormMedia.slice(),
      repairCost: "",
      amountPaid: "",
    });
    renderAddedDevices();
    // Clear the current entry (but don't revoke its media — ownership just
    // moved to the device entry above) so staff can fill in the next device.
    $("fDevice").value = "";
    $("fStatus").value = "Received";
    $("fRepairDueDate").value = "";
    $("fNotes").value = "";
    setIssueTags("");
    pendingFormMedia = [];
    renderPendingFormMedia();
    updateInventoryOptions("");
    toast("Device added — enter the next one.", { tone: "info", duration: 2500 });
    focusUnlessTouch($("fDevice"));
  });

  // True when the on-screen device entry has neither a model nor an issue —
  // i.e. nothing that could be saved as a device. Adding a second device is
  // optional: once one is confirmed, leaving this blank and pressing
  // Continue just proceeds with what's already been added instead of
  // demanding a second device be filled in.
  function pendingDeviceIsBlank() {
    return !$("fDevice").value.trim() && !buildIssuesString();
  }

  // Anything typed into the on-screen (in-progress) device entry. Used to
  // decide whether cancelling that entry needs a confirmation first.
  function currentDeviceEntryTouched() {
    return Boolean(
      $("fDevice").value.trim() ||
      buildIssuesString() ||
      $("fNotes").value.trim() ||
      $("fInventoryItem").value ||
      $("fRepairCost").value.trim() ||
      $("fAmountPaid").value.trim() ||
      pendingFormMedia.length ||
      $("fStatus").value !== "Received"
      || $("fRepairDueDate").value
    );
  }

  // The escape hatch out of "Add another device": while an extra device is
  // being entered, staff can drop it and fall back to the device they last
  // confirmed — the client details and the other devices are untouched.
  function updateExtraDeviceControls() {
    const btn = $("cancelExtraDevice");
    const hint = $("cancelExtraDeviceHint");
    if (!btn || !hint) return;
    const previous = formDevices[formDevices.length - 1];
    btn.hidden = !previous;
    hint.hidden = !previous;
    if (previous) {
      hint.textContent = `Changed your mind? This clears what's on screen and brings back ${previous.device || "the last device"} — the client details and any other devices stay.`;
    }
  }

  $("cancelExtraDevice")?.addEventListener("click", () => {
    if (!formDevices.length) return;
    if (
      currentDeviceEntryTouched() &&
      !window.confirm("Cancel this extra device? What's on screen is dropped — the client details and the devices already added are kept.")
    ) return;
    const previous = formDevices.pop();
    // The in-progress entry is going away, so its queued media goes with it.
    resetPendingFormMedia();
    $("fDevice").value = previous.device || "";
    $("fStatus").value = previous.status || "Received";
    $("fRepairDueDate").value = previous.repairDueDate || "";
    $("fNotes").value = previous.notes || "";
    $("fRepairCost").value = previous.repairCost || "";
    $("fAmountPaid").value = previous.amountPaid || "";
    setIssueTags(previous.issues || "");
    // Ownership of the restored entry's media moves back to the live form.
    pendingFormMedia = previous.media || [];
    renderPendingFormMedia();
    updateInventoryOptions(previous.inventoryItemKey || "");
    $("formError").hidden = true;
    renderAddedDevices();
    toast(`Back to ${previous.device || "the previous device"}.`, { tone: "info", duration: 2500 });
    focusUnlessTouch($("fDevice"));
  });

  function paymentDeviceLabelHtml(device, issuesStr) {
    const issueSummary = issueSummaryText(issuesStr);
    return `${esc(device || "Device")}${issueSummary ? `<span>${esc(issueSummary)}</span>` : ""}`;
  }

  // Rebuilds the Payment step's per-device cards from formDevices. The last
  // (current) device keeps the original fRepairCost/fAmountPaid fields —
  // unless it was left blank (no second device wanted), in which case that
  // card is hidden entirely and only the already-added device(s) show.
  function renderPaymentCards() {
    const container = $("paymentDeviceCards");
    const currentCard = $("currentPaymentCard");
    const currentLabel = $("currentPaymentLabel");
    if (!container || !currentCard || !currentLabel) return;
    const pendingBlank = formDevices.length > 0 && pendingDeviceIsBlank();
    container.innerHTML = formDevices.map((d, i) => `
      <div class="payment-device-card">
        <p class="payment-device-label">${paymentDeviceLabelHtml(d.device, d.issues)}</p>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label" for="devRepairCost_${i}">Repair cost (TTD)</label>
            <input id="devRepairCost_${i}" class="text-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="e.g. 450.00" value="${esc(d.repairCost || "")}" />
          </div>
          <div class="form-field">
            <label class="field-label" for="devAmountPaid_${i}">Amount paid (TTD)</label>
            <input id="devAmountPaid_${i}" class="text-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="e.g. 150.00" value="${esc(d.amountPaid || "")}" />
          </div>
        </div>
      </div>
    `).join("");
    currentCard.hidden = pendingBlank;
    const multi = formDevices.length > 0 && !pendingBlank;
    currentLabel.hidden = !multi;
    if (multi) currentLabel.innerHTML = paymentDeviceLabelHtml($("fDevice").value.trim(), buildIssuesString());
  }

  // Persists whatever staff typed into the dynamic per-device payment cards
  // back onto formDevices before they're rebuilt or the step is left.
  function syncPaymentCardsToFormDevices() {
    formDevices.forEach((d, i) => {
      const rc = $("devRepairCost_" + i);
      const ap = $("devAmountPaid_" + i);
      if (rc) d.repairCost = rc.value;
      if (ap) d.amountPaid = ap.value;
    });
  }

  function openForm(ticket) {
    editingId = ticket ? ticket.id : null;
    setQuickLogMode(false);
    maxStepReached = 1;
    clearFormDevices();
    // Editing an existing ticket is always a single device — multi-device
    // logging only applies when checking in a fresh client.
    $("addAnotherDeviceWrap").hidden = Boolean(ticket);
    $("intakeFormTitle").textContent = ticket ? "Edit device" : "Log device";
    $("fName").value = ticket ? ticket.customerName || "" : "";
    $("fPhone").value = ticket ? ticket.phone || "" : "";
    $("fEmail").value = ticket ? ticket.email || "" : "";
    $("fDevice").value = ticket ? ticket.device || "" : "";
    $("fStatus").value = ticket ? ticket.status || "Received" : "Received";
    $("fRepairDueDate").value = ticket ? ticket.repairDueDate || "" : "";
    $("fNotes").value = ticket ? ticket.notes || "" : "";
    $("fRepairCost").value = ticket ? ticket.repairCost ?? "" : "";
    $("fAmountPaid").value = ticket ? ticket.amountPaid ?? "" : "";
    $("fSendInvoice").checked = !ticket;
    $("fInvoiceDelivery").value = "email";
    $("fInvoiceDelivery").closest(".invoice-delivery-field").hidden = Boolean(ticket);
    setIssueTags(ticket ? ticket.issues || "" : "");
    $("fInventoryItem").innerHTML = `<option value="">Loading inventory…</option>`;
    loadInventoryForForm()
      .then(() => updateInventoryOptions(ticket ? ticket.inventoryItemKey || "" : ""))
      .catch((err) => {
        $("fInventoryItem").innerHTML = `<option value="">No stock item used</option>`;
        $("inventoryHint").textContent = "Inventory couldn't load: " + err.message;
      });

    $("saveForm").textContent = ticket ? "Update device" : "Save device";
    $("formError").hidden = true;
    $("formSuccessMessage").textContent = "";
    resetPendingFormMedia();
    setFormStep(1);
    $("intakeFormModal").hidden = false;
    focusUnlessTouch($("fName"));
  }
  function closeForm() {
    $("intakeFormModal").hidden = true;
    editingId = null;
    setQuickLogMode(false);
    clearFormDevices();
    resetPendingFormMedia();
  }
  $("fDevice").addEventListener("input", () => updateInventoryOptions($("fInventoryItem").value));

  $("newIntakeBtn").addEventListener("click", () => openForm(null));
  function setFormStep(step) {
    // Leaving the payment step: capture any edits made in the per-device
    // payment cards before they're rebuilt or hidden.
    if (formStep === 3 && step !== 3) syncPaymentCardsToFormDevices();
    formStep = step;
    maxStepReached = Math.max(maxStepReached, step);
    document.querySelectorAll("[data-form-step]").forEach((panel) => {
      panel.hidden = Number(panel.dataset.formStep) !== step;
    });
    // Clickable now: every already-visited step, plus the one step ahead
    // (clicking it validates the current step first, same as Continue).
    const nextReachable = quickLogMode && step === 1 ? 3 : Math.min(step + 1, 3);
    document.querySelectorAll("[data-progress-step]").forEach((indicator) => {
      const indicatorStep = Number(indicator.dataset.progressStep);
      indicator.classList.toggle("active", indicatorStep === step);
      indicator.classList.toggle("complete", indicatorStep < step);
      indicator.disabled = step === 4 || !(indicatorStep <= maxStepReached || indicatorStep === nextReachable);
    });
    document.querySelectorAll(".form-progress-line").forEach((line, index) => {
      line.classList.toggle("complete", index < step - 1);
    });
    const isComplete = step === 4;
    $("previousFormStep").hidden = step === 1 || isComplete;
    $("nextFormStep").hidden = step >= 3;
    $("saveForm").hidden = step !== 3;
    $("cancelForm").hidden = isComplete;
    $("doneForm").hidden = !isComplete;
    $("formError").hidden = true;
    if (step === 3) renderPaymentCards();
  }

  // Clicking a step number jumps straight there: backward or to any
  // already-visited step always works; moving to the next not-yet-seen
  // step still validates the current one first (same as Continue).
  function goToStep(target) {
    if (formStep === 4 || target === formStep) return;
    if (quickLogMode && target === 2) return;
    if (target < formStep || target <= maxStepReached) {
      setFormStep(target);
    } else if (target === formStep + 1 || (quickLogMode && formStep === 1 && target === 3)) {
      if (!validateFormStep(formStep)) return;
      setFormStep(target);
    } else {
      return;
    }
    const firstField = document.querySelector(`[data-form-step="${formStep}"] input, [data-form-step="${formStep}"] select, [data-form-step="${formStep}"] button`);
    if (firstField) firstField.focus();
  }
  document.querySelectorAll("[data-progress-step]").forEach((btn) => {
    btn.addEventListener("click", () => goToStep(Number(btn.dataset.progressStep)));
  });

  function customerFieldsError() {
    const name = $("fName").value.trim();
    const phone = $("fPhone").value.trim();
    const email = $("fEmail").value.trim();
    if (!name || !phone || !email) return "Enter the client's name, phone, and email.";
    if (!$("fEmail").checkValidity()) return "Enter a valid email address for the invoice.";
    return null;
  }

  function validateFormStep(step) {
    const err = $("formError");
    if (step === 1) {
      const message = customerFieldsError();
      if (message) err.textContent = message;
      else return true;
    } else if (step === 2 && formDevices.length && pendingDeviceIsBlank()) {
      // A second device is optional — nothing typed for it and at least one
      // device is already added, so there's nothing left to validate here.
      return true;
    } else if (step === 2 && !$("fDevice").value.trim()) {
      err.textContent = "Enter the device model.";
    } else if (step === 2 && !buildIssuesString()) {
      err.textContent = "Select at least one issue.";
    } else if (step === 3 && (!$("fRepairCost").checkValidity() || !$("fAmountPaid").checkValidity())) {
      err.textContent = "Enter valid non-negative payment amounts.";
    } else {
      return true;
    }
    err.hidden = false;
    return false;
  }

  $("nextFormStep").addEventListener("click", () => {
    if (!validateFormStep(formStep)) return;
    setFormStep(quickLogMode && formStep === 1 ? 3 : formStep + 1);
    const firstField = document.querySelector(`[data-form-step="${formStep}"] input, [data-form-step="${formStep}"] select, [data-form-step="${formStep}"] button`);
    if (firstField) firstField.focus();
  });
  $("previousFormStep").addEventListener("click", () => setFormStep(quickLogMode && formStep === 3 ? 1 : formStep - 1));
  $("cancelForm").addEventListener("click", closeForm);
  $("doneForm").addEventListener("click", closeForm);
  $("fSendInvoice").addEventListener("change", () => {
    const field = $("fInvoiceDelivery").closest(".invoice-delivery-field");
    if (field) field.hidden = !$("fSendInvoice").checked;
  });
  $("closeIntakeFormModal").addEventListener("click", closeForm);

  // A quick-log form is opened over the Prices view. On phone-sized screens,
  // a deliberate left swipe is another way to dismiss it and return to the
  // price list without changing tabs.
  let formSwipeStart = null;
  $("intakeFormModal").addEventListener("touchstart", (e) => {
    if (!window.matchMedia("(max-width: 559px)").matches) return;
    const touch = e.changedTouches[0];
    formSwipeStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  $("intakeFormModal").addEventListener("touchend", (e) => {
    if (!formSwipeStart || !window.matchMedia("(max-width: 559px)").matches) return;
    const touch = e.changedTouches[0];
    const horizontalDistance = touch.clientX - formSwipeStart.x;
    const verticalDistance = touch.clientY - formSwipeStart.y;
    formSwipeStart = null;
    if (horizontalDistance <= -72 && Math.abs(horizontalDistance) > Math.abs(verticalDistance) * 1.25) {
      closeForm();
    }
  }, { passive: true });
  $("intakeFormModal").addEventListener("touchcancel", () => { formSwipeStart = null; }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("intakeFormModal").hidden) closeForm();
  });

  // ---- Log device straight from a price row ---------------------------------
  // assets/app.js dispatches this when staff click/tap a repair price on the
  // Prices tab, so they don't have to re-type the model or hunt for the
  // matching issue tag — just confirm the customer and save.
  const REPAIR_TYPE_TO_ISSUE = [
    [/screen|lcd|display/i, "Screen Cracked / Broken"],
    [/battery/i, "Battery Issue"],
    [/charg/i, "Charging Port"],
    [/power/i, "Won't Power On"],
    [/water/i, "Water Damage"],
    [/camera/i, "Camera Issue"],
    [/speaker|mic/i, "Speaker / Mic Issue"],
    [/back glass|housing/i, "Back Glass Cracked"],
    [/software|restore|unlock/i, "Software Issue"],
    [/diagnos/i, "Diagnostic Needed"],
  ];
  function guessIssueFromRepairType(type) {
    const hit = REPAIR_TYPE_TO_ISSUE.find(([re]) => re.test(type || ""));
    return hit ? hit[1] : null;
  }

  // Prefills and opens the Log device wizard for a repair picked on the
  // Prices tab: device, matched issue, and the quoted repair cost are all
  // filled in, so staff only enter the client's name, phone, email, and how much
  // they actually paid.
  function applyLogDevicePrefill(detail) {
    const { device, repairType, price, priceValue } = detail || {};
    openForm(null);
    $("fDevice").value = device || "";
    setIssueTags(guessIssueFromRepairType(repairType) || (repairType ? "Other: " + repairType : ""));
    if (priceValue != null) $("fRepairCost").value = priceValue;
    loadInventoryForForm().then(() => updateInventoryOptions("")).catch(() => {});
    setQuickLogMode(true);
    $("quotedPriceSummary").textContent = `Quoted ${price || (priceValue != null ? "$" + priceValue : "—")} — ${repairType || device || ""}`;
    focusUnlessTouch($("fName"));
  }

  window.addEventListener("rpc-log-device", (e) => {
    const detail = e.detail || {};
    if (!isConfigured()) {
      pendingLogDevice = detail;
      toast("Set up the Check In PIN from the Repairs tab before logging a device.");
      return;
    }
    applyLogDevicePrefill(detail);
  });

  // ---- Customer info modal --------------------------------------------------
  // Quick-edits a ticket's customer details straight from its card.
  let clientModalTicket = null;

  function openClientModalForTicket(ticket) {
    clientModalTicket = ticket;
    $("clientModalTitle").textContent = "Update customer";
    $("cName").value = ticket.customerName || "";
    $("cPhone").value = ticket.phone || "";
    $("cEmail").value = ticket.email || "";
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("clientModal").hidden) closeClientModal();
  });

  $("saveClientModal").addEventListener("click", async () => {
    const err = $("clientModalError");
    err.hidden = true;
    const name = $("cName").value.trim();
    const phone = $("cPhone").value.trim();
    const email = $("cEmail").value.trim();
    if (!name || !phone || !email) {
      err.textContent = "Enter the customer's name, phone, and email.";
      err.hidden = false;
      return;
    }
    if (!$("cEmail").checkValidity()) {
      err.textContent = "Enter a valid email address for the invoice.";
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
        email,
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

  // ---- Technician assignment -----------------------------------------------
  // Assignment is intentionally post-check-in only: the Log device wizard never
  // shows this field. Staff assign or reassign from a saved ticket card/detail.
  function openTechnicianModalForTicket(ticket) {
    technicianModalTicket = ticket;
    $("technicianModalTitle").textContent = ticket.technician ? "Reassign technician" : "Assign technician";
    $("technicianModalSub").textContent = `${ticket.customerName || "Customer"} · ${ticket.device || "Device"} · #${ticket.id || ""}`;
    $("fTechnician").value = ticket.technician || "";
    $("fTechnician").setAttribute("aria-expanded", "false");
    $("technicianModalError").hidden = true;
    $("technicianModal").hidden = false;
    $("fTechnician").focus();
    openTechnicianDropdown({ showAll: true });
  }

  function closeTechnicianModal() {
    $("technicianModal").hidden = true;
    closeTechnicianDropdown();
    technicianModalTicket = null;
  }

  function technicianDropdownOptions(showAll = false) {
    const query = showAll ? "" : $("fTechnician").value.trim().toLowerCase();
    const names = technicianNamesWithLegacy(technicianModalTicket);
    return query ? names.filter((name) => name.toLowerCase().includes(query)) : names;
  }

  function renderTechnicianDropdown({ showAll = false } = {}) {
    const box = $("technicianDropdown");
    const input = $("fTechnician");
    const query = showAll ? "" : input.value.trim();
    const options = technicianDropdownOptions(showAll);
    const exact = findCanonicalTechnicianName(query);
    const rows = [
      `<button type="button" class="technician-option ${query ? "" : "active"}" role="option" data-tech="">Unassigned</button>`,
      ...options.map((name) =>
        `<button type="button" class="technician-option ${name === exact ? "active" : ""}" role="option" data-tech="${esc(name)}">${esc(name)}</button>`
      ),
    ];
    if (query && !exact) {
      rows.push(`<button type="button" class="technician-option add-option" role="option" data-add="${esc(query)}"><svg class="icon"><use href="#i-plus"></use></svg>Add technician “${esc(query)}”</button>`);
    }
    box.innerHTML = rows.join("");
    box.querySelectorAll("[data-tech]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => chooseTechnicianOption(btn.dataset.tech || ""));
    });
    box.querySelectorAll("[data-add]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => addTechnicianFromDropdown(btn.dataset.add || query));
    });
  }

  function openTechnicianDropdown({ showAll = false } = {}) {
    renderTechnicianDropdown({ showAll });
    $("technicianDropdown").hidden = false;
    $("fTechnician").setAttribute("aria-expanded", "true");
    $("technicianCombobox").classList.add("open");
  }

  function closeTechnicianDropdown() {
    $("technicianDropdown").hidden = true;
    $("fTechnician").setAttribute("aria-expanded", "false");
    $("technicianCombobox").classList.remove("open");
  }

  function chooseTechnicianOption(name) {
    $("fTechnician").value = name;
    closeTechnicianDropdown();
    suppressTechnicianFocusOpen = true;
    $("fTechnician").focus();
    setTimeout(() => { suppressTechnicianFocusOpen = false; }, 0);
  }

  async function addTechnicianFromDropdown(name) {
    const err = $("technicianModalError");
    err.hidden = true;
    try {
      const created = await createTechnician(name);
      $("fTechnician").value = created;
      closeTechnicianDropdown();
      $("fTechnician").focus();
    } catch (e) {
      err.textContent = "Couldn't add technician: " + e.message;
      err.hidden = false;
    }
  }

  async function saveTechnicianAssignment(value) {
    const ticket = technicianModalTicket;
    if (!ticket) return;
    const err = $("technicianModalError");
    err.hidden = true;
    let technician = String(value || "").trim().replace(/\s+/g, " ");
    const btn = $("saveTechnician");
    const clearBtn = $("clearTechnician");
    const original = btn.textContent;
    btn.disabled = true;
    clearBtn.disabled = true;
    btn.textContent = "Saving…";
    try {
      if (technician && !findCanonicalTechnicianName(technician, ticket)) {
        technician = await createTechnician(technician);
      } else if (technician) {
        technician = findCanonicalTechnicianName(technician, ticket);
      }
      const res = await api({
        action: "update",
        id: ticket.id,
        technician,
      });
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      renderStatusChips();
      render();
      closeTechnicianModal();
    } catch (e) {
      err.textContent = "Couldn't save assignment: " + e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      clearBtn.disabled = false;
      btn.textContent = original;
    }
  }

  $("closeTechnicianModal").addEventListener("click", closeTechnicianModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("technicianModal").hidden) closeTechnicianModal();
  });
  document.addEventListener("click", (e) => {
    if ($("technicianModal").hidden || $("technicianCombobox").contains(e.target)) return;
    closeTechnicianDropdown();
  });
  $("fTechnician").addEventListener("focus", () => {
    if (suppressTechnicianFocusOpen) return;
    openTechnicianDropdown({ showAll: true });
  });
  $("fTechnician").addEventListener("click", () => openTechnicianDropdown({ showAll: true }));
  $("fTechnician").addEventListener("input", () => openTechnicianDropdown());
  $("fTechnician").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openTechnicianDropdown({ showAll: true });
      const first = $("technicianDropdown").querySelector(".technician-option");
      if (first) first.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const value = $("fTechnician").value.trim();
      const exact = findCanonicalTechnicianName(value);
      if (exact || !value) chooseTechnicianOption(exact);
      else addTechnicianFromDropdown(value);
    } else if (e.key === "Escape") {
      closeTechnicianDropdown();
    }
  });
  $("technicianDropdown").addEventListener("keydown", (e) => {
    const options = [...$("technicianDropdown").querySelectorAll(".technician-option")];
    const i = options.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (options[i + 1] || options[0])?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (options[i - 1] || options[options.length - 1])?.focus();
    } else if (e.key === "Escape") {
      closeTechnicianDropdown();
      $("fTechnician").focus();
    }
  });
  $("openTechnicianDropdown").addEventListener("click", () => {
    if ($("technicianDropdown").hidden) openTechnicianDropdown({ showAll: true });
    else closeTechnicianDropdown();
    $("fTechnician").focus();
  });
  $("saveTechnician").addEventListener("click", () => saveTechnicianAssignment($("fTechnician").value));
  $("clearTechnician").addEventListener("click", () => saveTechnicianAssignment(""));

  $("intakeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("formError");
    err.hidden = true;
    const customerError = customerFieldsError();
    if (customerError) {
      err.textContent = customerError;
      err.hidden = false;
      return;
    }
    const currentDeviceValue = $("fDevice").value.trim();
    const currentIssuesStr = buildIssuesString();
    // A second device is optional: once one's already been added, leaving
    // the fields for the next one untouched isn't an error — it just won't
    // be saved as a device below.
    const pendingDeviceBlank = !editingId && formDevices.length > 0 && !currentDeviceValue && !currentIssuesStr;
    if (!pendingDeviceBlank) {
      if (!currentDeviceValue) {
        err.textContent = "Enter the device model.";
        err.hidden = false;
        return;
      }
      if (!currentIssuesStr) {
        err.textContent = "Select at least one issue.";
        err.hidden = false;
        return;
      }
    }
    const customerName = $("fName").value.trim();
    const phone = $("fPhone").value.trim();
    const email = $("fEmail").value.trim();
    const shouldSendInvoice = $("fSendInvoice").checked && !editingId;
    const invoiceDelivery = $("fInvoiceDelivery").value === "whatsapp" ? "whatsapp" : "email";
    const saveBtn = $("saveForm");
    const original = saveBtn.textContent;

    // Editing an existing ticket is always a single device — keep that path
    // exactly as it was.
    if (editingId) {
      const payload = {
        action: "update",
        id: editingId,
        customerName,
        client: customerName,
        phone,
        email,
        device: currentDeviceValue,
        issues: currentIssuesStr,
        issue: currentIssuesStr,
        status: $("fStatus").value,
        repairDueDate: $("fRepairDueDate").value,
        notes: $("fNotes").value.trim(),
        repairCost: $("fRepairCost").value.trim(),
        amountPaid: $("fAmountPaid").value.trim(),
        inventoryItemKey: $("fInventoryItem").value,
      };
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const res = await api(payload);
        if (!res.ok) throw new Error(res.error || "Rejected");
        mergeTicket(res.ticket);
        refreshInventoryAfterStockChange();
        renderStatusChips();
        render();
        $("intakeFormTitle").textContent = "Device updated";
        $("formSuccessTitle").textContent = "Device successfully updated";
        $("formSuccessMessage").textContent = "The device check-in has been saved.";
        setFormStep(4);
        $("doneForm").focus();
        uploadMediaQueueForTicket(res.ticket, pendingFormMedia.slice(), { narrate: true });
        pendingFormMedia = [];
      } catch (ex) {
        err.textContent = "Couldn't save: " + ex.message;
        err.hidden = false;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = original;
      }
      return;
    }

    // New check-in: one ticket per device, all sharing this client's details.
    // formDevices holds everything confirmed via "Add another device"; the
    // fields still on screen are always the last (or only) device.
    const devices = formDevices.map((d, i) => ({
      device: d.device,
      issues: d.issues,
      status: d.status,
      inventoryItemKey: d.inventoryItemKey,
      repairDueDate: d.repairDueDate || "",
      notes: d.notes,
      media: d.media || [],
      repairCost: ($("devRepairCost_" + i)?.value ?? d.repairCost ?? "").toString().trim(),
      amountPaid: ($("devAmountPaid_" + i)?.value ?? d.amountPaid ?? "").toString().trim(),
    }));
    if (!pendingDeviceBlank) {
      devices.push({
        device: currentDeviceValue,
        issues: currentIssuesStr,
        status: $("fStatus").value,
        repairDueDate: $("fRepairDueDate").value,
        inventoryItemKey: $("fInventoryItem").value,
        notes: $("fNotes").value.trim(),
        media: pendingFormMedia.slice(),
        repairCost: $("fRepairCost").value.trim(),
        amountPaid: $("fAmountPaid").value.trim(),
      });
    } else {
      // No second device after all — release its queued media, if any.
      pendingFormMedia.forEach((m) => URL.revokeObjectURL(m.url));
    }
    formDevices = [];
    pendingFormMedia = [];

    const invoiceNote = shouldSendInvoice
      ? `Invoice requested by ${invoiceDelivery === "whatsapp" ? "WhatsApp" : "email"}.`
      : "";
    saveBtn.disabled = true;
    const savedTickets = [];
    const invoiceMessages = [];
    let failureMessage = "";
    for (let i = 0; i < devices.length; i++) {
      const dev = devices[i];
      saveBtn.textContent = devices.length > 1 ? `Saving device ${i + 1} of ${devices.length}…` : "Saving…";
      try {
        const res = await api({
          action: "add",
          customerName,
          client: customerName,
          phone,
          email,
          device: dev.device,
          issues: dev.issues,
          issue: dev.issues,
          status: dev.status,
          repairDueDate: dev.repairDueDate,
          notes: [invoiceNote, dev.notes].filter(Boolean).join("\n"),
          repairCost: dev.repairCost,
          amountPaid: dev.amountPaid,
          inventoryItemKey: dev.inventoryItemKey,
        });
        if (!res.ok) throw new Error(res.error || "Rejected");
        mergeTicket(res.ticket);
        savedTickets.push(res.ticket);
        if (shouldSendInvoice) {
          saveBtn.textContent = invoiceDelivery === "whatsapp" ? "Creating invoice…" : "Sending invoice…";
          invoiceMessages.push(await sendInvoiceForTicket(res.ticket, invoiceDelivery));
        }
      } catch (ex) {
        failureMessage = `Couldn't save ${dev.device || "a device"}: ${ex.message}`;
        break;
      }
    }

    refreshInventoryAfterStockChange();
    renderStatusChips();
    render();
    saveBtn.disabled = false;
    saveBtn.textContent = original;

    if (!savedTickets.length) {
      err.textContent = failureMessage || "Couldn't save: nothing was logged.";
      err.hidden = false;
      return;
    }

    const wasPartial = savedTickets.length < devices.length;
    $("intakeFormTitle").textContent = savedTickets.length > 1 ? "Devices logged" : "Device logged";
    $("formSuccessTitle").textContent = savedTickets.length > 1
      ? `${savedTickets.length} devices successfully logged`
      : "Device successfully logged";
    const summaryLines = [
      savedTickets.length > 1
        ? `${savedTickets.length} devices were checked in for ${customerName}.`
        : "The device check-in has been saved.",
      ...invoiceMessages,
    ];
    if (wasPartial) summaryLines.push(`${failureMessage} The remaining device(s) were not logged — add them separately.`);
    $("formSuccessMessage").textContent = summaryLines.join(" ");
    setFormStep(4);
    $("doneForm").focus();
    // Fire-and-forget: queued photos/videos upload per ticket while the
    // success screen is showing.
    savedTickets.forEach((ticket, i) => uploadMediaQueueForTicket(ticket, devices[i].media, { narrate: savedTickets.length === 1 }));
  });

  function mergeTicket(t) {
    if (!t) return;
    t = normalizeTicket(t);
    const i = TICKETS.findIndex((x) => x.id === t.id);
    if (i >= 0) TICKETS[i] = t;
    else TICKETS.unshift(t);
    publishTickets();
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
        email: ticket.email,
        device: ticket.device,
        issues: ticket.issues,
        issue: ticket.issues,
        notes: ticket.notes,
        repairCost: ticket.repairCost,
        amountPaid: ticket.amountPaid,
      });
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      renderStatusChips();
      render();
      return normalizeTicket(res.ticket);
    } catch (e) {
      toast("Couldn't update status: " + e.message);
      return null;
    }
  }

  // Lets staff jump a ticket straight to a new status (e.g. Collected ->
  // Repaired) from the card or detail sheet, without opening the full
  // edit form.
  function openStatusModalForTicket(ticket) {
    statusModalTicket = ticket;
    $("statusModalSub").textContent = `${ticket.customerName || "Customer"} · ${ticket.device || "Device"} · #${ticket.id || ""}`;
    renderStatusModalOptions();
    $("statusModalError").hidden = true;
    $("statusModal").hidden = false;
  }

  function closeStatusModal() {
    $("statusModal").hidden = true;
    statusModalTicket = null;
  }

  function renderStatusModalOptions() {
    const ticket = statusModalTicket;
    if (!ticket) return;
    const box = $("statusModalOptions");
    box.innerHTML = STATUSES.map((s) =>
      `<button type="button" class="status-set ${STATUS_CLASS[s]} ${s === ticket.status ? "current" : ""}" data-status="${esc(s)}">${esc(s)}</button>`
    ).join("");
    box.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", () => chooseStatusOption(btn.dataset.status));
    });
  }

  async function chooseStatusOption(status) {
    const ticket = statusModalTicket;
    if (!ticket || status === ticket.status) {
      closeStatusModal();
      return;
    }
    const box = $("statusModalOptions");
    box.querySelectorAll("[data-status]").forEach((btn) => { btn.disabled = true; });
    const updated = await setStatus(ticket, status);
    if (!updated) {
      box.querySelectorAll("[data-status]").forEach((btn) => { btn.disabled = false; });
      return;
    }
    // Marking a device Repaired is the moment the client needs to hear from
    // the shop — offer the prefilled WhatsApp message right here instead of
    // making staff remember to call (see the dashboard's default action list).
    const notifyUrl = status === "Repaired" ? whatsAppNotifyUrl(updated) : "";
    if (notifyUrl) {
      box.innerHTML = `
        <p class="status-notify-copy">Marked repaired. Let ${esc(updated.customerName || "the client")} know it's ready for pickup?</p>
        <a class="primary-btn" href="${esc(notifyUrl)}" target="_blank" rel="noopener" id="statusNotifyWhatsApp"><svg class="icon"><use href="#i-chat"></use></svg>Notify on WhatsApp</a>
        <button type="button" class="ghost-btn" id="statusNotifySkip">Skip</button>`;
      $("statusNotifyWhatsApp").addEventListener("click", () => closeStatusModal());
      $("statusNotifySkip").addEventListener("click", () => closeStatusModal());
    } else {
      closeStatusModal();
    }
  }

  $("closeStatusModal")?.addEventListener("click", closeStatusModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("statusModal")?.hidden) closeStatusModal();
  });

  async function deleteTicket(ticket) {
    const label = ticket.customerName || ticket.device || "this record";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      const res = await api({ action: "delete", id: ticket.id });
      if (!res.ok) throw new Error(res.error || "Rejected");
      TICKETS = TICKETS.filter((t) => t.id !== ticket.id);
      refreshInventoryAfterStockChange();
      renderStatusChips();
      render();
      publishTickets();
      return true;
    } catch (e) {
      toast("Couldn't delete record: " + e.message);
      return false;
    }
  }

  // ---- Filtering / search --------------------------------------------------
  $("intakeSearch").addEventListener("input", () => {
    visibleTicketCount = TICKET_PAGE_SIZE;
    render();
  });
  $("statusFilterSelect")?.addEventListener("change", () => {
    statusFilter = $("statusFilterSelect").value || "all";
    visibleTicketCount = TICKET_PAGE_SIZE;
    render();
  });

  $("completedSearch")?.addEventListener("input", () => {
    const clear = $("clearCompletedSearch");
    if (clear) clear.hidden = !$("completedSearch").value;
    renderCompletedTickets();
    // The appointments module owns the other half of this view's list —
    // it binds its own listener on the same input for its own filtering.
  });
  $("clearCompletedSearch")?.addEventListener("click", () => {
    $("completedSearch").value = "";
    $("clearCompletedSearch").hidden = true;
    $("completedSearch").dispatchEvent(new Event("input"));
  });

  window.addEventListener("rpc-filter-intake", (event) => {
    const detail = event.detail || {};
    const filter = detail.filter || detail.status || "all";
    if (typeof window.RPC_SHOW_VIEW === "function") window.RPC_SHOW_VIEW("intake");
    else {
      setActiveNav("intake");
      showView("intake");
      enterIntake();
    }
    setRepairsPanel("existing"); // these filters (active/ready/etc) only apply to in-progress repairs
    statusFilter = filter === "active" ? "__active" : filter === "ready" ? "Repaired" : filter;
    if ($("intakeSearch")) $("intakeSearch").value = "";
    visibleTicketCount = TICKET_PAGE_SIZE;
    if (loadedOnce) {
      renderStatusChips();
      render();
    }
  });

  window.addEventListener("rpc-enter-completed-repairs", () => {
    if (!loadedOnce && isConfigured()) loadTickets();
    else renderCompletedTickets();
  });

  function renderStatusChips() {
    const filterableStatuses = STATUSES.filter((s) => s !== "Picked Up" && s !== "No Fix");
    const counts = { all: TICKETS.filter((t) => t.status !== "Picked Up" && t.status !== "No Fix").length };
    filterableStatuses.forEach((s) => (counts[s] = TICKETS.filter((t) => t.status === s).length));
    const select = $("statusFilterSelect");
    if (!select) return;
    // Cross-status shortcut: every repair still waiting on someone to place
    // the order, whether it's on the explicit "Part to be Ordered" status or
    // an older "Waiting for Parts" ticket whose flag was never set.
    const partsToOrder = TICKETS.filter((t) => t.status !== "Picked Up" && t.status !== "No Fix" && needsPartsOrdered(t)).length;
    const options = [{ key: "all", label: `All (${counts.all})` }]
      .concat([{ key: "__parts_needed", label: `⚠ Parts to order (${partsToOrder})` }])
      .concat(filterableStatuses.map((status) => ({ key: status, label: `${status} (${counts[status]})` })));
    const current = statusFilter === "__active" ? "all" : statusFilter;
    select.innerHTML = options.map((option) =>
      `<option value="${esc(option.key)}">${esc(option.label)}</option>`
    ).join("");
    select.value = options.some((option) => option.key === current) ? current : "all";
  }

  function currentList() {
    const q = $("intakeSearch").value.trim().toLowerCase();
    const list = TICKETS.filter((t) => {
      if (t.status === "Picked Up" || t.status === "No Fix") return false; // moved to the Completed Repairs tab
      if (statusFilter === "__active") {
        if (!ACTIVE_REPAIR_STATUSES.has(t.status)) return false;
      } else if (statusFilter === "__parts_needed") {
        if (!needsPartsOrdered(t)) return false;
      } else if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return [t.device, t.issues, t.id, t.customerName, t.phone, t.email, t.technician]
        .map((x) => (x || "").toLowerCase())
        .some((x) => x.includes(q));
    });
    // Newest logged device first — TICKETS itself comes from the API sorted
    // by updated_at, which would otherwise bump a device to the top just for
    // getting a status change, not for being new.
    list.sort((a, b) => (new Date(b.created).getTime() || 0) - (new Date(a.created).getTime() || 0));
    return list;
  }

  // "Completed" shows Picked Up tickets (alongside completed appointments);
  // "No Fix Repairs" is check-in-only, since appointments have no No Fix status.
  let completedTab = "picked-up";

  $("completedTabChips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-completed-tab]");
    if (!btn) return;
    completedTab = btn.dataset.completedTab;
    $("completedTabChips").querySelectorAll("[data-completed-tab]").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    const appts = $("completedAppointmentsList");
    if (appts) appts.hidden = completedTab !== "picked-up";
    renderCompletedTickets();
  });

  function renderCompletedTickets() {
    const list = $("completedTicketsList");
    if (!list) return;
    const q = ($("completedSearch")?.value || "").trim().toLowerCase();
    const wantStatus = completedTab === "no-fix" ? "No Fix" : "Picked Up";
    const completed = TICKETS.filter((t) => t.status === wantStatus).filter((t) => {
      if (!q) return true;
      return [t.device, t.issues, t.id, t.customerName, t.phone, t.email, t.technician]
        .map((x) => (x || "").toLowerCase())
        .some((x) => x.includes(q));
    });
    const countEl = $("completedTicketsCount");
    const noun = completedTab === "no-fix" ? "no fix repair" : "completed check-in";
    if (countEl) countEl.textContent = completed.length ? `${completed.length} ${noun}${completed.length === 1 ? "" : "s"}` : "";
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const group of groupTicketsByCheckin(completed)) {
      const card = checkinCard(group);
      // The card's first .ticket-customer is the client's name — on a grouped
      // card that's the header, on a single one it's the ticket row itself.
      const customerEl = card.querySelector(".ticket-customer");
      if (customerEl) customerEl.insertAdjacentHTML("beforeend", `<span class="source-tag source-tag-checkin">Check-In</span>`);
      frag.appendChild(card);
    }
    list.appendChild(frag);
    updateCompletedEmptyState();
  }

  // Completed Repairs combines this module's check-in tickets with
  // appointments.js's completed appointments in one shared search box —
  // each module re-renders its own half, then calls this to decide whether
  // the "nothing matched" message should show across both.
  function updateCompletedEmptyState() {
    const emptyEl = $("completedRepairsEmpty");
    if (!emptyEl) return;
    const hasTickets = ($("completedTicketsList")?.children.length || 0) > 0;
    const hasAppointments = completedTab === "picked-up" && ($("completedAppointmentsList")?.children.length || 0) > 0;
    const searching = !!($("completedSearch")?.value || "").trim();
    emptyEl.textContent = searching ? "No completed repairs match your search." : "No completed repairs yet.";
    emptyEl.hidden = hasTickets || hasAppointments;
  }
  window.RPC_UPDATE_COMPLETED_EMPTY = updateCompletedEmptyState;

  function render() {
    const list = currentList();
    // Paginate by device count, but never split one client's check-in across
    // the "View more" boundary.
    const groups = groupTicketsByCheckin(list);
    const visibleGroups = [];
    let shownCount = 0;
    for (const group of groups) {
      if (shownCount >= visibleTicketCount) break;
      visibleGroups.push(group);
      shownCount += group.length;
    }
    $("intakeList").innerHTML = "";
    $("intakeEmpty").hidden = list.length > 0;
    $("intakeError").hidden = true;
    $("intakeCount").textContent = list.length
      ? `Showing ${shownCount} of ${list.length} device${list.length === 1 ? "" : "s"}`
      : "";
    const frag = document.createDocumentFragment();
    for (const group of visibleGroups) frag.appendChild(checkinCard(group));
    if (shownCount < list.length) {
      const more = document.createElement("button");
      const remaining = list.length - shownCount;
      more.className = "view-more-btn";
      more.innerHTML = `View ${Math.min(TICKET_PAGE_SIZE, remaining)} more <span aria-hidden="true">↓</span>`;
      more.onclick = () => {
        visibleTicketCount += TICKET_PAGE_SIZE;
        render();
      };
      frag.appendChild(more);
    }
    $("intakeList").appendChild(frag);
    renderCompletedTickets();
  }

  function issueTagsHtml(issuesStr) {
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return `<span class="issue-chip muted">No issues recorded</span>`;
    return parts.map((p) => `<span class="issue-chip">${esc(p)}</span>`).join("");
  }

  function issueSummaryText(issuesStr) {
    return (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  }

  // Preset issue tags (see ISSUES above) are all short labels; anything
  // longer is free text typed into "Other" — too long to sit as a chip on
  // the card, so the read-only card row hides it behind a "View notes"
  // button instead and surfaces it in the activity log modal.
  const ISSUE_CHIP_MAX_LEN = 30;

  function splitIssueParts(issuesStr) {
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    return {
      short: parts.filter((p) => p.length <= ISSUE_CHIP_MAX_LEN),
      long: parts.filter((p) => p.length > ISSUE_CHIP_MAX_LEN),
    };
  }

  // Compact chip row for a ticket card: short preset issues render as chips
  // as before; any long free-text issue collapses into a "View notes"
  // button instead of sprawling across the card.
  function ticketRepairChipsHtml(t) {
    const { short, long } = splitIssueParts(t.issues);
    const chips = short.map((p) => `<span class="issue-chip">${esc(p)}</span>`).join("");
    const notesBtn = long.length
      ? `<button type="button" class="issue-chip issue-notes-btn" data-view-notes>
          <svg class="icon"><use href="#i-note"></use></svg>View notes
        </button>`
      : "";
    if (!chips && !notesBtn) return `<span class="issue-chip muted">No issues recorded</span>`;
    return chips + notesBtn;
  }

  // Full days elapsed since an ISO timestamp (0 if missing/invalid).
  function daysSince(iso) {
    if (!iso) return 0;
    const then = new Date(iso).getTime();
    if (isNaN(then)) return 0;
    return Math.floor((Date.now() - then) / 86400000);
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function repairDueDateLabel(value) {
    if (!value) return "No due date";
    const d = new Date(value + "T12:00:00");
    if (isNaN(d)) return value;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function isActiveRepair(ticket) {
    return ACTIVE_REPAIR_STATUSES.has(ticket.status);
  }

  function isRepairDueDatePast(ticket) {
    return isActiveRepair(ticket) && !!ticket.repairDueDate && ticket.repairDueDate < todayKey();
  }

  function isRepairCheckEligible(ticket) {
    return !!ticket && REPAIR_CHECK_ALERT_STATUSES.has(ticket.status);
  }

  function repairCheckAlertReason(ticket) {
    if (!isRepairCheckEligible(ticket)) return "";
    if (isRepairDueDatePast(ticket)) return "due";
    return daysSince(ticket.created) > REPAIR_CHECK_ALERT_MIN_DAYS ? "age" : "";
  }

  function repairDuePillHtml(ticket) {
    if (!ticket.repairDueDate) return "";
    const alert = !!repairCheckAlertReason(ticket);
    return `<span class="ticket-due-pill${alert ? " is-alert" : ""}">
      <svg class="icon"><use href="#i-calendar"></use></svg>${esc(repairDueDateLabel(ticket.repairDueDate))}
    </span>`;
  }

  const PARTS_ALERT_DAYS = 3;

  function ticketPhoneLineHtml(t) {
    return t.phone
      ? `<a class="ticket-phone" href="tel:${esc(t.phone)}" aria-label="Call ${esc(t.customerName || "customer")}"><svg class="icon ticket-phone-icon"><use href="#i-phone"></use></svg>${esc(t.phone)}</a>`
      : `<span class="ticket-phone no-phone">No number on file</span>`;
  }

  // Whether this ticket is still waiting on someone to actually place the
  // order. "Part Ordered"/"Part to be Ordered" say it in the status itself;
  // the older "Waiting for Parts" carries it in the partsOrdered flag.
  function needsPartsOrdered(t) {
    if (t.status === "Part Ordered") return false;
    if (t.status === "Part to be Ordered") return true;
    return t.status === "Waiting for Parts" && !t.partsOrdered;
  }

  function showsPartsAlert(t) {
    return needsPartsOrdered(t) && daysSince(t.waitingForPartsSince) >= PARTS_ALERT_DAYS;
  }

  // One tap from "this needs a part" to "the part is on its way". On the
  // explicit statuses that means moving the status; on the older flag-based
  // "Waiting for Parts" it means setting the flag.
  function markPartsOrdered(t) {
    if (t.status === "Part to be Ordered") return setStatus(t, "Part Ordered");
    return setPartsOrdered(t, true);
  }

  function togglePartsOrdered(t) {
    if (needsPartsOrdered(t)) return markPartsOrdered(t);
    if (t.status === "Part Ordered") return setStatus(t, "Part to be Ordered");
    return setPartsOrdered(t, false);
  }

  // The red "waiting on parts" strip under a ticket's head, or null when the
  // ticket isn't overdue on parts.
  function partsAlertEl(t) {
    if (!showsPartsAlert(t)) return null;
    const waitingDays = daysSince(t.waitingForPartsSince);
    const alert = document.createElement("div");
    alert.className = "ticket-parts-alert";
    alert.innerHTML = `
      <svg class="icon"><use href="#i-alert"></use></svg>
      <span>Waiting on parts for ${waitingDays} day${waitingDays === 1 ? "" : "s"} — order parts?</span>
      <button type="button" class="ticket-parts-alert-btn">Mark ordered</button>`;
    alert.querySelector(".ticket-parts-alert-btn").onclick = (e) => {
      e.stopPropagation();
      markPartsOrdered(t);
    };
    return alert;
  }

  function repairCheckAlertEl(t) {
    const reason = repairCheckAlertReason(t);
    if (!reason) return null;
    const openDays = daysSince(t.created);
    const alert = document.createElement("div");
    alert.className = "ticket-repair-alert";
    const text = reason === "due"
      ? `Repair due date passed (${repairDueDateLabel(t.repairDueDate)}) — reminder added to check it out.`
      : `Open for ${openDays} day${openDays === 1 ? "" : "s"} — reminder added to check it out.`;
    alert.innerHTML = `
      <svg class="icon"><use href="#i-alert"></use></svg>
      <span>${esc(text)}</span>`;
    return alert;
  }

  // Builds one ticket's clickable head row, with every control wired up.
  // `compact` drops the customer name and phone and leads with the device
  // instead — used for the device rows of a grouped check-in card, where the
  // client's details are shown once in the card header.
  function ticketHead(t, { compact = false } = {}) {
    const statusClass = STATUS_CLASS[t.status] || "st-received";
    const head = document.createElement("div");
    head.className = compact ? "ticket-head ticket-head-compact" : "ticket-head";
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    head.setAttribute("aria-label", `View details for ${t.device || "device"}`);
    const technicianLabel = t.technician ? `Assigned to ${t.technician}` : "Assign technician";
    const phoneLine = ticketPhoneLineHtml(t);
    const deviceIcon = deviceTypeIcon(t.device);
    const partsPending = needsPartsOrdered(t);
    const duePill = repairDuePillHtml(t);
    // Skip the pill once status is explicitly "Part Ordered" — the status
    // badge above already says exactly that, so the pill would just repeat
    // it. It still earns its place on "Waiting for Parts" (whose badge text
    // doesn't reveal the ordered flag) and "Part to be Ordered" (where it's
    // the action to advance the status).
    const partsBtnHtml = PARTS_STATUSES.has(t.status) && t.status !== "Part Ordered"
      ? `<button type="button" class="ticket-parts-btn${partsPending ? "" : " is-ordered"}" data-parts-toggle aria-pressed="${partsPending ? "false" : "true"}">
          <svg class="icon"><use href="#${partsPending ? "i-tools" : "i-check"}"></use></svg>${partsPending ? "Mark parts ordered" : "Parts ordered"}
        </button>`
      : "";
    const identityHtml = compact
      ? `<div class="ticket-identity">
        <span class="ticket-num mono">#${esc(t.id || "")}</span>
        <div class="ticket-customer">${esc(t.device || "—")}</div>
      </div>`
      : `<div class="ticket-identity">
        <span class="ticket-num mono">#${esc(t.id || "")}</span>
        <div class="ticket-customer">${esc(t.customerName || "Unknown customer")}</div>
        <div class="ticket-sub">${esc(t.device || "—")}</div>
        ${phoneLine}
      </div>
      <div class="ticket-phone-row">${phoneLine}</div>`;
    head.innerHTML = `
      <div class="ticket-device-thumb" title="${esc(t.device || "Device")}">
        <svg class="icon ticket-device-fallback" aria-hidden="true"><use href="#${deviceIcon}"></use></svg>
        <img alt="" />
      </div>
      ${identityHtml}
      <div class="ticket-repair">
        <span class="ticket-repair-label">Repair</span>
        <div class="issue-tags issue-tags-readonly">${ticketRepairChipsHtml(t)}</div>
      </div>
      <div class="ticket-status">
        <button type="button" class="status-badge status-badge-btn ${statusClass}" aria-label="Change status (currently ${esc(t.status || "—")})">${esc(t.status || "—")}</button>
        ${partsBtnHtml}
        ${duePill}
        <button type="button" class="ticket-tech-btn" aria-label="${esc(technicianLabel)}">${esc(technicianLabel)}</button>
      </div>
      <div class="ticket-activity">
        ${activityLogBtnHtml(t, "")}
      </div>`;
    head.querySelectorAll("a.ticket-phone").forEach((phoneEl) => {
      phoneEl.onclick = (e) => e.stopPropagation();
      phoneEl.onkeydown = (e) => e.stopPropagation();
    });
    const statusBtn = head.querySelector(".status-badge-btn");
    if (statusBtn) {
      statusBtn.onclick = (e) => {
        e.stopPropagation();
        openStatusModalForTicket(t);
      };
      statusBtn.onkeydown = (e) => e.stopPropagation();
    }
    const partsBtn = head.querySelector("[data-parts-toggle]");
    if (partsBtn) {
      partsBtn.onclick = (e) => {
        e.stopPropagation();
        togglePartsOrdered(t);
      };
      partsBtn.onkeydown = (e) => e.stopPropagation();
    }
    const techBtn = head.querySelector(".ticket-tech-btn");
    if (techBtn) {
      techBtn.onclick = (e) => {
        e.stopPropagation();
        openTechnicianModalForTicket(t);
      };
      techBtn.onkeydown = (e) => e.stopPropagation();
    }
    bindActivityLogBtn(head.querySelector(".activity-log-btn"), t);
    const notesBtn = head.querySelector("[data-view-notes]");
    if (notesBtn) {
      notesBtn.onclick = (e) => {
        e.stopPropagation();
        openActivityLogModal(t);
      };
      notesBtn.onkeydown = (e) => e.stopPropagation();
    }
    const thumb = head.querySelector(".ticket-device-thumb");
    const thumbImg = head.querySelector(".ticket-device-thumb img");
    if (thumbImg) {
      fetchDeviceImage(t.device).then((url) => {
        if (!url) return;
        thumbImg.onload = () => thumb.classList.add("has-image");
        thumbImg.onerror = () => thumb.classList.remove("has-image");
        thumbImg.src = url;
      });
    }
    head.onclick = () => openTicketModal(t);
    head.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openTicketModal(t);
      }
    };
    return head;
  }

  function ticketCard(t) {
    const el = document.createElement("div");
    el.className = `ticket ${STATUS_CLASS[t.status] || "st-received"}`;
    if (showsPartsAlert(t)) el.classList.add("has-parts-alert");
    if (repairCheckAlertReason(t)) el.classList.add("has-repair-alert");
    el.appendChild(ticketHead(t));
    const repairAlert = repairCheckAlertEl(t);
    if (repairAlert) el.appendChild(repairAlert);
    const alert = partsAlertEl(t);
    if (alert) el.appendChild(alert);
    return el;
  }

  // One card for a client who dropped off several devices in the same
  // check-in: their details sit in the header once, and each device keeps its
  // own row with its own status, technician, and activity log.
  function ticketGroupCard(tickets) {
    const first = tickets[0];
    const el = document.createElement("div");
    el.className = "ticket ticket-group";
    const header = document.createElement("div");
    header.className = "ticket-group-head";
    header.innerHTML = `
      <div class="ticket-group-identity">
        <div class="ticket-customer">${esc(first.customerName || "Unknown customer")}</div>
        ${ticketPhoneLineHtml(first)}
      </div>
      <span class="ticket-group-count">${tickets.length} devices</span>`;
    header.querySelectorAll("a.ticket-phone").forEach((phoneEl) => {
      phoneEl.onclick = (e) => e.stopPropagation();
    });
    el.appendChild(header);

    const rows = document.createElement("div");
    rows.className = "ticket-group-devices";
    for (const t of tickets) {
      const row = document.createElement("div");
      row.className = `ticket-group-item ${STATUS_CLASS[t.status] || "st-received"}`;
      if (showsPartsAlert(t)) row.classList.add("has-parts-alert");
      if (repairCheckAlertReason(t)) row.classList.add("has-repair-alert");
      row.appendChild(ticketHead(t, { compact: true }));
      const repairAlert = repairCheckAlertEl(t);
      if (repairAlert) row.appendChild(repairAlert);
      const alert = partsAlertEl(t);
      if (alert) row.appendChild(alert);
      rows.appendChild(row);
    }
    el.appendChild(rows);
    return el;
  }

  // Devices logged for one client through "Add another device" are saved as
  // separate tickets (one invoice each), so the list re-joins the ones checked
  // in together and shows them on a single card.
  const CHECKIN_GROUP_WINDOW_MS = 15 * 60 * 1000;

  function checkinGroupKey(t) {
    const name = (t.customerName || "").trim().toLowerCase();
    const phone = (t.phone || "").replace(/\D/g, "");
    const email = (t.email || "").trim().toLowerCase();
    return name || phone || email ? `${name}|${phone}|${email}` : "";
  }

  // Returns the list re-grouped in place: each entry is one card's worth of
  // tickets, in the order the tickets already came in. Tickets without a
  // usable client key or timestamp always stand alone.
  function groupTicketsByCheckin(list) {
    const groups = [];
    const openByKey = new Map();
    for (const t of list) {
      const key = checkinGroupKey(t);
      const time = t.created ? new Date(t.created).getTime() : NaN;
      const open = key && !isNaN(time) ? openByKey.get(key) : null;
      if (open && Math.abs(time - open.time) <= CHECKIN_GROUP_WINDOW_MS) {
        open.tickets.push(t);
        continue;
      }
      const group = { time, tickets: [t] };
      groups.push(group);
      if (key && !isNaN(time)) openByKey.set(key, group);
    }
    return groups.map((g) => g.tickets);
  }

  function checkinCard(tickets) {
    return tickets.length > 1 ? ticketGroupCard(tickets) : ticketCard(tickets[0]);
  }

  async function setPartsOrdered(ticket, ordered) {
    try {
      const res = await api({ action: "update", id: ticket.id, partsOrdered: ordered });
      if (!res.ok) throw new Error(res.error || "Rejected");
      mergeTicket(res.ticket);
      render();
    } catch (e) {
      toast("Couldn't update parts status: " + e.message);
    }
  }

  // ---- Device images --------------------------------------------------------
  // The catalog and image files are bundled with this app. Intake therefore
  // never sends the logged model name to an image API at runtime. Models that
  // have not yet been added to the catalog keep the neutral local placeholder.
  const DEVICE_IMAGE_CATALOG_URL = "assets/device-images/catalog.json";
  let deviceImageCatalogPromise = null;

  function deviceTypeIcon(device) {
    const text = String(device || "").toLowerCase();
    if (/\b(ipad|tablet|tab)\b/.test(text)) return "i-tablet";
    if (/\b(watch|iwatch|galaxy watch|apple watch)\b/.test(text)) return "i-watch";
    if (/\b(macbook|laptop|notebook|chromebook|surface|thinkpad)\b/.test(text)) return "i-laptop";
    if (/\b(playstation|xbox|nintendo|switch|console|controller|gamepad)\b/.test(text)) return "i-gamepad";
    if (/\b(airpods|earbuds|earphones|headphones|beats|buds)\b/.test(text)) return "i-earbuds";
    if (/\b(iphone|phone|galaxy|pixel|tecno|techno|redmi|xiaomi|huawei|honor|oppo|vivo|oneplus|motorola|moto|samsung)\b/.test(text)) return "i-smartphone";
    return "i-device";
  }

  function deviceImageKey(device) {
    return String(device || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  async function fetchDeviceImage(device) {
    const key = deviceImageKey(device);
    if (!key) return null;
    if (!deviceImageCatalogPromise) {
      deviceImageCatalogPromise = fetch(DEVICE_IMAGE_CATALOG_URL)
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({}));
    }
    const catalog = await deviceImageCatalogPromise;
    const item = catalog[key];
    return item && item.file ? "assets/device-images/" + item.file : null;
  }

  // ---- Device autosuggest (from price list) --------------------------------
  function setupDeviceCombobox({ comboboxId, inputId, dropdownId, toggleId, onSelect }) {
    const combobox = $(comboboxId);
    const input = $(inputId);
    const dropdown = $(dropdownId);
    const toggle = $(toggleId);
    if (!combobox || !input || !dropdown) return;

    function deviceOptions(showAll) {
      const names = window.RPC_MODEL_NAMES || [];
      const query = showAll ? "" : input.value.trim().toLowerCase();
      return query ? names.filter((name) => name.toLowerCase().includes(query)) : names;
    }

    function render(showAll) {
      const options = deviceOptions(showAll);
      dropdown.innerHTML = options.length
        ? options.map((name) => `<button type="button" class="device-option ${name === input.value ? "active" : ""}" role="option" data-device="${esc(name)}">${esc(name)}</button>`).join("")
        : `<p class="device-dropdown-empty">No matching devices.</p>`;
      dropdown.querySelectorAll("[data-device]").forEach((btn) => {
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        btn.addEventListener("click", () => choose(btn.dataset.device));
      });
    }

    function open(showAll) {
      render(showAll);
      dropdown.hidden = false;
      input.setAttribute("aria-expanded", "true");
      combobox.classList.add("open");
    }

    function close() {
      dropdown.hidden = true;
      input.setAttribute("aria-expanded", "false");
      combobox.classList.remove("open");
    }

    function choose(name) {
      input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      close();
      input.focus();
      if (onSelect) onSelect(name);
    }

    input.addEventListener("focus", () => open(true));
    input.addEventListener("click", () => open(true));
    input.addEventListener("input", () => { open(false); if (onSelect) onSelect(input.value.trim()); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        open(true);
        dropdown.querySelector(".device-option")?.focus();
      } else if (e.key === "Escape") {
        close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        close();
      }
    });
    dropdown.addEventListener("keydown", (e) => {
      const options = [...dropdown.querySelectorAll(".device-option")];
      const i = options.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        (options[i + 1] || options[0])?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (options[i - 1] || options[options.length - 1])?.focus();
      } else if (e.key === "Escape") {
        close();
        input.focus();
      }
    });
    toggle?.addEventListener("click", () => {
      if (dropdown.hidden) open(true);
      else close();
      input.focus();
    });
    document.addEventListener("click", (e) => {
      if (combobox.contains(e.target)) return;
      close();
    });
  }

  setupDeviceCombobox({ comboboxId: "fDeviceCombobox", inputId: "fDevice", dropdownId: "fDeviceDropdown", toggleId: "openFDeviceDropdown" });

  // ---- Helpers -------------------------------------------------------------
  // The original Apps Script API returned `client` and `issue`. The current
  // API returns `customerName` and `issues`. Normalize both versions at the
  // boundary so existing tickets keep their caller details on the dashboard.
  function normalizeTicket(ticket) {
    return Object.assign({}, ticket, {
      customerName: ticket.customerName || ticket.client || "",
      email: ticket.email || "",
      issues: ticket.issues || ticket.issue || "",
      repairCost: ticket.repairCost ?? ticket.cost ?? "",
      amountPaid: ticket.amountPaid ?? ticket.paid ?? "",
      technician: ticket.technician || "",
      repairDueDate: ticket.repairDueDate || "",
      inventoryItemKey: ticket.inventoryItemKey || "",
      inventoryItemLabel: ticket.inventoryItemLabel || "",
      inventorySection: ticket.inventorySection || "",
      inventoryQuantityDelta: ticket.inventoryQuantityDelta || 0,
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
