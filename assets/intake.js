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
  const ACTIVE_REPAIR_STATUSES = new Set(["Received", "Diagnosing", "Waiting for Parts", "In Progress"]);

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

  // State
  let TICKETS = [];
  let TECHNICIANS = [];
  let statusFilter = "all";
  let editingId = null;
  let formStep = 1;
  // True when the form was opened from a Prices-tab repair click — device and
  // issue are already known, so the wizard skips straight to Payment.
  let quickLogMode = false;
  let loadedOnce = false;
  let visibleTicketCount = TICKET_PAGE_SIZE;
  // If Check In is not configured yet, retain a price-row selection until the
  // user has manually connected the Check In tab.
  let pendingLogDevice = null;
  let technicianModalTicket = null;
  let suppressTechnicianFocusOpen = false;
  let INVENTORY_ITEMS = [];
  let inventoryLoadPromise = null;

  // ---- View navigation -----------------------------------------------------
  const navBtns = document.querySelectorAll(".nav-btn[data-target]");
  const settingsNavBtn = $("intakeSettings");
  const views = {
    dashboard: $("view-dashboard"),
    targets: $("view-targets"),
    appointments: $("view-appointments"),
    prices: $("view-prices"),
    intake: $("view-intake"),
    inventory: $("view-inventory"),
    expenses: $("view-expenses"),
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
  function navigateTo(target) {
    setActiveNav(target);
    showView(target);
    if (target === "dashboard") window.dispatchEvent(new Event("rpc-enter-dashboard"));
    if (target === "targets") window.dispatchEvent(new Event("rpc-enter-targets"));
    if (target === "appointments") window.dispatchEvent(new Event("rpc-enter-appointments"));
    if (target === "intake") enterIntake();
    if (target === "inventory") window.dispatchEvent(new Event("rpc-enter-inventory"));
    if (target === "expenses") window.dispatchEvent(new Event("rpc-enter-expenses"));
  }
  window.RPC_SHOW_VIEW = navigateTo;
  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateTo(btn.dataset.target);
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
    $("settingsMaintenance").hidden = !prefill;
    if (prefill) $("cfgPin").value = getCfg().pin;
    if (prefill && isConfigured()) loadTechnicians();
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
      visibleTicketCount = TICKET_PAGE_SIZE;
      statusFilter = "all";
      refreshInventoryAfterStockChange();
      closeForm();
      closeClearAllModal();
      renderStatusChips();
      render();
      publishTickets();
      if (res.backup) alert(`Deleted ${res.deletedCount} record${res.deletedCount === 1 ? "" : "s"}. Backup ${res.backup.id} is ready to restore if needed.`);
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
  $("restoreBackupModal").addEventListener("click", (e) => {
    if (e.target.id === "restoreBackupModal") closeRestoreBackupModal();
  });
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
      alert(`Restored ${res.restoredCount} record${res.restoredCount === 1 ? "" : "s"}. Your previous check-in list is backed up as ${res.backup.id}.`);
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
  $("issueModal").addEventListener("click", (e) => {
    if (e.target.id === "issueModal") closeIssueModal();
  });
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

  function activityLogCount(ticket) {
    return parseHistoryEntries(ticket.history).length + (ticket.notes ? 1 : 0);
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

  function activityLogBodyHtml(ticket) {
    const sections = [];
    if (ticket.notes) {
      sections.push(`<section class="activity-log-section">
        <p class="field-label">Notes</p>
        <p class="ticket-detail-notes activity-log-note">${esc(ticket.notes)}</p>
      </section>`);
    }
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

  function openActivityLogModal(ticket) {
    $("activityLogTitle").textContent = ticket.device || "Updates & notes";
    $("activityLogBody").innerHTML = activityLogBodyHtml(ticket);
    $("activityLogModal").hidden = false;
    $("closeActivityLogModal").focus();
  }

  function closeActivityLogModal() {
    $("activityLogModal").hidden = true;
  }

  $("closeActivityLogModal").addEventListener("click", closeActivityLogModal);
  $("activityLogModal").addEventListener("click", (e) => {
    if (e.target.id === "activityLogModal") closeActivityLogModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("activityLogModal").hidden) closeActivityLogModal();
  });

  function openTicketModal(ticket) {
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
          <span class="status-badge ${STATUS_CLASS[ticket.status] || "st-received"}">${esc(ticket.status || "—")}</span>
        </div>
      </div>
      <section class="ticket-detail-section"><p class="field-label">Customer & device</p><div class="ticket-detail-grid">
        ${detailRow("i-user", "Customer", ticket.customerName || "Unknown customer")}
        ${detailRow("i-phone", "Phone", ticket.phone ? `<a class="ticket-tel" href="tel:${esc(ticket.phone)}">${esc(ticket.phone)}</a>` : "—")}
        ${detailRow("i-mail", "Email", ticket.email ? `<a class="ticket-tel" href="mailto:${esc(ticket.email)}">${esc(ticket.email)}</a>` : "—")}
        ${detailRow("i-device", "Device", ticket.device || "—")}
        ${detailRow("i-user", "Technician", esc(technician))}
        ${detailRow("i-tools", "Stock used", esc(ticket.inventoryItemLabel || "No stock item used"))}
      </div></section>
      <section class="ticket-detail-section"><p class="field-label">Payment</p><div class="ticket-detail-grid">
        ${detailRow("i-cash", "Repair cost", formatMoney(ticket.repairCost), "money-positive")}
        ${detailRow("i-cash", "Amount paid", formatMoney(ticket.amountPaid), "money-positive")}
        ${detailRow("i-cash", "Balance due", formatMoney(balanceDue(ticket.repairCost, ticket.amountPaid)), balanceTone(ticket.repairCost, ticket.amountPaid))}
      </div></section>
      <section class="ticket-detail-section"><p class="field-label">Issues</p><div class="issue-tags issue-tags-readonly">${issueTagsHtml(ticket.issues)}</div></section>`;

    $("ticketModalFooter").innerHTML = `
      ${hasPhone ? `<a class="primary-btn" href="tel:${esc(ticket.phone)}"><svg class="icon"><use href="#i-phone"></use></svg>Call client</a>` : ""}
      <button type="button" class="ghost-btn" id="ticketModalAssign"><svg class="icon"><use href="#i-user"></use></svg>${ticket.technician ? "Reassign" : "Assign"}</button>
      <button type="button" class="ghost-btn" id="ticketModalEdit"><svg class="icon"><use href="#i-pencil"></use></svg>Edit details</button>
      <button type="button" class="ghost-btn danger-btn" id="ticketModalDelete"><svg class="icon"><use href="#i-trash"></use></svg><span class="visually-hidden">Delete</span></button>`;
    bindActivityLogBtn($("ticketModalActivity"), ticket);
    $("ticketModalAssign").onclick = () => { closeTicketModal(); openTechnicianModalForTicket(ticket); };
    $("ticketModalEdit").onclick = () => { closeTicketModal(); openForm(ticket); };
    $("ticketModalDelete").onclick = async () => { if (await deleteTicket(ticket)) closeTicketModal(); };
    $("ticketModal").hidden = false;
    $("closeTicketModal").focus();
  }

  function closeTicketModal() { $("ticketModal").hidden = true; }
  $("closeTicketModal").addEventListener("click", closeTicketModal);
  $("ticketModal").addEventListener("click", (e) => { if (e.target.id === "ticketModal") closeTicketModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("ticketModal").hidden) closeTicketModal(); });

  function detailRow(iconName, label, value, valueClass = "") {
    return `<div class="ticket-detail-row"><svg class="icon"><use href="#${iconName}"></use></svg><span class="ticket-detail-label">${esc(label)}</span><span class="ticket-detail-value ${valueClass}">${value}</span></div>`;
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

  function openForm(ticket) {
    editingId = ticket ? ticket.id : null;
    setQuickLogMode(false);
    $("intakeFormTitle").textContent = ticket ? "Edit device" : "Log device";
    $("fName").value = ticket ? ticket.customerName || "" : "";
    $("fPhone").value = ticket ? ticket.phone || "" : "";
    $("fEmail").value = ticket ? ticket.email || "" : "";
    $("fDevice").value = ticket ? ticket.device || "" : "";
    $("fStatus").value = ticket ? ticket.status || "Received" : "Received";
    $("fNotes").value = ticket ? ticket.notes || "" : "";
    $("fRepairCost").value = ticket ? ticket.repairCost ?? "" : "";
    $("fAmountPaid").value = ticket ? ticket.amountPaid ?? "" : "";
    $("fSendInvoice").checked = !ticket;
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
    setFormStep(1);
    $("intakeFormModal").hidden = false;
    $("fName").focus();
  }
  function closeForm() {
    $("intakeFormModal").hidden = true;
    editingId = null;
    setQuickLogMode(false);
  }
  $("fDevice").addEventListener("input", () => updateInventoryOptions($("fInventoryItem").value));

  $("newIntakeBtn").addEventListener("click", () => openForm(null));
  function setFormStep(step) {
    formStep = step;
    document.querySelectorAll("[data-form-step]").forEach((panel) => {
      panel.hidden = Number(panel.dataset.formStep) !== step;
    });
    document.querySelectorAll("[data-progress-step]").forEach((indicator) => {
      const indicatorStep = Number(indicator.dataset.progressStep);
      indicator.classList.toggle("active", indicatorStep === step);
      indicator.classList.toggle("complete", indicatorStep < step);
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
  }

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
  $("closeIntakeFormModal").addEventListener("click", closeForm);
  $("intakeFormModal").addEventListener("click", (e) => {
    if (e.target.id === "intakeFormModal") closeForm();
  });

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
    $("fName").focus();
  }

  window.addEventListener("rpc-log-device", (e) => {
    const detail = e.detail || {};
    if (!isConfigured()) {
      pendingLogDevice = detail;
      window.alert("Set up the Check In PIN from the Check In tab before logging a device.");
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
  $("technicianModal").addEventListener("click", (e) => {
    if (e.target.id === "technicianModal") closeTechnicianModal();
  });
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
    const issuesStr = buildIssuesString();
    if (!issuesStr) {
      err.textContent = "Select at least one issue.";
      err.hidden = false;
      return;
    }
    const notes = $("fNotes").value.trim();
    const invoiceNote = $("fSendInvoice").checked && !editingId ? "Invoice to send to client." : "";
    const payload = {
      action: editingId ? "update" : "add",
      id: editingId || undefined,
      customerName: $("fName").value.trim(),
      // Older deployed backends used `client`; send both names so a
      // frontend update never silently drops customer details.
      client: $("fName").value.trim(),
      phone: $("fPhone").value.trim(),
      email: $("fEmail").value.trim(),
      device: $("fDevice").value.trim(),
      issues: issuesStr,
      issue: issuesStr,
      status: $("fStatus").value,
      notes: [invoiceNote, notes].filter(Boolean).join("\n"),
      repairCost: $("fRepairCost").value.trim(),
      amountPaid: $("fAmountPaid").value.trim(),
      inventoryItemKey: $("fInventoryItem").value,
    };
    $("saveForm").disabled = true;
    const original = $("saveForm").textContent;
    $("saveForm").textContent = "Saving…";
    try {
      const res = await api(payload);
      if (!res.ok) throw new Error(res.error || "Rejected");
      const wasEditing = Boolean(editingId);
      mergeTicket(res.ticket);
      refreshInventoryAfterStockChange();
      renderStatusChips();
      render();
      $("intakeFormTitle").textContent = wasEditing ? "Device updated" : "Device logged";
      $("formSuccessTitle").textContent = wasEditing ? "Device successfully updated" : "Device successfully logged";
      $("formSuccessMessage").textContent = $("fSendInvoice").checked && !wasEditing
        ? "The device was logged and marked to send an invoice to the client."
        : "The device check-in has been saved.";
      setFormStep(4);
      $("doneForm").focus();
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
      refreshInventoryAfterStockChange();
      renderStatusChips();
      render();
      publishTickets();
      return true;
    } catch (e) {
      alert("Couldn't delete record: " + e.message);
      return false;
    }
  }

  // ---- Filtering / search --------------------------------------------------
  $("intakeSearch").addEventListener("input", () => {
    visibleTicketCount = TICKET_PAGE_SIZE;
    render();
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
    statusFilter = filter === "active" ? "__active" : filter === "ready" ? "Repaired" : filter;
    if ($("intakeSearch")) $("intakeSearch").value = "";
    visibleTicketCount = TICKET_PAGE_SIZE;
    if (loadedOnce) {
      renderStatusChips();
      render();
    }
  });

  function renderStatusChips() {
    const counts = { all: TICKETS.length };
    STATUSES.forEach((s) => (counts[s] = TICKETS.filter((t) => t.status === s).length));
    const box = $("statusChips");
    box.innerHTML = "";
    const make = (key, label) => {
      const b = document.createElement("button");
      const statusClass = STATUS_CLASS[key];
      b.className = "chip" + (statusClass ? ` status-chip ${statusClass}` : "") + (key === statusFilter ? " active" : "");
      b.textContent = label;
      b.onclick = () => {
        statusFilter = key;
        visibleTicketCount = TICKET_PAGE_SIZE;
        [...box.children].forEach((c) => c.classList.remove("active"));
        b.classList.add("active");
        render();
      };
      box.appendChild(b);
    };
    make("all", `All (${counts.all})`);
    STATUSES.forEach((s) => make(s, `${s} (${counts[s]})`));
  }

  function currentList() {
    const q = $("intakeSearch").value.trim().toLowerCase();
    return TICKETS.filter((t) => {
      if (statusFilter === "__active") {
        if (!ACTIVE_REPAIR_STATUSES.has(t.status)) return false;
      } else if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return [t.device, t.issues, t.id, t.customerName, t.phone, t.email, t.technician]
        .map((x) => (x || "").toLowerCase())
        .some((x) => x.includes(q));
    });
  }

  function render() {
    const list = currentList();
    const visible = list.slice(0, visibleTicketCount);
    $("intakeList").innerHTML = "";
    $("intakeEmpty").hidden = list.length > 0;
    $("intakeError").hidden = true;
    $("intakeCount").textContent = list.length
      ? `Showing ${visible.length} of ${list.length} device${list.length === 1 ? "" : "s"}`
      : "";
    const frag = document.createDocumentFragment();
    for (const t of visible) frag.appendChild(ticketCard(t));
    if (visible.length < list.length) {
      const more = document.createElement("button");
      const remaining = list.length - visible.length;
      more.className = "view-more-btn";
      more.innerHTML = `View ${Math.min(TICKET_PAGE_SIZE, remaining)} more <span aria-hidden="true">↓</span>`;
      more.onclick = () => {
        visibleTicketCount += TICKET_PAGE_SIZE;
        render();
      };
      frag.appendChild(more);
    }
    $("intakeList").appendChild(frag);
  }

  function issueTagsHtml(issuesStr) {
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return `<span class="issue-chip muted">No issues recorded</span>`;
    return parts.map((p) => `<span class="issue-chip">${esc(p)}</span>`).join("");
  }

  function issueSummaryText(issuesStr) {
    return (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  }

  function ticketCard(t) {
    const el = document.createElement("div");
    const statusClass = STATUS_CLASS[t.status] || "st-received";
    el.className = `ticket ${statusClass}`;

    const head = document.createElement("div");
    head.className = "ticket-head";
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    head.setAttribute("aria-label", `View details for ${t.device || "device"}`);
    const hasPhone = !!t.phone;
    const technicianLabel = t.technician ? `Assigned to ${t.technician}` : "Assign technician";
    const phoneLine = hasPhone
      ? `<a class="ticket-phone" href="tel:${esc(t.phone)}" aria-label="Call ${esc(t.customerName || "customer")}"><svg class="icon ticket-phone-icon"><use href="#i-phone"></use></svg>${esc(t.phone)}</a>`
      : `<span class="ticket-phone no-phone">No number on file</span>`;
    const deviceIcon = deviceTypeIcon(t.device);
    head.innerHTML = `
      <div class="ticket-device-thumb" title="${esc(t.device || "Device")}">
        <svg class="icon ticket-device-fallback" aria-hidden="true"><use href="#${deviceIcon}"></use></svg>
        <img alt="" />
      </div>
      <div class="ticket-identity">
        <span class="ticket-num mono">#${esc(t.id || "")}</span>
        <div class="ticket-customer">${esc(t.customerName || "Unknown customer")}</div>
        <div class="ticket-sub">${esc(t.device || "—")}</div>
        ${phoneLine}
      </div>
      <div class="ticket-repair">
        <span class="ticket-repair-label">Repair</span>
        <div class="issue-tags issue-tags-readonly">${issueTagsHtml(t.issues)}</div>
      </div>
      <div class="ticket-status">
        <span class="status-badge ${statusClass}">${esc(t.status || "—")}</span>
        <button type="button" class="ticket-tech-btn" aria-label="${esc(technicianLabel)}">${esc(technicianLabel)}</button>
      </div>
      <div class="ticket-activity">
        ${activityLogBtnHtml(t, "")}
      </div>`;
    const phoneEl = head.querySelector("a.ticket-phone");
    if (phoneEl) phoneEl.onclick = (e) => e.stopPropagation();
    if (phoneEl) phoneEl.onkeydown = (e) => e.stopPropagation();
    const techBtn = head.querySelector(".ticket-tech-btn");
    if (techBtn) {
      techBtn.onclick = (e) => {
        e.stopPropagation();
        openTechnicianModalForTicket(t);
      };
      techBtn.onkeydown = (e) => e.stopPropagation();
    }
    bindActivityLogBtn(head.querySelector(".activity-log-btn"), t);
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
    el.appendChild(head);
    return el;
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
      email: ticket.email || "",
      issues: ticket.issues || ticket.issue || "",
      repairCost: ticket.repairCost ?? ticket.cost ?? "",
      amountPaid: ticket.amountPaid ?? ticket.paid ?? "",
      technician: ticket.technician || "",
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
