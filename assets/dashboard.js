/* ============================================================
   Business dashboard — top-level repair shop KPIs. Reads the
   existing Check In and Inventory APIs without changing their data layer.
   ============================================================ */

(function () {
  const INTAKE_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  const GOAL_KEY = "rpc_monthly_sales_goal";
  const DEFAULT_MONTHLY_GOAL = 80000;
  const ACTIVE_STATUSES = new Set(["Received", "Diagnosing", "Waiting for Parts", "In Progress"]);
  const FINAL_STATUSES = new Set(["Picked Up", "Cancelled"]);
  const $ = (id) => document.getElementById(id);

  let tickets = [];
  let inventoryItems = [];
  let lastUpdated = null;
  let loadInFlight = null;

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

  async function loadDashboard({ force = false } = {}) {
    if (loadInFlight && !force) return loadInFlight;
    loadInFlight = (async () => {
      setStatus("loading");
      const hasPin = !!pin();
      const ticketPromise = hasPin ? loadTickets() : Promise.resolve({ tickets: [], noPin: true });
      const inventoryPromise = loadInventory();
      const [ticketData, inventoryData] = await Promise.allSettled([ticketPromise, inventoryPromise]);

      if (ticketData.status === "fulfilled") tickets = ticketData.value.tickets || [];
      if (inventoryData.status === "fulfilled") inventoryItems = inventoryData.value.items || [];

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
    const salesLastMonth = tickets
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
    const daysLeft = daysRemainingInMonth(now);
    const remainingSales = Math.max(0, goal - salesThisMonth);

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
      salesNeededPerDay: daysLeft > 0 ? Math.ceil(remainingSales / daysLeft) : remainingSales,
    };
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
        icon: "i-tools",
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
        value: money(metrics.salesNeededPerDay),
        sub: "To hit this month’s target",
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
      <b>${esc(String(item.value))}</b>
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

  function daysRemainingInMonth(date) {
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return Math.max(1, last - date.getDate() + 1);
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

  window.addEventListener("rpc-enter-dashboard", () => loadDashboard({ force: true }));
  window.addEventListener("rpc-tickets", (event) => {
    tickets = (event.detail?.tickets || []).map(normalizeTicket);
    render({});
  });
  window.addEventListener("rpc-inventory", (event) => {
    inventoryItems = (event.detail?.items || []).map(normalizeInventoryItem);
    render({});
  });

  loadDashboard();
})();
