/* ============================================================
   Business dashboard — top-level repair shop KPIs. Reads the
   existing Check In and Inventory APIs without changing their data layer.
   ============================================================ */

(function () {
  const INTAKE_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  const GOAL_KEY = "rpc_monthly_sales_goal";
  const DAILY_GOAL_KEY = "rpc_daily_sales_goal";
  const ACTION_CARDS_KEY = "rpc_target_action_cards";
  // Pre-sync expenses store (device-local) — read once for migration only.
  const LEGACY_EXPENSES_KEY = "rpc_expenses";
  // Offline fallback: the last expense list the server returned.
  const EXPENSES_CACHE_KEY = "rpc_expenses_cache";
  const DEFAULT_MONTHLY_GOAL = 80000;
  const DEFAULT_DAILY_GOAL = 2500;
  const DEFAULT_ACTIONS = [
    { title: "Call every device marked ready for pickup", status: "todo", notes: "Turn completed repairs into collected revenue." },
    { title: "Follow up customers with outstanding balances", status: "doing", notes: "Prioritize balances due before closing." },
    { title: "Review repairs waiting more than 5 days", status: "todo", notes: "Move each ticket to its next clear step." },
    { title: "Check low-stock repair parts before closing", status: "done", notes: "Confirm parts needed for tomorrow." },
  ];
  const ACTIVE_STATUSES = new Set([
    "Received",
    "Diagnosing",
    "Waiting for Parts",
    "Part to be Ordered",
    "Part Ordered",
    "In Progress",
  ]);
  const FINAL_STATUSES = new Set(["Picked Up", "No Fix", "Cancelled"]);
  const $ = (id) => document.getElementById(id);

  let tickets = [];
  let inventoryItems = [];
  let monthlySales = []; // [{monthKey, totalSales, ticketCount}, ...] desc by month
  let lastUpdated = null;
  let loadInFlight = null;
  let goalFormBound = false;

  function pin() {
    try { return localStorage.getItem(LS_PIN) || ""; }
    catch (_) { return ""; }
  }

  function monthlyGoal() {
    try {
      const saved = Number(localStorage.getItem(GOAL_KEY) || 0);
      return saved > 0 ? saved : DEFAULT_MONTHLY_GOAL;
    } catch (_) {
      return DEFAULT_MONTHLY_GOAL;
    }
  }

  function dailyGoal() {
    try {
      const saved = Number(localStorage.getItem(DAILY_GOAL_KEY) || 0);
      return saved > 0 ? saved : DEFAULT_DAILY_GOAL;
    } catch (_) {
      return DEFAULT_DAILY_GOAL;
    }
  }

  async function loadDashboard({ force = false } = {}) {
    if (loadInFlight && !force) return loadInFlight;
    loadInFlight = (async () => {
      setStatus("loading");
      const hasPin = !!pin();
      const ticketPromise = hasPin ? loadTickets() : Promise.resolve({ tickets: [], noPin: true });
      const inventoryPromise = loadInventory();
      const monthlySalesPromise = hasPin ? loadMonthlySales() : Promise.resolve({ months: [] });
      const [ticketData, inventoryData, monthlySalesData] = await Promise.allSettled([ticketPromise, inventoryPromise, monthlySalesPromise]);

      if (ticketData.status === "fulfilled") tickets = ticketData.value.tickets || [];
      if (inventoryData.status === "fulfilled") inventoryItems = inventoryData.value.items || [];
      if (monthlySalesData.status === "fulfilled") monthlySales = monthlySalesData.value.months || [];

      render(ticketData.status === "fulfilled" ? ticketData.value : { error: true });
      lastUpdated = Date.now();
      setStatus(ticketData.status === "rejected" ? "error" : "live");
      loadInFlight = null;
    })();
    return loadInFlight;
  }

  async function loadTickets() {
    const q = new URLSearchParams({ action: "list", pin: pin(), _: Date.now() });
    const res = await fetch(INTAKE_URL + "?" + q.toString(), { method: "GET", cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Couldn't load check-ins");
    return { tickets: (data.tickets || []).map(normalizeTicket) };
  }

  async function loadMonthlySales() {
    const q = new URLSearchParams({ action: "listMonthlySales", pin: pin(), _: Date.now() });
    const res = await fetch(INTAKE_URL + "?" + q.toString(), { method: "GET", cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Couldn't load sales history");
    return { months: data.months || [] };
  }

  async function loadInventory() {
    if (Array.isArray(window.RPC_INVENTORY_ITEMS) && window.RPC_INVENTORY_ITEMS.length) {
      return { items: window.RPC_INVENTORY_ITEMS.map(normalizeInventoryItem) };
    }
    if (typeof window.RPC_LOAD_INVENTORY === "function") {
      const data = await window.RPC_LOAD_INVENTORY({ force: false });
      return { items: (data.items || []).map(normalizeInventoryItem) };
    }
    return { items: [] };
  }

  function normalizeTicket(ticket) {
    return Object.assign({}, ticket, {
      customerName: ticket.customerName || ticket.client || "",
      issues: ticket.issues || ticket.issue || "",
      status: ticket.status || "Received",
      repairCost: Number(ticket.repairCost ?? ticket.cost ?? 0) || 0,
      amountPaid: Number(ticket.amountPaid ?? ticket.paid ?? 0) || 0,
      created: ticket.created || ticket.created_at || ticket.timestamp || ticket.updated || "",
      updated: ticket.updated || ticket.updated_at || "",
    });
  }

  function normalizeInventoryItem(item) {
    return Object.assign({}, item, {
      section: item.section || "OTHER",
      quantity: Number(item.quantity || 0),
      item: item.item || item.device || item.label || "",
    });
  }

  function render(loadState) {
    const metrics = buildMetrics();
    renderGoalEditor(metrics);
    renderKpis(metrics, loadState);
    renderFocus(metrics, loadState);
  }

  function buildMetrics() {
    const now = new Date();
    const currentMonth = monthKey(now);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = monthKey(lastMonthDate);
    const goal = monthlyGoal();
    const salesThisMonth = tickets
      .filter((ticket) => monthKey(ticketDate(ticket)) === currentMonth)
      .reduce((sum, ticket) => sum + ticket.repairCost, 0);
    // Sourced from the durable monthly_sales ledger so this comparison
    // survives a "Clear all" — falls back to filtering live tickets only
    // if the ledger hasn't recorded that month yet (e.g. right after
    // upgrading, before the one-time backfill has run).
    const lastMonthLedgerRow = monthlySales.find((m) => m.monthKey === lastMonth);
    const salesLastMonth = lastMonthLedgerRow
      ? lastMonthLedgerRow.totalSales
      : tickets
          .filter((ticket) => monthKey(ticketDate(ticket)) === lastMonth)
          .reduce((sum, ticket) => sum + ticket.repairCost, 0);
    const activeRepairs = tickets.filter((ticket) => ACTIVE_STATUSES.has(ticket.status));
    const readyForPickup = tickets.filter((ticket) => ticket.status === "Repaired");
    const lowStockItems = inventoryItems.filter((item) => item.section !== "TOOLS" && item.quantity > 0 && item.quantity <= 1);
    const outstandingTickets = tickets
      .filter((ticket) => !FINAL_STATUSES.has(ticket.status))
      .map((ticket) => Object.assign({}, ticket, { balance: Math.max(0, ticket.repairCost - ticket.amountPaid) }))
      .filter((ticket) => ticket.balance > 0);
    const waitingOverFiveDays = activeRepairs.filter((ticket) => ageInDays(ticketDate(ticket)) > 5);

    return {
      goal,
      salesThisMonth,
      salesLastMonth,
      goalPercent: goal > 0 ? Math.min(100, Math.round((salesThisMonth / goal) * 100)) : 0,
      activeRepairs,
      readyForPickup,
      lowStockItems,
      outstandingTickets,
      outstandingBalance: outstandingTickets.reduce((sum, ticket) => sum + ticket.balance, 0),
      waitingOverFiveDays,
    };
  }

  function renderGoalEditor(metrics) {
    const input = $("dashboardGoalInput");
    const dailyInput = $("dashboardDailyGoalInput");
    const goal = Math.round((metrics && metrics.goal) || monthlyGoal() || DEFAULT_MONTHLY_GOAL);
    if (input && document.activeElement !== input) input.value = goal;
    if (dailyInput && document.activeElement !== dailyInput) dailyInput.value = Math.round(dailyGoal());
    bindGoalForm();
    renderTargetProgress();
    renderActionPlan();
  }

  // Live progress against the saved targets, shown at the top of the Targets
  // page so the numbers being chased are visible where they're set.
  function renderTargetProgress() {
    const monthSalesEl = $("targetMonthSales");
    if (!monthSalesEl) return;
    const now = new Date();
    const currentMonth = monthKey(now);
    const today = dayKey(now);
    const goal = monthlyGoal();
    const daily = dailyGoal();
    const salesThisMonth = tickets
      .filter((ticket) => monthKey(ticketDate(ticket)) === currentMonth)
      .reduce((sum, ticket) => sum + ticket.repairCost, 0);
    const salesToday = tickets
      .filter((ticket) => dayKey(ticketDate(ticket)) === today)
      .reduce((sum, ticket) => sum + ticket.repairCost, 0);

    monthSalesEl.textContent = money(salesThisMonth);
    $("targetMonthGoalLabel").textContent = "of " + money(goal);
    $("targetMonthBar").style.width = Math.min(100, goal > 0 ? Math.round((salesThisMonth / goal) * 100) : 0) + "%";

    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1); // includes today
    const remaining = goal - salesThisMonth;
    $("targetMonthPace").textContent = remaining <= 0
      ? "Monthly target hit — everything from here is extra."
      : `${money(remaining)} to go · ${money(Math.ceil(remaining / daysLeft))}/day over the next ${daysLeft} day${daysLeft === 1 ? "" : "s"} hits it.`;

    $("targetTodaySales").textContent = money(salesToday);
    $("targetTodayGoalLabel").textContent = "of " + money(daily);
    $("targetTodayBar").style.width = Math.min(100, daily > 0 ? Math.round((salesToday / daily) * 100) : 0) + "%";
    const todayRemaining = daily - salesToday;
    $("targetTodayPace").textContent = todayRemaining <= 0
      ? "Daily target hit — great pace."
      : money(todayRemaining) + " more today to stay on pace.";

    renderMonthlySalesHistory(currentMonth);
  }

  // Past months from the durable monthly_sales ledger (assets/dashboard.js's
  // own "This month" card above already covers the current month live), each
  // shown against the month before it so trends are visible at a glance.
  function renderMonthlySalesHistory(currentMonth) {
    const list = $("targetMonthlyHistory");
    if (!list) return;
    const pastMonths = monthlySales.filter((m) => m.monthKey !== currentMonth);
    if (!pastMonths.length) {
      list.innerHTML = `<p class="ops-empty">No past months recorded yet.</p>`;
      return;
    }
    list.innerHTML = pastMonths.map((m, i) => {
      const prior = pastMonths[i + 1];
      const comparison = prior && prior.totalSales > 0
        ? `${signedPercent(m.totalSales, prior.totalSales)} vs ${monthLabel(prior.monthKey)}`
        : "No prior month to compare";
      return `<article class="ops-row target-history-row">
        <div>
          <strong>${esc(monthLabel(m.monthKey))} · ${money(m.totalSales)}</strong>
          <p>${esc(comparison)}</p>
        </div>
        <small>${m.ticketCount} ticket${m.ticketCount === 1 ? "" : "s"}</small>
      </article>`;
    }).join("");
  }

  function monthLabel(monthKeyStr) {
    const [y, m] = String(monthKeyStr).split("-").map(Number);
    if (!y || !m) return monthKeyStr;
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function dayKey(date) {
    if (!date || isNaN(date)) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function bindGoalForm() {
    if (goalFormBound) return;
    const form = $("dashboardGoalForm");
    if (!form) return;
    goalFormBound = true;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("dashboardGoalInput");
      const dailyInput = $("dashboardDailyGoalInput");
      const msg = $("dashboardGoalMessage");
      const value = Number(input?.value || 0);
      const dailyValue = Number(dailyInput?.value || 0);
      if (!value || value < 0) {
        if (msg) msg.textContent = "Enter a monthly target greater than 0.";
        return;
      }
      if (!dailyValue || dailyValue < 0) {
        if (msg) msg.textContent = "Enter a daily target greater than 0.";
        return;
      }
      try {
        localStorage.setItem(GOAL_KEY, String(Math.round(value)));
        localStorage.setItem(DAILY_GOAL_KEY, String(Math.round(dailyValue)));
      } catch (_) {}
      if (msg) msg.textContent = "Targets saved.";
      render({});
    });
  }

  function renderActionPlan() {
    renderActionBoard();
  }

  function renderActionBoard() {
    const board = $("targetActionBoard");
    if (!board) return;
    const cards = readActionCards();
    const columns = [
      { key: "todo", label: "To do" },
      { key: "doing", label: "Doing" },
      { key: "done", label: "Done" },
    ];
    board.innerHTML = columns.map((column) => {
      const items = cards.filter((card) => card.status === column.key);
      const clearBtn = column.key === "done" && items.length
        ? `<button type="button" class="target-clear-done" data-action-clear-done>Clear</button>`
        : "";
      const composer = column.key === "todo" ? targetTodoComposerHtml() : "";
      return `<section class="target-board-column">
        <div class="target-board-heading"><span>${esc(column.label)}</span><b>${items.length}</b>${clearBtn}</div>
        <div class="target-board-cards">
          ${composer}
          ${items.length ? items.map(actionCardHtml).join("") : `<p class="ops-empty">No cards yet.</p>`}
        </div>
      </section>`;
    }).join("");
    board.querySelector("[data-action-add-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const title = (form.querySelector("[data-action-add-title]")?.value || "").trim();
      const notes = (form.querySelector("[data-action-add-notes]")?.value || "").trim();
      const message = form.querySelector("[data-action-add-message]");
      if (!title) {
        if (message) message.textContent = "Add a title first.";
        form.querySelector("[data-action-add-title]")?.focus();
        return;
      }
      addActionCard({ title, notes, status: "todo" });
    });
    board.querySelectorAll("[data-action-move]").forEach((btn) => {
      btn.addEventListener("click", () => updateActionCard(btn.dataset.actionId, { status: btn.dataset.actionMove }));
    });
    board.querySelectorAll("[data-action-delete]").forEach((btn) => {
      btn.addEventListener("click", () => deleteActionCard(btn.dataset.actionDelete));
    });
    board.querySelector("[data-action-clear-done]")?.addEventListener("click", () => {
      writeJson(ACTION_CARDS_KEY, readActionCards().filter((card) => card.status !== "done"));
      renderActionPlan();
    });
  }

  function targetTodoComposerHtml() {
    return `<form class="target-inline-composer" data-action-add-form>
      <input class="target-inline-title" data-action-add-title type="text" autocomplete="off" placeholder="Add a to-do..." aria-label="New to-do title" />
      <textarea class="target-inline-notes" data-action-add-notes rows="2" placeholder="Add a note" aria-label="New to-do note"></textarea>
      <div class="target-inline-actions">
        <p class="dashboard-target-message" data-action-add-message aria-live="polite"></p>
        <button type="submit" class="ghost-btn target-inline-add"><svg class="icon"><use href="#i-plus"></use></svg>Add</button>
      </div>
    </form>`;
  }

  function actionCardHtml(card) {
    const moveButtons = [
      ["todo", "To do"],
      ["doing", "Doing"],
      ["done", "Done"],
    ].filter(([status]) => status !== card.status);
    const age = card.created ? ageInDays(new Date(card.created)) : 0;
    const ageLabel = age >= 1 ? `<small class="target-card-age">${age >= 2 ? Math.floor(age) + " days" : "1 day"} old</small>` : "";
    return `<article class="target-action-card">
      <strong>${esc(card.title)}</strong>
      ${card.notes ? `<p>${esc(card.notes)}</p>` : ""}
      ${ageLabel}
      <div class="target-card-actions">
        ${moveButtons.map(([status, label]) => `<button type="button" data-action-id="${esc(card.id)}" data-action-move="${esc(status)}">${esc(label)}</button>`).join("")}
        <button type="button" class="danger-text" data-action-delete="${esc(card.id)}">Delete</button>
      </div>
    </article>`;
  }

  function readActionCards() {
    const saved = readJson(ACTION_CARDS_KEY, null);
    if (Array.isArray(saved)) return saved;
    const seeded = DEFAULT_ACTIONS.map((card) => Object.assign({ id: uid(), created: new Date().toISOString() }, card));
    writeJson(ACTION_CARDS_KEY, seeded);
    return seeded;
  }

  function addActionCard(card) {
    const title = String(card.title || "").trim();
    if (!title) return;
    const cards = readActionCards();
    cards.unshift({
      id: uid(),
      title,
      notes: String(card.notes || "").trim(),
      status: card.status || "todo",
      created: new Date().toISOString(),
    });
    writeJson(ACTION_CARDS_KEY, cards);
    renderActionPlan();
  }

  function updateActionCard(id, patch) {
    if (!id) return;
    writeJson(ACTION_CARDS_KEY, readActionCards().map((card) => card.id === id ? Object.assign({}, card, patch) : card));
    renderActionPlan();
  }

  function deleteActionCard(id) {
    if (!id) return;
    writeJson(ACTION_CARDS_KEY, readActionCards().filter((card) => card.id !== id));
    renderActionPlan();
  }

  function safeLocalStorageGet(key) {
    try { return localStorage.getItem(key) || ""; }
    catch (_) { return ""; }
  }

  const EXPENSE_CATEGORIES = ["Parts", "Tools", "Rent", "Utilities", "Marketing", "Other"];
  let expenseSearchQuery = "";
  let expenseCategoryFilter = "all";
  let editingExpenseId = null;

  // In-memory expense list, refreshed from the server (shared across
  // devices, like tickets/leads). readExpenses() stays synchronous for the
  // existing render/filter call sites.
  let EXPENSES = readJson(EXPENSES_CACHE_KEY, []);

  function setExpenses(list) {
    EXPENSES = Array.isArray(list) ? list : [];
    writeJson(EXPENSES_CACHE_KEY, EXPENSES);
  }

  async function expensesApi(payload) {
    const res = await fetch(INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: pin() }, payload)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Rejected");
    return data;
  }

  function notifyExpenseError(message) {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message);
    else console.warn(message);
  }

  let expensesLoadInFlight = null;
  function loadExpenses() {
    if (expensesLoadInFlight) return expensesLoadInFlight;
    expensesLoadInFlight = (async () => {
      try {
        const data = await expensesApi({ action: "listExpenses" });
        setExpenses(data.expenses || []);
        await migrateLegacyExpenses();
        renderExpenses();
      } catch (err) {
        console.warn("Couldn't sync expenses:", err);
        notifyExpenseError("Couldn't sync expenses — showing this device's last saved copy.");
      } finally {
        expensesLoadInFlight = null;
      }
    })();
    return expensesLoadInFlight;
  }

  // One-time upload of expenses recorded before they synced through the
  // server. Original ids are kept (ON CONFLICT DO NOTHING server-side), so a
  // retry after partial failure can't duplicate records.
  async function migrateLegacyExpenses() {
    let raw = "";
    try { raw = localStorage.getItem(LEGACY_EXPENSES_KEY) || ""; } catch (_) { return; }
    if (!raw) return;
    let legacy = [];
    try { legacy = JSON.parse(raw) || []; } catch (_) { legacy = []; }
    const known = new Set(EXPENSES.map((item) => item.id));
    for (const item of legacy) {
      if (!item || !item.id || known.has(item.id) || !item.date) continue;
      await expensesApi({ action: "addExpense", ...item });
    }
    const data = await expensesApi({ action: "listExpenses" });
    setExpenses(data.expenses || []);
    try {
      localStorage.setItem(LEGACY_EXPENSES_KEY + "_backup", raw);
      localStorage.removeItem(LEGACY_EXPENSES_KEY);
    } catch (_) { /* storage unavailable */ }
  }

  function initExpenses() {
    bindExpenseFormOnce();
    renderExpenses();
    loadExpenses();
  }

  function bindExpenseFormOnce() {
    const form = $("expenseForm");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";

    $("expenseNewBtn")?.addEventListener("click", openNewExpenseForm);
    $("closeExpenseFormModal")?.addEventListener("click", closeExpenseForm);
    $("expenseCancelBtn")?.addEventListener("click", closeExpenseForm);
    $("expenseSubmit")?.addEventListener("click", saveExpenseForm);
    // Backdrop clicks deliberately do NOT close modals: these are data-entry
    // sheets used on a shop tablet, and one stray tap outside the panel used to
    // throw away a half-filled form. Closing is always an explicit action — the
    // X, Cancel/Done, or Escape.

    $("expenseSearch")?.addEventListener("input", () => {
      expenseSearchQuery = ($("expenseSearch").value || "").trim().toLowerCase();
      const clearBtn = $("clearExpenseSearch");
      if (clearBtn) clearBtn.hidden = !expenseSearchQuery;
      renderExpenses();
    });
    $("clearExpenseSearch")?.addEventListener("click", () => {
      $("expenseSearch").value = "";
      expenseSearchQuery = "";
      $("clearExpenseSearch").hidden = true;
      renderExpenses();
    });

    $("expenseList")?.addEventListener("click", handleExpenseListClick);
    $("expenseReclaimList")?.addEventListener("click", handleExpenseListClick);
    $("expenseCategoryChips")?.addEventListener("click", handleExpenseChipClick);

    $("expenseCashReclaim")?.addEventListener("change", syncReclaimFieldsVisibility);
    form.querySelectorAll("[data-reclaim-preset]").forEach((btn) => {
      btn.addEventListener("click", () => applyReclaimPreset(btn.dataset.reclaimPreset));
    });
  }

  function openNewExpenseForm() {
    editingExpenseId = null;
    $("expenseFormTitle").textContent = "Add expense";
    $("expenseId").value = "";
    $("expenseDate").valueAsDate = new Date();
    $("expenseCategory").value = "Parts";
    $("expenseVendor").value = "";
    $("expenseAmount").value = "";
    $("expenseNotes").value = "";
    if ($("expenseCashReclaim")) $("expenseCashReclaim").checked = false;
    if ($("expenseReclaimFrom")) $("expenseReclaimFrom").value = lastReclaimFrom();
    if ($("expenseReclaimDue")) $("expenseReclaimDue").value = "";
    if ($("expenseReclaimed")) $("expenseReclaimed").checked = false;
    renderReclaimFromOptions();
    syncReclaimFieldsVisibility();
    const msg = $("expenseMessage");
    if (msg) { msg.hidden = true; msg.textContent = ""; }
    $("expenseFormModal").hidden = false;
    $("expenseVendor")?.focus();
  }

  // Pre-fill "collect back from" with whoever was last reclaimed from, since
  // in practice that's the same other business nearly every time.
  function lastReclaimFrom() {
    const recent = readExpenses()
      .filter((item) => item.cashReclaim && String(item.reclaimFrom || "").trim())
      .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    return recent.length ? recent[0].reclaimFrom : "";
  }

  function editExpense(expense) {
    if (!expense) return;
    editingExpenseId = expense.id;
    $("expenseFormTitle").textContent = "Edit expense";
    $("expenseId").value = expense.id;
    $("expenseDate").value = expense.date || "";
    $("expenseCategory").value = expense.category || "Other";
    $("expenseVendor").value = expense.vendor || "";
    $("expenseAmount").value = expense.amount || "";
    $("expenseNotes").value = expense.notes || "";
    if ($("expenseCashReclaim")) $("expenseCashReclaim").checked = !!expense.cashReclaim;
    if ($("expenseReclaimFrom")) $("expenseReclaimFrom").value = expense.reclaimFrom || "";
    if ($("expenseReclaimDue")) $("expenseReclaimDue").value = expense.reclaimDueAt ? toDatetimeLocal(expense.reclaimDueAt) : "";
    if ($("expenseReclaimed")) $("expenseReclaimed").checked = !!expense.reclaimedAt;
    renderReclaimFromOptions();
    syncReclaimFieldsVisibility();
    const msg = $("expenseMessage");
    if (msg) { msg.hidden = true; msg.textContent = ""; }
    $("expenseFormModal").hidden = false;
    $("expenseVendor")?.focus();
  }

  function closeExpenseForm() {
    $("expenseFormModal").hidden = true;
    editingExpenseId = null;
  }

  async function saveExpenseForm() {
    const date = $("expenseDate")?.value || "";
    const amount = Number($("expenseAmount")?.value || 0);
    const msg = $("expenseMessage");
    if (!date || !amount || amount < 0) {
      if (msg) { msg.textContent = "Add a valid date and amount."; msg.hidden = false; }
      return;
    }
    const cashReclaim = !!$("expenseCashReclaim")?.checked;
    const reclaimDueLocal = $("expenseReclaimDue")?.value || "";
    const payload = {
      date,
      category: $("expenseCategory")?.value || "Other",
      vendor: ($("expenseVendor")?.value || "").trim(),
      amount,
      notes: ($("expenseNotes")?.value || "").trim(),
      cashReclaim,
      reclaimFrom: cashReclaim ? ($("expenseReclaimFrom")?.value || "").trim() : "",
      reclaimDueAt: cashReclaim && reclaimDueLocal ? new Date(reclaimDueLocal).toISOString() : null,
      reclaimed: cashReclaim ? !!$("expenseReclaimed")?.checked : false,
    };
    const submitBtn = $("expenseSubmit");
    const originalLabel = submitBtn?.textContent;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
    try {
      const data = editingExpenseId
        ? await expensesApi({ action: "updateExpense", id: editingExpenseId, ...payload })
        : await expensesApi({ action: "addExpense", ...payload });
      setExpenses(
        editingExpenseId
          ? EXPENSES.map((item) => (item.id === data.expense.id ? data.expense : item))
          : [data.expense].concat(EXPENSES)
      );
    } catch (err) {
      if (msg) { msg.textContent = "Couldn't save the expense: " + err.message; msg.hidden = false; }
      return;
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
    }
    closeExpenseForm();
    renderExpenses();
    // A cash-reclaim expense writes its reminder server-side; refresh so it
    // appears in the Reminders tab (and can pop up) without a reload.
    if (typeof window.RPC_REFRESH_REMINDERS === "function") window.RPC_REFRESH_REMINDERS();
  }

  async function handleExpenseListClick(event) {
    const editBtn = event.target.closest("[data-expense-edit]");
    const deleteBtn = event.target.closest("[data-expense-delete]");
    const collectBtn = event.target.closest("[data-expense-collect]");
    const remindBtn = event.target.closest("[data-expense-remind]");
    if (remindBtn) {
      openReminderForExpense(readExpenses().find((item) => item.id === remindBtn.dataset.expenseRemind));
      return;
    }
    if (collectBtn) {
      await setExpenseCollected(collectBtn.dataset.expenseCollect, collectBtn.dataset.collected !== "true");
      return;
    }
    if (editBtn) {
      editExpense(readExpenses().find((item) => item.id === editBtn.dataset.expenseEdit));
      return;
    }
    if (!deleteBtn) return;
    if (!window.confirm("Delete this expense?")) return;
    const id = deleteBtn.dataset.expenseDelete;
    try {
      await expensesApi({ action: "deleteExpense", id });
      setExpenses(EXPENSES.filter((item) => item.id !== id));
      renderExpenses();
      if (typeof window.RPC_REFRESH_REMINDERS === "function") window.RPC_REFRESH_REMINDERS();
    } catch (err) {
      notifyExpenseError("Couldn't delete expense: " + err.message);
    }
  }

  // The "collect this back" block only matters once the box is ticked, and an
  // expense already recorded as collected shouldn't offer a future reminder
  // date it will never fire on — so that row only appears when relevant.
  function syncReclaimFieldsVisibility() {
    const on = !!$("expenseCashReclaim")?.checked;
    const box = $("expenseReclaimFields");
    if (box) box.hidden = !on;
    const collectedRow = $("expenseReclaimedRow");
    if (collectedRow) collectedRow.hidden = !on || !editingExpenseId;
    if (on && !$("expenseReclaimDue")?.value && !editingExpenseId) applyReclaimPreset("week");
  }

  function applyReclaimPreset(preset) {
    const input = $("expenseReclaimDue");
    if (!input) return;
    if (preset === "none") { input.value = ""; return; }
    const d = new Date();
    if (preset === "tomorrow") d.setDate(d.getDate() + 1);
    else if (preset === "week") d.setDate(d.getDate() + 7);
    else if (preset === "month") d.setMonth(d.getMonth() + 1);
    d.setHours(9, 0, 0, 0);
    input.value = toDatetimeLocal(d);
  }

  // Offer the places cash has been reclaimed from before — the owner's other
  // business is usually the same name every time.
  function renderReclaimFromOptions() {
    const list = $("expenseReclaimFromOptions");
    if (!list) return;
    const names = Array.from(new Set(
      readExpenses().map((item) => String(item.reclaimFrom || "").trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    list.innerHTML = names.map((name) => `<option value="${esc(name)}"></option>`).join("");
  }

  function outstandingReclaims(expenses) {
    return expenses.filter((item) => item.cashReclaim && !item.reclaimedAt);
  }

  async function setExpenseCollected(id, collected) {
    try {
      const data = await expensesApi({ action: "updateExpense", id, reclaimed: collected });
      setExpenses(EXPENSES.map((item) => (item.id === id ? data.expense : item)));
      renderExpenses();
      // The mirrored reminder flipped server-side; pull it so the Reminders
      // tab and the alert popups agree with what the expense now says.
      if (typeof window.RPC_REFRESH_REMINDERS === "function") window.RPC_REFRESH_REMINDERS();
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(collected ? "Marked as collected" : "Moved back to outstanding", { tone: "info", duration: 3000 });
      }
    } catch (err) {
      notifyExpenseError("Couldn't update the expense: " + err.message);
    }
  }

  // "Create reminder" on an expense row: opens the ordinary reminder form
  // pre-filled from that expense, so the popup that fires later already says
  // what the money was for. Money already flagged as owed gets a "collect"
  // title; anything else gets a plain follow-up.
  function openReminderForExpense(expense) {
    if (!expense) return;
    openNewReminderForm();
    const owed = expense.cashReclaim && !expense.reclaimedAt;
    const who = String(expense.reclaimFrom || "").trim();
    const title = owed
      ? `Collect ${money(expense.amount)} cash back${who ? " from " + who : ""}`
      : `${expense.category || "Expense"} ${money(expense.amount)}${expense.vendor ? " — " + expense.vendor : ""}`;
    const titleInput = $("reminderTitleInput");
    if (titleInput) titleInput.value = title;
    const notesInput = $("reminderNotes");
    if (notesInput) {
      notesInput.value = [`Expense from ${formatDate(expense.date)}.`, expense.notes].filter(Boolean).join(" ");
    }
    if (owed && $("reminderPriority")) $("reminderPriority").value = "urgent";
    // Default to a time rather than leaving it blank — a reminder with no due
    // time never pops up, which is the whole point of pressing this button.
    applyReminderPreset("tomorrow");
    checkReminderDuplicate();
    $("reminderDue")?.focus();
  }

  function handleExpenseChipClick(event) {
    const chip = event.target.closest("[data-expense-category]");
    if (!chip) return;
    expenseCategoryFilter = chip.dataset.expenseCategory;
    renderExpenses();
  }

  function readExpenses() {
    return EXPENSES;
  }

  function filteredExpenses(expenses) {
    return expenses.filter((item) => {
      if (expenseCategoryFilter !== "all" && item.category !== expenseCategoryFilter) return false;
      if (!expenseSearchQuery) return true;
      return [item.vendor, item.notes, item.category].some((v) =>
        String(v || "").toLowerCase().includes(expenseSearchQuery)
      );
    });
  }

  function categoryTotals(expenses) {
    const totals = {};
    expenses.forEach((item) => {
      totals[item.category] = (totals[item.category] || 0) + Number(item.amount || 0);
    });
    return totals;
  }

  function renderExpenseChips(totals) {
    const box = $("expenseCategoryChips");
    if (!box) return;
    const used = EXPENSE_CATEGORIES.filter((c) => totals[c]);
    const chips = [{ key: "all", label: "All" }].concat(used.map((c) => ({ key: c, label: c })));
    box.innerHTML = chips.map((c) =>
      `<button type="button" class="chip${expenseCategoryFilter === c.key ? " active" : ""}" data-expense-category="${esc(c.key)}">${esc(c.label)}</button>`
    ).join("");
  }

  function renderExpenseBreakdown(totals) {
    const box = $("expenseBreakdown");
    if (!box) return;
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    box.innerHTML = entries.length
      ? entries.map(([cat, total]) =>
          `<div class="expense-breakdown-item"><span>${esc(cat)}</span><strong>${money(total)}</strong></div>`
        ).join("")
      : "";
  }

  function reclaimBadgeHtml(item) {
    if (!item.cashReclaim) return "";
    const who = item.reclaimFrom || "the other business";
    if (item.reclaimedAt) {
      return `<span class="reclaim-badge is-settled"><svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>Collected from ${esc(who)}</span>`;
    }
    const due = item.reclaimDueAt ? " · due " + esc(reclaimDueShort(item.reclaimDueAt)) : "";
    return `<span class="reclaim-badge"><svg class="icon" aria-hidden="true"><use href="#i-cash"></use></svg>Owed by ${esc(who)}${due}</span>`;
  }

  function reclaimDueShort(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diff = calendarDayDiff(d, new Date());
    if (diff < 0) return `${Math.abs(diff)}d overdue`;
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // Running total of cash the shop has fronted and not yet got back. Sits
  // above the expense list because it's the number the owner actually chases.
  function renderReclaimStrip(expenses) {
    const strip = $("expenseReclaimStrip");
    if (!strip) return;
    const owed = outstandingReclaims(expenses);
    strip.hidden = !owed.length;
    if (!owed.length) return;
    const total = owed.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalEl = $("expenseReclaimTotal");
    if (totalEl) totalEl.textContent = money(total);
    const countEl = $("expenseReclaimCount");
    if (countEl) countEl.textContent = `${owed.length} expense${owed.length === 1 ? "" : "s"}`;
    const listEl = $("expenseReclaimList");
    if (!listEl) return;
    // Anything with a collect-by date first, soonest first; undated after.
    const sorted = owed.slice().sort((a, b) => {
      if (!a.reclaimDueAt && !b.reclaimDueAt) return String(b.date).localeCompare(String(a.date));
      if (!a.reclaimDueAt) return 1;
      if (!b.reclaimDueAt) return -1;
      return new Date(a.reclaimDueAt) - new Date(b.reclaimDueAt);
    });
    listEl.innerHTML = sorted.map((item) => {
      const overdue = item.reclaimDueAt && new Date(item.reclaimDueAt).getTime() < Date.now();
      return `
        <div class="reclaim-strip-row${overdue ? " is-overdue" : ""}">
          <div class="reclaim-strip-main">
            <strong>${money(item.amount)}</strong>
            <span>from ${esc(item.reclaimFrom || "the other business")}</span>
            <small>${esc(item.category)}${item.vendor ? " · " + esc(item.vendor) : ""} · ${esc(formatDate(item.date))}${item.reclaimDueAt ? " · due " + esc(reclaimDueShort(item.reclaimDueAt)) : ""}</small>
          </div>
          <button type="button" class="reclaim-collect-btn" data-expense-collect="${esc(item.id)}" data-collected="false">Collected</button>
        </div>`;
    }).join("");
  }

  function renderExpenses() {
    const list = $("expenseList");
    const total = $("expenseMonthTotal");
    const count = $("expenseCount");
    if (!list && !total) return;
    const expenses = readExpenses().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const currentMonth = monthKey(new Date());
    const monthExpenses = expenses.filter((item) => monthKey(new Date(item.date || Date.now())) === currentMonth);
    const monthTotal = monthExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    if (total) total.textContent = money(monthTotal);

    const totals = categoryTotals(monthExpenses);
    renderExpenseChips(totals);
    renderExpenseBreakdown(totals);
    renderReclaimStrip(expenses);
    renderReclaimFromOptions();

    const visible = filteredExpenses(expenses);
    if (count) {
      count.textContent = expenses.length
        ? `${visible.length} of ${expenses.length} expense${expenses.length === 1 ? "" : "s"}`
        : "No expenses yet";
    }
    if (list) {
      list.innerHTML = visible.length ? visible.map((item) => `
        <article class="ops-row expense-row${item.cashReclaim && !item.reclaimedAt ? " is-owed" : ""}">
          <div>
            <strong>${esc(item.category)} · ${money(item.amount)}</strong>
            <p>${esc(item.vendor || "No vendor")}</p>
            <small>${esc(formatDate(item.date))}${item.notes ? " · " + esc(item.notes) : ""}</small>
            ${reclaimBadgeHtml(item)}
          </div>
          <div class="ops-row-actions">
            ${item.cashReclaim ? `<button type="button" data-expense-collect="${esc(item.id)}" data-collected="${item.reclaimedAt ? "true" : "false"}">${item.reclaimedAt ? "Undo collected" : "Mark collected"}</button>` : ""}
            <button type="button" class="expense-remind-btn" data-expense-remind="${esc(item.id)}">Create reminder</button>
            <button type="button" data-expense-edit="${esc(item.id)}">Edit</button>
            <button type="button" class="danger-text" data-expense-delete="${esc(item.id)}">Delete</button>
          </div>
        </article>
      `).join("") : `<p class="ops-empty">${expenses.length ? "No expenses match the current filters." : "No expenses recorded yet."}</p>`;
    }
  }

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      return parsed == null ? fallback : parsed;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(date) {
    if (!date) return "No date";
    const parsed = new Date(date + "T00:00:00");
    return isNaN(parsed) ? date : parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function formatDateTime(date, time) {
    if (!date) return "No date";
    const parsed = new Date(`${date}T${time || "00:00"}`);
    if (isNaN(parsed)) return [date, time].filter(Boolean).join(" ");
    return parsed.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
      " · " + parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function renderKpis(metrics, loadState) {
    const box = $("dashboardKpis");
    if (!box) return;
    const salesComparison = metrics.salesLastMonth > 0
      ? `${signedPercent(metrics.salesThisMonth, metrics.salesLastMonth)} vs last month`
      : "No last month comparison yet";
    const ticketUnavailable = loadState && loadState.noPin;

    const cards = [
      {
        title: "Sales This Month",
        value: ticketUnavailable ? "—" : money(metrics.salesThisMonth),
        sub: ticketUnavailable ? "Save Check In PIN to load sales" : salesComparison,
        icon: "i-cash",
      },
      {
        title: "Monthly Goal Progress",
        value: ticketUnavailable ? "—" : `${metrics.goalPercent}%`,
        sub: ticketUnavailable ? "Goal data unavailable" : `${money(metrics.salesThisMonth)} / ${money(metrics.goal)}`,
        icon: "i-dashboard",
        progress: ticketUnavailable ? 0 : metrics.goalPercent,
      },
      {
        title: "Active Repairs",
        value: ticketUnavailable ? "—" : String(metrics.activeRepairs.length),
        sub: "Open active repair jobs",
        icon: "i-repair-progress",
        action: "active-repairs",
      },
      {
        title: "Ready for Pickup",
        value: ticketUnavailable ? "—" : String(metrics.readyForPickup.length),
        sub: "Money waiting to be collected",
        icon: "i-alert",
        action: "ready-pickup",
        tone: "urgent",
      },
      {
        title: "Low Stock Alerts",
        value: String(metrics.lowStockItems.length),
        sub: "Open low-stock inventory",
        icon: "i-inventory-flow",
        action: "low-stock",
        tone: "warn",
      },
      {
        title: "Outstanding Payments",
        value: ticketUnavailable ? "—" : money(metrics.outstandingBalance),
        sub: ticketUnavailable ? "Save Check In PIN to load balances" : `${metrics.outstandingTickets.length} customer${metrics.outstandingTickets.length === 1 ? "" : "s"} / job${metrics.outstandingTickets.length === 1 ? "" : "s"}`,
        icon: "i-cash",
      },
    ];

    box.innerHTML = cards.map(cardHtml).join("");
    box.querySelectorAll("[data-dashboard-action]").forEach((card) => {
      card.addEventListener("click", () => runAction(card.dataset.dashboardAction));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          runAction(card.dataset.dashboardAction);
        }
      });
    });
  }

  function cardHtml(card) {
    const actionable = !!card.action;
    return `<article class="dashboard-kpi-card ${card.tone ? "is-" + card.tone : ""} ${actionable ? "is-clickable" : ""}"
        ${actionable ? `data-dashboard-action="${esc(card.action)}" role="button" tabindex="0"` : ""}>
      <div class="dashboard-card-top">
        <span class="dashboard-card-icon"><svg class="icon"><use href="#${esc(card.icon)}"></use></svg></span>
        <span class="dashboard-card-label">${esc(card.title)}</span>
      </div>
      <strong class="dashboard-card-value">${esc(card.value)}</strong>
      ${typeof card.progress === "number" ? `<div class="dashboard-progress" aria-label="${esc(card.title)} progress"><span style="width:${Math.max(0, Math.min(100, card.progress))}%"></span></div>` : ""}
      <span class="dashboard-card-sub">${esc(card.sub)}</span>
    </article>`;
  }

  function renderFocus(metrics, loadState) {
    const box = $("dashboardFocus");
    if (!box) return;
    const date = $("todayFocusDate");
    if (date) date.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    if (loadState && loadState.noPin) {
      box.innerHTML = `<p class="today-focus-empty">Save the Check In PIN in Settings to load repair, payment, and sales focus items.</p>`;
      return;
    }
    const items = [
      {
        label: "Repairs waiting more than 5 days",
        value: metrics.waitingOverFiveDays.length,
        sub: metrics.waitingOverFiveDays.length ? "Follow up or move status today" : "No aged active repairs",
        action: "active-repairs",
      },
      {
        label: "Devices ready for pickup",
        value: metrics.readyForPickup.length,
        sub: "Call customers and collect remaining balances",
        action: "ready-pickup",
      },
      {
        label: "Low stock items",
        value: metrics.lowStockItems.length,
        sub: "Restock before repairs get delayed",
        action: "low-stock",
      },
      {
        label: "Outstanding balances",
        value: money(metrics.outstandingBalance),
        sub: `${metrics.outstandingTickets.length} open balance${metrics.outstandingTickets.length === 1 ? "" : "s"}`,
      },
      {
        label: "Sales needed per day",
        value: "",
        hideValue: true,
        sub: "Use the monthly target above to pace this month",
      },
    ];
    box.innerHTML = items.map(focusItemHtml).join("");
    box.querySelectorAll("[data-dashboard-action]").forEach((btn) => {
      btn.addEventListener("click", () => runAction(btn.dataset.dashboardAction));
    });
  }

  function focusItemHtml(item) {
    return `<button type="${item.action ? "button" : "button"}" class="today-focus-item ${item.action ? "is-clickable" : ""}"
        ${item.action ? `data-dashboard-action="${esc(item.action)}"` : "disabled"}>
      <span>
        <strong>${esc(item.label)}</strong>
        <small>${esc(item.sub)}</small>
      </span>
      ${item.hideValue ? "" : `<b>${esc(String(item.value))}</b>`}
    </button>`;
  }

  function runAction(action) {
    if (action === "active-repairs") {
      window.dispatchEvent(new CustomEvent("rpc-filter-intake", { detail: { filter: "active" } }));
    } else if (action === "ready-pickup") {
      window.dispatchEvent(new CustomEvent("rpc-filter-intake", { detail: { filter: "ready" } }));
    } else if (action === "low-stock") {
      window.dispatchEvent(new CustomEvent("rpc-filter-inventory", { detail: { stock: "low" } }));
    }
  }

  function setStatus(state) {
    const dot = $("dashboardStatusDot");
    const updated = $("dashboardUpdated");
    if (!dot || !updated) return;
    dot.className = "status-dot";
    if (state === "error") dot.classList.add("error");
    if (state === "loading") dot.classList.add("stale");
    if (state === "error") updated.textContent = "Dashboard sync failed";
    else if (!lastUpdated) updated.textContent = "Loading dashboard…";
    else updated.textContent = "Updated " + relativeTime(lastUpdated);
  }

  function monthKey(date) {
    if (!date || isNaN(date)) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function ticketDate(ticket) {
    const date = new Date(ticket.created || ticket.updated || Date.now());
    return isNaN(date) ? new Date() : date;
  }

  function ageInDays(date) {
    return Math.floor((Date.now() - date.getTime()) / 86400000);
  }

  function signedPercent(current, previous) {
    const pct = Math.round(((current - previous) / previous) * 100);
    return `${pct >= 0 ? "+" : ""}${pct}%`;
  }

  function money(value) {
    return "$" + Math.round(Number(value || 0)).toLocaleString();
  }

  function relativeTime(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Targets subnav — mirrors Appointments' .appt-subnav/.appt-panel pattern
  // for consistency (data-targets-panel / data-targets-panel-section).
  // Unscoped (not "#view-targets ...") on purpose, same as appointments.js's
  // setPanel()/bindOnce(): the sidebar flyout copy of these buttons lives in
  // the left <nav>, outside #view-targets, and must stay in sync too.
  let targetsSubnavBound = false;
  function setTargetsPanel(panel) {
    document.querySelectorAll("#view-targets .appt-panel[data-targets-panel-section]").forEach((section) => {
      section.hidden = section.dataset.targetsPanelSection !== panel;
    });
    document.querySelectorAll(".appt-subnav-btn[data-targets-panel]").forEach((btn) => {
      const active = btn.dataset.targetsPanel === panel;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  function bindTargetsSubnavOnce() {
    if (targetsSubnavBound) return;
    targetsSubnavBound = true;
    document.querySelectorAll(".appt-subnav-btn[data-targets-panel]").forEach((btn) => {
      btn.addEventListener("click", () => setTargetsPanel(btn.dataset.targetsPanel));
    });
  }

  /* ---- Reminders (shared staff to-do list) --------------------------- */

  // Offline fallback: the last reminder list the server returned.
  const REMINDERS_CACHE_KEY = "rpc_reminders_cache";
  let REMINDERS = readJson(REMINDERS_CACHE_KEY, []);
  let reminderFilter = "open";
  let reminderSearchText = "";
  let reminderAssigneeFilterValue = "";
  let editingReminderId = null;
  let reminderDuplicateConfirmed = false;
  let REM_TECHNICIANS = [];
  let remTechniciansLoaded = false;
  let selectedTicketForReminder = null; // { id, label }
  const expandedReminderNotes = new Set();

  const REMINDER_PRIORITIES = {
    urgent: "Urgent",
    customer_update: "Customer update",
    parts: "Parts",
    repair: "Repair",
    pickup: "Pickup",
  };

  function setReminders(list) {
    REMINDERS = Array.isArray(list) ? list : [];
    writeJson(REMINDERS_CACHE_KEY, REMINDERS);
  }

  async function remindersApi(payload) {
    const res = await fetch(INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: pin() }, payload)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Rejected");
    return data;
  }

  function notifyReminderError(message) {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message);
    else console.warn(message);
  }

  let remindersLoadInFlight = null;
  // quiet: used by the background alert poll, which runs every minute — a
  // dropped connection there shouldn't put a toast on screen 60 times an hour.
  function loadReminders({ quiet = false } = {}) {
    if (remindersLoadInFlight) return remindersLoadInFlight;
    remindersLoadInFlight = (async () => {
      try {
        const data = await remindersApi({ action: "listReminders" });
        setReminders(data.reminders || []);
        renderReminders();
      } catch (err) {
        console.warn("Couldn't sync reminders:", err);
        if (!quiet) notifyReminderError("Couldn't sync reminders — showing this device's last saved copy.");
      } finally {
        remindersLoadInFlight = null;
      }
    })();
    return remindersLoadInFlight;
  }

  function initReminders() {
    bindReminderFormOnce();
    renderReminders();
    loadReminders();
    loadReminderTechnicians();
  }

  async function loadReminderTechnicians() {
    if (remTechniciansLoaded) return;
    try {
      const res = await fetch(INTAKE_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ pin: pin(), action: "listTechnicians" }),
      });
      const data = await res.json();
      if (data.ok) {
        REM_TECHNICIANS = (data.technicians || [])
          .map((t) => String(t.name || "").trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
      }
    } catch (_) {
      // Offline / no pin yet — assignee dropdown just stays empty.
    } finally {
      remTechniciansLoaded = true;
      renderReminderAssigneeOptions();
    }
  }

  function renderReminderAssigneeOptions() {
    const formSelect = $("reminderAssignee");
    if (formSelect) {
      const current = formSelect.value;
      formSelect.innerHTML = `<option value="">Unassigned</option>` +
        REM_TECHNICIANS.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
      formSelect.value = REM_TECHNICIANS.includes(current) ? current : "";
    }
    const filterSelect = $("reminderAssigneeFilter");
    if (filterSelect) {
      const current = filterSelect.value;
      filterSelect.innerHTML = `<option value="">Everyone</option>` +
        REM_TECHNICIANS.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
      filterSelect.value = REM_TECHNICIANS.includes(current) ? current : "";
    }
  }

  function bindReminderFormOnce() {
    const form = $("reminderForm");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";

    $("reminderNewBtn")?.addEventListener("click", openNewReminderForm);
    $("closeReminderFormModal")?.addEventListener("click", closeReminderForm);
    $("reminderCancelBtn")?.addEventListener("click", closeReminderForm);
    $("reminderSubmit")?.addEventListener("click", saveReminderForm);

    form.querySelectorAll("[data-reminder-preset]").forEach((btn) => {
      btn.addEventListener("click", () => applyReminderPreset(btn.dataset.reminderPreset));
    });

    $("reminderList")?.addEventListener("click", handleReminderListClick);
    $("reminderFilterChips")?.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-reminder-filter]");
      if (!chip) return;
      reminderFilter = chip.dataset.reminderFilter;
      document.querySelectorAll("#reminderFilterChips [data-reminder-filter]").forEach((btn) => {
        const active = btn.dataset.reminderFilter === reminderFilter;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
      renderReminders();
    });

    const searchInput = $("reminderSearch");
    const clearSearchBtn = $("clearReminderSearch");
    searchInput?.addEventListener("input", () => {
      reminderSearchText = searchInput.value.trim().toLowerCase();
      if (clearSearchBtn) clearSearchBtn.hidden = !reminderSearchText;
      renderReminders();
    });
    clearSearchBtn?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      reminderSearchText = "";
      clearSearchBtn.hidden = true;
      renderReminders();
      searchInput?.focus();
    });

    $("reminderAssigneeFilter")?.addEventListener("change", (event) => {
      reminderAssigneeFilterValue = event.target.value;
      renderReminders();
    });

    $("reminderTitleInput")?.addEventListener("input", checkReminderDuplicate);
    bindReminderTicketCombobox();
  }

  // ---- Link-to-ticket combobox in the reminder form ----------------------
  function bindReminderTicketCombobox() {
    const input = $("reminderTicketSearch");
    const dropdown = $("reminderTicketDropdown");
    const combobox = $("reminderTicketCombobox");
    const clearBtn = $("clearReminderTicket");
    if (!input || !dropdown || !combobox) return;

    function ticketMatchLabel(t) {
      const device = t.device || "Device";
      const who = t.customerName || "Unknown customer";
      return `${who} — ${device}`;
    }

    function closeDropdown() {
      dropdown.hidden = true;
      combobox.classList.remove("open");
      input.setAttribute("aria-expanded", "false");
    }

    function renderDropdown(query) {
      const q = query.trim().toLowerCase();
      const matches = (tickets || [])
        .filter((t) => !q || [t.customerName, t.device, t.phone, t.id].some((v) => String(v || "").toLowerCase().includes(q)))
        .slice(0, 8);
      if (!matches.length) {
        dropdown.innerHTML = `<div class="device-dropdown-empty">No matching repairs</div>`;
      } else {
        dropdown.innerHTML = matches.map((t) => `
          <button type="button" class="device-option" role="option" data-ticket-id="${esc(t.id)}" data-ticket-label="${esc(ticketMatchLabel(t))}">
            ${esc(ticketMatchLabel(t))} <span class="rem-notes">#${esc(t.id)}</span>
          </button>`).join("");
      }
      dropdown.hidden = false;
      combobox.classList.add("open");
      input.setAttribute("aria-expanded", "true");
    }

    function selectTicket(id, label) {
      selectedTicketForReminder = id ? { id, label } : null;
      input.value = label || "";
      if (clearBtn) clearBtn.hidden = !id;
      closeDropdown();
    }
    window.RPC_REMINDER_SELECT_TICKET = selectTicket;

    input.addEventListener("input", () => {
      selectedTicketForReminder = null;
      if (clearBtn) clearBtn.hidden = true;
      renderDropdown(input.value);
    });
    input.addEventListener("focus", () => renderDropdown(input.value));
    dropdown.addEventListener("mousedown", (event) => {
      const item = event.target.closest("[data-ticket-id]");
      if (!item) return;
      event.preventDefault();
      selectTicket(item.dataset.ticketId, item.dataset.ticketLabel);
    });
    clearBtn?.addEventListener("click", () => selectTicket("", ""));
    document.addEventListener("click", (event) => {
      if (!combobox.contains(event.target)) closeDropdown();
    });
  }

  // Warn (don't block) when a very similar open reminder already exists.
  function checkReminderDuplicate() {
    const warn = $("reminderDuplicateWarning");
    if (!warn) return;
    reminderDuplicateConfirmed = false;
    const title = ($("reminderTitleInput")?.value || "").trim().toLowerCase();
    if (title.length < 4) { warn.hidden = true; return; }
    const match = REMINDERS.find((item) => {
      if (item.done || item.id === editingReminderId) return false;
      const existing = (item.title || "").trim().toLowerCase();
      if (!existing) return false;
      return existing === title || existing.includes(title) || title.includes(existing);
    });
    if (match) {
      warn.textContent = `A similar open reminder already exists: “${match.title}”.`;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  // Quick due-date picks for staff who don't want to fuss with the datetime
  // field — "today" defaults to end of day, "tomorrow"/"week" to morning.
  function applyReminderPreset(preset) {
    const input = $("reminderDue");
    if (!input) return;
    if (preset === "none") { input.value = ""; return; }
    const d = new Date();
    if (preset === "today") d.setHours(17, 0, 0, 0);
    else if (preset === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    else if (preset === "week") { d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); }
    input.value = toDatetimeLocal(d);
  }

  function resetReminderTicketField(id, label) {
    selectedTicketForReminder = id ? { id, label } : null;
    const input = $("reminderTicketSearch");
    const clearBtn = $("clearReminderTicket");
    if (input) input.value = label || "";
    if (clearBtn) clearBtn.hidden = !id;
    const dropdown = $("reminderTicketDropdown");
    if (dropdown) dropdown.hidden = true;
  }

  function resetReminderSubmitLabel() {
    const submitBtn = $("reminderSubmit");
    if (submitBtn) submitBtn.textContent = "Save reminder";
  }

  function openNewReminderForm() {
    editingReminderId = null;
    reminderDuplicateConfirmed = false;
    $("reminderFormTitle").textContent = "Add reminder";
    $("reminderId").value = "";
    $("reminderTitleInput").value = "";
    $("reminderDue").value = "";
    $("reminderNotes").value = "";
    if ($("reminderPriority")) $("reminderPriority").value = "";
    if ($("reminderAssignee")) $("reminderAssignee").value = "";
    resetReminderTicketField("", "");
    resetReminderSubmitLabel();
    const warn = $("reminderDuplicateWarning");
    if (warn) warn.hidden = true;
    const msg = $("reminderMessage");
    if (msg) { msg.hidden = true; msg.textContent = ""; }
    $("reminderFormModal").hidden = false;
    $("reminderTitleInput")?.focus();
  }

  function editReminder(reminder) {
    if (!reminder) return;
    editingReminderId = reminder.id;
    reminderDuplicateConfirmed = false;
    $("reminderFormTitle").textContent = "Edit reminder";
    $("reminderId").value = reminder.id;
    $("reminderTitleInput").value = reminder.title || "";
    $("reminderDue").value = reminder.dueAt ? toDatetimeLocal(reminder.dueAt) : "";
    $("reminderNotes").value = reminder.notes || "";
    if ($("reminderPriority")) $("reminderPriority").value = reminder.priority || "";
    if ($("reminderAssignee")) $("reminderAssignee").value = reminder.assignee || "";
    resetReminderTicketField(reminder.ticketId || "", reminder.ticketLabel || "");
    resetReminderSubmitLabel();
    const warn = $("reminderDuplicateWarning");
    if (warn) warn.hidden = true;
    const msg = $("reminderMessage");
    if (msg) { msg.hidden = true; msg.textContent = ""; }
    $("reminderFormModal").hidden = false;
    $("reminderTitleInput")?.focus();
  }

  function closeReminderForm() {
    $("reminderFormModal").hidden = true;
    editingReminderId = null;
  }

  async function saveReminderForm() {
    const title = ($("reminderTitleInput")?.value || "").trim();
    const msg = $("reminderMessage");
    if (!title) {
      if (msg) { msg.textContent = "Add a reminder title."; msg.hidden = false; }
      return;
    }
    const warn = $("reminderDuplicateWarning");
    if (warn && !warn.hidden && !reminderDuplicateConfirmed) {
      reminderDuplicateConfirmed = true;
      const submitBtn = $("reminderSubmit");
      if (submitBtn) submitBtn.textContent = "Save anyway";
      return;
    }
    const dueLocal = $("reminderDue")?.value || "";
    const payload = {
      title,
      notes: ($("reminderNotes")?.value || "").trim(),
      dueAt: dueLocal ? new Date(dueLocal).toISOString() : null,
      priority: $("reminderPriority")?.value || "",
      assignee: $("reminderAssignee")?.value || "",
      ticketId: selectedTicketForReminder?.id || "",
      ticketLabel: selectedTicketForReminder?.label || "",
    };
    const submitBtn = $("reminderSubmit");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
    try {
      const data = editingReminderId
        ? await remindersApi({ action: "updateReminder", id: editingReminderId, ...payload })
        : await remindersApi({ action: "addReminder", ...payload });
      setReminders(
        editingReminderId
          ? REMINDERS.map((item) => (item.id === data.reminder.id ? data.reminder : item))
          : [data.reminder].concat(REMINDERS)
      );
    } catch (err) {
      if (msg) { msg.textContent = "Couldn't save the reminder: " + err.message; msg.hidden = false; }
      return;
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save reminder"; }
    }
    closeReminderForm();
    renderReminders();
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST("Saved");
  }

  async function handleReminderListClick(event) {
    const doneBox = event.target.closest("[data-reminder-toggle]");
    const editBtn = event.target.closest("[data-reminder-edit]");
    const deleteBtn = event.target.closest("[data-reminder-delete]");
    const ticketBtn = event.target.closest("[data-reminder-open-ticket]");
    const noteBtn = event.target.closest("[data-reminder-note-toggle]");
    if (noteBtn) {
      const id = noteBtn.dataset.reminderNoteToggle;
      if (expandedReminderNotes.has(id)) expandedReminderNotes.delete(id);
      else expandedReminderNotes.add(id);
      renderReminders();
      return;
    }
    if (ticketBtn) {
      const id = ticketBtn.dataset.reminderOpenTicket;
      if (typeof window.RPC_OPEN_TICKET_BY_ID === "function") window.RPC_OPEN_TICKET_BY_ID(id);
      return;
    }
    if (editBtn && !doneBox) {
      editReminder(REMINDERS.find((item) => item.id === editBtn.dataset.reminderEdit));
      return;
    }
    if (doneBox) {
      const id = doneBox.dataset.reminderToggle;
      const current = REMINDERS.find((item) => item.id === id);
      if (!current) return;
      try {
        const data = await remindersApi({ action: "updateReminder", id, done: !current.done });
        setReminders(REMINDERS.map((item) => (item.id === id ? data.reminder : item)));
        renderReminders();
      } catch (err) {
        notifyReminderError("Couldn't update reminder: " + err.message);
      }
      return;
    }
    if (!deleteBtn) return;
    if (!window.confirm("Delete this reminder?")) return;
    const id = deleteBtn.dataset.reminderDelete;
    try {
      await remindersApi({ action: "deleteReminder", id });
      setReminders(REMINDERS.filter((item) => item.id !== id));
      renderReminders();
    } catch (err) {
      notifyReminderError("Couldn't delete reminder: " + err.message);
    }
  }

  function toDatetimeLocal(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function calendarDayDiff(date, now) {
    return Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  }

  // Human-friendly due label: "Today, 5:00 PM" / "Tomorrow, 9:00 AM" /
  // "Mon, 9:00 AM" within the week / a full date beyond that, with an
  // "Overdue by N days" lead-in once the due time has passed.
  function reminderDueLabel(iso, now) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diff = calendarDayDiff(d, now);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
    if (diff < 0) {
      const days = Math.abs(diff);
      return `Overdue by ${days} day${days === 1 ? "" : "s"} · ${time}`;
    }
    if (diff === 0) return `Today, ${time}`;
    if (diff === 1) return `Tomorrow, ${time}`;
    if (diff < 7) return `${d.toLocaleDateString([], { weekday: "short" })}, ${time}`;
    const sameYear = d.getFullYear() === now.getFullYear();
    return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })}, ${time}`;
  }

  // "Completed 20 min ago" / "Completed yesterday" / a full date once it's old.
  function reminderCompletedLabel(iso, now) {
    if (!iso) return "Completed";
    const d = new Date(iso);
    if (isNaN(d)) return "Completed";
    const minutes = Math.round((now - d) / 60000);
    if (minutes < 1) return "Completed just now";
    if (minutes < 60) return `Completed ${minutes} min${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Completed ${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.abs(calendarDayDiff(d, now));
    if (days === 1) return "Completed yesterday";
    if (days < 7) return `Completed ${days} days ago`;
    const sameYear = d.getFullYear() === now.getFullYear();
    return `Completed ${d.toLocaleDateString([], { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })}`;
  }

  function reminderBucket(item, now) {
    if (!item.dueAt) return "noDue";
    const diff = calendarDayDiff(new Date(item.dueAt), now);
    if (diff < 0) return "overdue";
    if (diff === 0) return "today";
    return "upcoming";
  }

  const REMINDER_SECTION_LABELS = { overdue: "Overdue", today: "Due today", upcoming: "Upcoming", noDue: "No due date", done: "Done" };

  function filteredReminders(reminders) {
    let list = reminders;
    if (reminderFilter === "done") list = list.filter((item) => item.done);
    else if (reminderFilter !== "all") list = list.filter((item) => !item.done);
    if (reminderAssigneeFilterValue) {
      list = list.filter((item) => item.assignee === reminderAssigneeFilterValue);
    }
    if (reminderSearchText) {
      list = list.filter((item) => [item.title, item.notes, item.assignee, item.ticketLabel, REMINDER_PRIORITIES[item.priority], item.kind === "cash_reclaim" ? "cash to collect" : "", item.kind === "appointment" ? "appointment" : ""]
        .some((v) => String(v || "").toLowerCase().includes(reminderSearchText)));
    }
    return list;
  }

  function updateReminderFilterChips(counts) {
    document.querySelectorAll("#reminderFilterChips [data-reminder-filter]").forEach((btn) => {
      const key = btn.dataset.reminderFilter;
      const label = key === "open" ? "Open" : key === "done" ? "Done" : "All";
      btn.textContent = `${label} (${counts[key] || 0})`;
    });
  }

  function reminderEmptyStateHtml() {
    if (reminderFilter === "done") {
      return emptyStateHtml("i-clock", "Nothing completed yet", "Reminders you tick off show up here.");
    }
    if (!REMINDERS.length) {
      return emptyStateHtml("i-clock", "No reminders yet", "Add one to keep the team on track.");
    }
    return emptyStateHtml("i-check", "All caught up", "No open reminders right now.");
  }

  function emptyStateHtml(icon, title, sub) {
    return `<div class="empty-state rem-empty">
      <div class="empty-icon rem-empty-icon"><svg class="icon"><use href="#${icon}"></use></svg></div>
      <p class="empty-title">${esc(title)}</p>
      <p class="empty-sub">${esc(sub)}</p>
    </div>`;
  }

  function reminderRowHtml(item, now) {
    const overdue = !item.done && item.dueAt && new Date(item.dueAt).getTime() < now.getTime();
    const dueLabel = item.done
      ? reminderCompletedLabel(item.doneAt, now)
      : (item.dueAt ? reminderDueLabel(item.dueAt, now) : "");
    const noteExpanded = expandedReminderNotes.has(item.id);
    const tags = [];
    if (item.kind === "cash_reclaim") {
      tags.push(`<span class="rem-tag rem-tag-cash"><svg class="icon" aria-hidden="true" style="width:11px;height:11px"><use href="#i-cash"></use></svg>Cash to collect</span>`);
    }
    if (item.kind === "appointment") {
      tags.push(`<span class="rem-tag rem-tag-appointment"><svg class="icon" aria-hidden="true" style="width:11px;height:11px"><use href="#i-calendar"></use></svg>Appointment</span>`);
    }
    if (item.priority && REMINDER_PRIORITIES[item.priority]) {
      tags.push(`<span class="rem-tag rem-tag-priority pr-${esc(item.priority)}">${esc(REMINDER_PRIORITIES[item.priority])}</span>`);
    }
    if (item.assignee) {
      tags.push(`<span class="rem-tag rem-tag-assignee"><svg class="icon" aria-hidden="true" style="width:11px;height:11px"><use href="#i-user"></use></svg>${esc(item.assignee)}</span>`);
    }
    if (item.ticketId) {
      const ticketLabel = item.ticketLabel || "Linked repair";
      tags.push(`<button type="button" class="rem-tag rem-tag-ticket" data-reminder-open-ticket="${esc(item.ticketId)}" title="${esc(ticketLabel)}">
        <svg class="icon" aria-hidden="true" style="width:11px;height:11px"><use href="#i-clipboard"></use></svg><span class="rem-tag-text">${esc(ticketLabel)}</span>
      </button>`);
    }
    return `
        <article class="rem-item${item.done ? " is-done" : ""}${overdue ? " is-overdue" : ""}">
          <button type="button" class="rem-check" data-reminder-toggle="${esc(item.id)}"
            role="checkbox" aria-checked="${item.done ? "true" : "false"}"
            aria-label="${item.done ? "Mark not done" : "Mark done"}: ${esc(item.title)}">
            <svg class="icon rem-check-mark" aria-hidden="true"><use href="#i-check"></use></svg>
          </button>
          <div class="rem-body-wrap">
            <button type="button" class="rem-body" data-reminder-edit="${esc(item.id)}" aria-label="Edit ${esc(item.title)}">
              <span class="rem-title">${esc(item.title)}</span>
              ${dueLabel ? `<span class="rem-due">${esc(dueLabel)}</span>` : ""}
            </button>
            ${item.notes ? `
              <div class="rem-note-row${noteExpanded ? " is-open" : ""}">
                <span class="rem-note-preview">${noteExpanded ? esc(item.notes) : "Note added"}</span>
                <button type="button" class="rem-note-toggle" data-reminder-note-toggle="${esc(item.id)}" aria-expanded="${noteExpanded ? "true" : "false"}">
                  ${noteExpanded ? "Hide note" : "View note"}
                </button>
              </div>` : ""}
            ${tags.length ? `<div class="rem-tags">${tags.join("")}</div>` : ""}
          </div>
          <button type="button" class="rem-delete" data-reminder-delete="${esc(item.id)}" aria-label="Delete ${esc(item.title)}">
            <svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>
          </button>
        </article>`;
  }

  function renderReminders() {
    const list = $("reminderList");
    const count = $("reminderCount");
    if (!list && !count) return;
    const now = new Date();
    const reminders = REMINDERS.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done && b.done) return new Date(b.doneAt || 0) - new Date(a.doneAt || 0);
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });
    const openCount = reminders.filter((item) => !item.done).length;
    updateReminderFilterChips({ open: openCount, done: reminders.length - openCount, all: reminders.length });

    const visible = filteredReminders(reminders);
    // Apple-style: a single count beside the list title, not a sentence.
    if (count) count.textContent = visible.length ? String(visible.length) : "";
    if (!list) return;

    if (!visible.length) {
      list.innerHTML = reminderEmptyStateHtml();
      return;
    }

    if (reminderFilter === "done") {
      list.innerHTML = `<div class="rem-group-items">${visible.map((item) => reminderRowHtml(item, now)).join("")}</div>`;
      return;
    }

    const buckets = { overdue: [], today: [], upcoming: [], noDue: [], done: [] };
    visible.forEach((item) => {
      buckets[item.done ? "done" : reminderBucket(item, now)].push(item);
    });
    const order = reminderFilter === "all"
      ? ["overdue", "today", "upcoming", "noDue", "done"]
      : ["overdue", "today", "upcoming", "noDue"];

    list.innerHTML = order
      .filter((key) => buckets[key].length)
      .map((key) => `
        <section class="rem-group${key === "overdue" ? " is-overdue-group" : ""}">
          <h3 class="rem-group-title">${esc(REMINDER_SECTION_LABELS[key])}<span class="rem-group-count">${buckets[key].length}</span></h3>
          <div class="rem-group-items">${buckets[key].map((item) => reminderRowHtml(item, now)).join("")}</div>
        </section>`)
      .join("");
  }

  /* ---- On-screen reminder alerts ------------------------------------- */
  // Reminders are only useful if they interrupt you. Once a reminder's due
  // time passes, it pops up as a card over whatever tab is open — the
  // Reminders tab itself is only where you go to manage the list. Snoozes are
  // per-device (localStorage) on purpose: a snooze is "not now, on this
  // screen", not a change to the shared reminder everyone else sees.
  const ALERT_SNOOZE_KEY = "rpc_reminder_alert_snooze";
  const ALERT_POLL_MS = 60000;
  // Reminders load lazily so the first paint stays fast (see the note at the
  // bottom of this file); the alert poller waits for the page to settle
  // before making its first request for the same reason.
  const ALERT_FIRST_RUN_MS = 4000;
  const shownAlertIds = new Set();
  // Cards from the Settings "Test reminder" button. Local to this tab and
  // never written to the server — they exist only to prove the alert works.
  const demoAlerts = [];
  let alertPollTimer = null;

  function readSnoozes() {
    const raw = readJson(ALERT_SNOOZE_KEY, {});
    return raw && typeof raw === "object" ? raw : {};
  }

  function snoozeAlert(id, untilMs, dueAt) {
    const snoozes = readSnoozes();
    snoozes[id] = { until: untilMs, due: dueAt || "" };
    writeJson(ALERT_SNOOZE_KEY, snoozes);
  }

  // Drop snoozes for reminders that are gone or finished, so the store can't
  // grow forever on a tablet that never clears its storage.
  function pruneSnoozes() {
    const snoozes = readSnoozes();
    const live = new Set(REMINDERS.filter((item) => !item.done).map((item) => item.id));
    let changed = false;
    Object.keys(snoozes).forEach((id) => {
      if (!live.has(id)) { delete snoozes[id]; changed = true; }
    });
    if (changed) writeJson(ALERT_SNOOZE_KEY, snoozes);
  }

  function alertIsSilenced(item, now) {
    const entry = readSnoozes()[item.id];
    if (!entry) return false;
    // Re-scheduling a reminder is an explicit "chase me at this new time",
    // which cancels any snooze taken against the old due time.
    if ((entry.due || "") !== (item.dueAt || "")) return false;
    return Number(entry.until || 0) > now;
  }

  function dueReminders(now) {
    return demoAlerts.concat(REMINDERS).filter((item) => {
      if (item.done || !item.dueAt) return false;
      const due = new Date(item.dueAt).getTime();
      if (isNaN(due) || due > now) return false;
      return !alertIsSilenced(item, now);
    });
  }

  function alertStack() {
    let box = document.getElementById("reminderAlerts");
    if (!box) {
      box = document.createElement("div");
      box.id = "reminderAlerts";
      box.className = "reminder-alerts";
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-label", "Reminders due now");
      document.body.appendChild(box);
      box.addEventListener("click", handleAlertClick);
    }
    return box;
  }

  /* ---- Alert chime + speech ------------------------------------------- */
  // Per-device, because "read it out loud" is a decision about the room the
  // screen is in, not about the shared reminder list.
  const ALERT_SOUND_KEY = "rpc_reminder_alert_sound";
  const ALERT_SPEECH_KEY = "rpc_reminder_alert_speech";
  const ALERT_VOICE_KEY = "rpc_reminder_alert_voice";
  let audioCtx = null;

  function alertSoundOn() { return readJson(ALERT_SOUND_KEY, true) !== false; }
  function alertSpeechOn() { return readJson(ALERT_SPEECH_KEY, false) === true; }

  /* ---- Picking a Siri-ish voice ---------------------------------------- */
  // Apple doesn't expose the actual Siri voices to web speech — the closest
  // thing on a Mac or iPhone is Samantha, the American voice Siri was
  // originally built from. Left alone, browsers pick their own default
  // (Daniel, a British male, on macOS), which sounds nothing like Siri, so
  // the voice is chosen deliberately here. Ranked by how close each one is;
  // the "Siri" entries are first in case Apple ever does publish them.
  const SIRI_VOICE_RANK = [
    "siri",
    "samantha",
    "ava",
    "allison",
    "susan",
    "zoe",
    "nicky",
    "karen",
    "serena",
    "moira",
    "tessa",
  ];

  function englishVoices() {
    if (!("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices().filter((v) => /^en\b|^en-/i.test(v.lang));
  }

  // Novelty voices ship on every Mac ("Bubbles", "Zarvox", "Bad News", …) and
  // would be absurd reading out a reminder about money owed. Only offer the
  // ones that read as a person.
  const NOVELTY_VOICES = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|grandma|grandpa)\b/i;

  function selectableVoices() {
    return englishVoices().filter((v) => !NOVELTY_VOICES.test(v.name));
  }

  function rankVoice(voice) {
    const name = voice.name.toLowerCase();
    const index = SIRI_VOICE_RANK.findIndex((candidate) => name.includes(candidate));
    if (index >= 0) return index;
    // Unknown name: still prefer a local US English voice over a remote or
    // non-US one, which is the next best guess at the Siri register.
    return SIRI_VOICE_RANK.length + (/^en-US/i.test(voice.lang) ? 0 : 1) + (voice.localService ? 0 : 2);
  }

  function alertVoice() {
    const voices = selectableVoices();
    if (!voices.length) return null;
    const saved = readJson(ALERT_VOICE_KEY, "");
    if (saved) {
      const match = voices.find((v) => v.name === saved);
      if (match) return match;
    }
    return voices.slice().sort((a, b) => rankVoice(a) - rankVoice(b))[0];
  }

  // A two-note rising tone in the shape of Siri's, rather than a sample file:
  // nothing to download, nothing to 404 on a cached deploy, and it cuts
  // through shop noise without startling. Each note gets a soft attack and a
  // long tail so it rings rather than beeps.
  const CHIME_LEAD_MS = 520;
  function playAlertChime() {
    if (!alertSoundOn()) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      // Browsers start the context suspended until the page has been
      // interacted with; resume() is a no-op once that has happened.
      if (audioCtx.state === "suspended") audioCtx.resume();
      const start = audioCtx.currentTime;
      // G5 then C6 — the rising fourth Siri opens on.
      [[783.99, 0], [1046.5, 0.18]].forEach(([freq, offset]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        // A touch of triangle over a pure sine gives it a glassy edge that
        // carries across a room without getting shrill.
        osc.type = "triangle";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.13, start + offset + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.55);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start + offset);
        osc.stop(start + offset + 0.6);
      });
    } catch (_) {
      // Audio blocked or unavailable — the card on screen is still the alert.
    }
  }

  // Siri leads with "Here's your reminder:" and reads the rest as one calm
  // sentence, so the phrasing follows that rather than barking the title.
  function alertSpeechText(item) {
    // Trim punctuation the title already ends with, so the spoken sentence
    // doesn't come out with a doubled full stop.
    const title = String(item.title || "").replace(/[.!?\s]+$/, "");
    // Money reads better spoken than written: "$210" would otherwise come out
    // as "dollar two hundred and ten" in some voices.
    const spoken = title.replace(/\$([\d,]+(?:\.\d{2})?)/g, (_, amount) => {
      const value = Number(String(amount).replace(/,/g, ""));
      if (!isFinite(value)) return amount;
      const whole = Math.floor(value);
      const cents = Math.round((value - whole) * 100);
      return `${whole} dollar${whole === 1 ? "" : "s"}${cents ? ` and ${cents} cent${cents === 1 ? "" : "s"}` : ""}`;
    });
    const lead = item.kind === "cash_reclaim" ? "Here's your reminder to collect cash"
      : item.kind === "appointment" ? "Here's your reminder about an upcoming appointment"
      : "Here's your reminder";
    return `${lead}. ${spoken}.`;
  }

  function speakAlert(item, { immediate = false } = {}) {
    if (!alertSpeechOn() || !("speechSynthesis" in window)) return;
    const start = () => {
      try {
        const utterance = new SpeechSynthesisUtterance(alertSpeechText(item));
        const voice = alertVoice();
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        // Siri's register: an even, unhurried pace at natural pitch. Slowing
        // it down any further is what makes web speech sound robotic.
        utterance.rate = 1.02;
        utterance.pitch = 1;
        utterance.volume = 1;
        // Cancel anything still being read so two reminders falling due
        // together don't talk over each other.
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch (_) {}
    };
    // Let the chime ring out first, the way Siri's tone precedes her voice.
    if (immediate || !alertSoundOn()) start();
    else setTimeout(start, CHIME_LEAD_MS);
  }

  function announceAlert(item) {
    playAlertChime();
    speakAlert(item);
  }

  function bindAlertPrefsOnce() {
    const soundBox = $("alertSoundToggle");
    const speechBox = $("alertSpeechToggle");
    const testBtn = $("testReminderAlertBtn");
    if (soundBox && !soundBox.dataset.bound) {
      soundBox.dataset.bound = "true";
      soundBox.checked = alertSoundOn();
      soundBox.addEventListener("change", () => {
        writeJson(ALERT_SOUND_KEY, soundBox.checked);
        if (soundBox.checked) playAlertChime();
      });
    }
    if (speechBox && !speechBox.dataset.bound) {
      speechBox.dataset.bound = "true";
      speechBox.checked = alertSpeechOn();
      speechBox.addEventListener("change", () => {
        writeJson(ALERT_SPEECH_KEY, speechBox.checked);
        renderVoiceOptions();
        // Sample it straight away, and skip the chime lead-in — this is a
        // preview of the voice, not a reminder going off.
        if (speechBox.checked) speakAlert({ title: "Call the supplier about the screen order", kind: "" }, { immediate: true });
      });
    }
    bindVoicePickerOnce();
    if (testBtn && !testBtn.dataset.bound) {
      testBtn.dataset.bound = "true";
      testBtn.addEventListener("click", fireTestAlert);
    }
    const note = $("alertPrefsNote");
    if (note && !("speechSynthesis" in window)) {
      note.textContent = "This browser can't read reminders out loud — the chime and the on-screen card still work.";
      note.hidden = false;
    }
  }

  // Which voices exist differs by device and even by browser on the same
  // device, so the auto-picked one is offered as a default rather than
  // imposed — someone who prefers a different voice can say so.
  function renderVoiceOptions() {
    const field = $("alertVoiceField");
    const select = $("alertVoiceSelect");
    const help = $("alertVoiceHelp");
    if (!field || !select) return;
    const voices = selectableVoices();
    field.hidden = !alertSpeechOn() || !voices.length;
    if (field.hidden) return;
    const best = voices.slice().sort((a, b) => rankVoice(a) - rankVoice(b))[0];
    const saved = readJson(ALERT_VOICE_KEY, "");
    select.innerHTML = `<option value="">Closest to Siri (${esc(best ? best.name : "automatic")})</option>` +
      voices.slice().sort((a, b) => rankVoice(a) - rankVoice(b))
        .map((v) => `<option value="${esc(v.name)}">${esc(v.name)} — ${esc(v.lang)}</option>`).join("");
    select.value = saved && voices.some((v) => v.name === saved) ? saved : "";
    if (help) {
      help.textContent = "Apple keeps the real Siri voices off the web, so this picks the closest system voice available on this device.";
    }
  }

  function bindVoicePickerOnce() {
    const select = $("alertVoiceSelect");
    if (!select || select.dataset.bound) return;
    select.dataset.bound = "true";
    select.addEventListener("change", () => {
      writeJson(ALERT_VOICE_KEY, select.value);
      speakAlert({ title: "Call the supplier about the screen order", kind: "" }, { immediate: true });
    });
    // getVoices() is empty until the browser has loaded its voice list, which
    // on Chrome happens after first paint — rebuild the menu when it lands.
    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", renderVoiceOptions);
    }
    renderVoiceOptions();
  }

  // A real card, driven through the same render path as a genuine reminder,
  // so the test proves the actual alert works rather than a mock of it.
  function fireTestAlert() {
    const demo = {
      id: "DEMO:" + Date.now(),
      title: "Test reminder — this is how an alert looks",
      notes: "Dismiss it with the ✕, or tick it off. Nothing was saved to the shared list.",
      dueAt: new Date(Date.now() - 1000).toISOString(),
      done: false,
      assignee: "",
      priority: "",
      ticketId: "",
      kind: "",
      amount: null,
      expenseId: "",
    };
    demoAlerts.push(demo);
    renderAlerts();
  }

  function alertCardHtml(item, now) {
    const cash = item.kind === "cash_reclaim";
    const appt = item.kind === "appointment";
    const overdueMs = now - new Date(item.dueAt).getTime();
    const late = overdueMs > 60000 ? reminderDueLabel(item.dueAt, new Date(now)) : "Due now";
    const meta = [];
    if (item.assignee) meta.push(esc(item.assignee));
    if (item.priority && REMINDER_PRIORITIES[item.priority]) meta.push(esc(REMINDER_PRIORITIES[item.priority]));
    const icon = cash ? "i-cash" : appt ? "i-calendar" : "i-clock";
    const eyebrow = cash ? "Cash to collect" : appt ? "Appointment coming up" : "Reminder";
    const openLabel = cash ? "Expenses" : appt ? "Appointments" : "Open reminders";
    return `
      <article class="reminder-alert${cash ? " is-cash" : ""}${appt ? " is-appointment" : ""}" data-alert-id="${esc(item.id)}">
        <div class="reminder-alert-head">
          <span class="reminder-alert-icon"><svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg></span>
          <div class="reminder-alert-heading">
            <p class="reminder-alert-eyebrow">${eyebrow}${meta.length ? " · " + meta.join(" · ") : ""}</p>
            <h4 class="reminder-alert-title">${esc(item.title)}</h4>
            <p class="reminder-alert-due">${esc(late)}</p>
          </div>
          <button type="button" class="reminder-alert-close" data-alert-snooze="60" aria-label="Dismiss for an hour">
            <svg class="icon" aria-hidden="true"><use href="#i-xmark"></use></svg>
          </button>
        </div>
        ${item.notes ? `<p class="reminder-alert-notes">${esc(item.notes)}</p>` : ""}
        <div class="reminder-alert-actions">
          <button type="button" class="primary-btn reminder-alert-done" data-alert-done="1">${cash ? "Collected" : "Mark done"}</button>
          ${item.ticketId ? `<button type="button" class="ghost-btn" data-alert-ticket="${esc(item.ticketId)}">Open repair</button>` : ""}
          <button type="button" class="ghost-btn" data-alert-open="1">${openLabel}</button>
        </div>
        <div class="reminder-alert-snooze">
          <span>Snooze</span>
          <button type="button" class="chip" data-alert-snooze="15">15 min</button>
          <button type="button" class="chip" data-alert-snooze="60">1 hour</button>
          <button type="button" class="chip" data-alert-snooze="tomorrow">Tomorrow</button>
        </div>
      </article>`;
  }

  function renderAlerts() {
    const now = Date.now();
    const due = dueReminders(now).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const box = document.getElementById("reminderAlerts");
    if (!due.length) {
      shownAlertIds.clear();
      if (box) { box.innerHTML = ""; box.dataset.signature = ""; box.hidden = true; }
      updateReminderNavBadge(0);
      return;
    }
    const stack = alertStack();
    stack.hidden = false;
    // Only a few at a time — a wall of cards is as easy to ignore as none,
    // and on a phone two full-width cards already fill most of the screen.
    const visible = due.slice(0, window.innerWidth < 640 ? 2 : 3);
    const signature = visible.map((item) => item.id + ":" + item.dueAt).join("|");
    if (stack.dataset.signature !== signature) {
      stack.dataset.signature = signature;
      stack.innerHTML = visible.map((item) => alertCardHtml(item, now)).join("") +
        (due.length > visible.length ? `<button type="button" class="reminder-alert-more" data-alert-open="1">+${due.length - visible.length} more due</button>` : "");
      // Only actually-new cards make a sound — a re-render because one card
      // was snoozed must not re-announce the ones that were already showing.
      const fresh = visible.filter((item) => !shownAlertIds.has(item.id));
      visible.forEach((item) => shownAlertIds.add(item.id));
      if (fresh.length) announceAlert(fresh[0]);
    }
    updateReminderNavBadge(due.length);
  }

  function updateReminderNavBadge(count) {
    document.querySelectorAll('.nav-btn[data-target="reminders"]').forEach((btn) => {
      let badge = btn.querySelector(".nav-badge");
      if (!count) { badge?.remove(); return; }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "nav-badge";
        btn.appendChild(badge);
      }
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.setAttribute("aria-label", `${count} reminder${count === 1 ? "" : "s"} due`);
    });
  }

  function isDemoAlert(id) {
    return String(id || "").startsWith("DEMO:");
  }

  function dropDemoAlert(id) {
    const index = demoAlerts.findIndex((item) => item.id === id);
    if (index >= 0) demoAlerts.splice(index, 1);
    shownAlertIds.delete(id);
  }

  async function handleAlertClick(event) {
    const card = event.target.closest("[data-alert-id]");
    const openBtn = event.target.closest("[data-alert-open]");
    const ticketBtn = event.target.closest("[data-alert-ticket]");
    const snoozeBtn = event.target.closest("[data-alert-snooze]");
    const doneBtn = event.target.closest("[data-alert-done]");
    const id = card?.dataset.alertId;
    const item = id ? demoAlerts.concat(REMINDERS).find((r) => r.id === id) : null;

    if (ticketBtn) {
      if (typeof window.RPC_OPEN_TICKET_BY_ID === "function") window.RPC_OPEN_TICKET_BY_ID(ticketBtn.dataset.alertTicket);
      return;
    }
    if (openBtn) {
      const target = item && item.kind === "cash_reclaim" ? "expenses" : item && item.kind === "appointment" ? "appointments" : "reminders";
      if (typeof window.RPC_SHOW_VIEW === "function") window.RPC_SHOW_VIEW(target);
      return;
    }
    if (snoozeBtn) {
      if (!item) return;
      if (isDemoAlert(item.id)) { dropDemoAlert(item.id); renderAlerts(); return; }
      const value = snoozeBtn.dataset.alertSnooze;
      let until;
      if (value === "tomorrow") {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        until = d.getTime();
      } else {
        until = Date.now() + Number(value) * 60000;
      }
      snoozeAlert(item.id, until, item.dueAt);
      shownAlertIds.delete(item.id);
      renderAlerts();
      return;
    }
    if (!doneBtn || !item) return;
    if (isDemoAlert(item.id)) { dropDemoAlert(item.id); renderAlerts(); return; }
    doneBtn.disabled = true;
    try {
      const data = await remindersApi({ action: "updateReminder", id: item.id, done: true });
      setReminders(REMINDERS.map((r) => (r.id === item.id ? data.reminder : r)));
      renderReminders();
      renderAlerts();
      // A cash reclaim just settled its expense server-side.
      if (item.kind === "cash_reclaim") loadExpenses();
      if (typeof window.RPC_TOAST === "function") {
        window.RPC_TOAST(item.kind === "cash_reclaim" ? "Cash marked as collected" : "Reminder done", { tone: "info", duration: 3000 });
      }
    } catch (err) {
      doneBtn.disabled = false;
      notifyReminderError("Couldn't update reminder: " + err.message);
    }
  }

  // Poll rather than push: this app talks to a serverless API with no socket,
  // and a minute of lag on a shop to-do is fine. Polling pauses while the tab
  // is hidden and catches up the moment it comes back.
  async function pollReminderAlerts() {
    // Only the network side backs off while the tab is in the background —
    // the render always runs, so a due card is already on screen the moment
    // someone comes back, and an embedded/webview context that never reports
    // itself visible still gets its alerts. No PIN means the API would reject
    // us anyway; the cached list is rendered either way.
    if (!document.hidden && pin()) await loadReminders({ quiet: true });
    pruneSnoozes();
    renderAlerts();
  }

  function startReminderAlerts() {
    if (alertPollTimer) return;
    bindAlertPrefsOnce();
    setTimeout(() => { pollReminderAlerts(); }, ALERT_FIRST_RUN_MS);
    alertPollTimer = setInterval(pollReminderAlerts, ALERT_POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollReminderAlerts();
    });
    // A due time can pass without any new data arriving, so re-render on a
    // shorter beat than the network poll.
    setInterval(renderAlerts, 15000);
  }

  // Lets the expense screens (and anything else that writes a reminder
  // server-side) pull the list and re-evaluate what should be on screen.
  window.RPC_REFRESH_REMINDERS = async () => {
    await loadReminders();
    renderAlerts();
  };

  startReminderAlerts();

  window.addEventListener("rpc-enter-reminders", initReminders);

  window.addEventListener("rpc-enter-dashboard", () => loadDashboard({ force: true }));
  window.addEventListener("rpc-enter-targets", () => {
    bindTargetsSubnavOnce();
    renderGoalEditor({ goal: monthlyGoal() });
    // Refresh ticket data so the progress strip reflects today's sales,
    // then re-render the strip once the fresh numbers land.
    loadDashboard().then(() => renderTargetProgress());
  });
  window.addEventListener("rpc-enter-expenses", initExpenses);
  window.addEventListener("rpc-tickets", (event) => {
    tickets = (event.detail?.tickets || []).map(normalizeTicket);
    render({});
  });
  window.addEventListener("rpc-inventory", (event) => {
    inventoryItems = (event.detail?.items || []).map(normalizeInventoryItem);
    render({});
  });

  // Dashboard and Expenses both start hidden (Prices is the default view), so
  // their data is fetched lazily by the "rpc-enter-*" listeners above rather
  // than at boot — eagerly loading tickets, monthly sales and inventory here
  // put three requests on the critical path for a tab the user usually isn't
  // looking at, which is what made the first paint slow on mobile. The
  // last-view restore in intake.js goes through navigateTo(), so it still
  // fires rpc-enter-dashboard when Dashboard *is* the tab being reopened.
  renderGoalEditor({ goal: monthlyGoal() });
})();
