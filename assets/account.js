/* ============================================================
   Account — bank funds, plus the Expenses panel.

   The card payments/payouts ledger this tab used to track (the card
   machine's takings, held elsewhere until transferred across) has
   been retired: no more UI to log a swipe or record a transfer, and
   lib/tickets.js no longer accepts "card" as a new payment method.
   The historical data and its backend (lib/card-payments.js,
   lib/payouts.js) are untouched — only the reachable-from-the-app
   surface is gone.

   Expenses lives in this tab too, as its own panel, unchanged and
   still driven by assets/dashboard.js.
   ============================================================ */

(function () {
  const SCRIPT_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  // Offline fallback: the last list the server returned, so opening the tab
  // on a phone with one bar shows yesterday's ledger instead of nothing.
  const BANK_CACHE_KEY = "rpc_bank_transactions_cache";
  const LS_LAST_PANEL = "rpc_account_panel";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Cents matter here in a way they don't on the dashboard: a debit fee is
  // $0.75, so rounding to whole dollars would erase the entire charge.
  function money(value) {
    const n = Number(value || 0);
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  let BANK_TRANSACTIONS = readCache(BANK_CACHE_KEY);
  let BANK_SUMMARY = null;
  // Bank and cash are the same ledger (bank_transactions.account_type),
  // browsed one side at a time — "bank" is the default so nothing changes
  // for anyone who never touches cash.
  let bankAccountFilter = "bank";
  let bankKindFilter = "all";
  let bankSearchQuery = "";
  let bankEditingId = null;
  let bound = false;
  let loadedOnce = false;

  function readCache(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      return parsed == null ? (fallback === undefined ? [] : fallback) : parsed;
    } catch (_) {
      return fallback === undefined ? [] : fallback;
    }
  }
  function writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage unavailable */ }
  }

  async function api(payload) {
    const pin = localStorage.getItem(LS_PIN) || "";
    // text/plain avoids a CORS preflight, matching how Check-In calls the API.
    const res = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin }, payload)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Rejected");
    return data;
  }

  function toast(message) {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message);
    else console.warn(message);
  }

  // ---- Dates ---------------------------------------------------------------
  // The shop and its staff are in the same timezone as the device, so local
  // time is shop time and no conversion is needed on this side. The server
  // does the Port of Spain arithmetic that actually matters (settlement day).
  function pad2(n) { return String(n).padStart(2, "0"); }
  function toDateInput(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function formatDay(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  function setMessage(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // ---- Loading -------------------------------------------------------------
  let loadInFlight = null;
  function loadAll(force) {
    if (loadInFlight) return loadInFlight;
    if (loadedOnce && !force) return Promise.resolve();
    loadInFlight = (async () => {
      const [bankTransactions, bankSummary] = await Promise.allSettled([
        api({ action: "listBankTransactions" }),
        api({ action: "bankAccountSummary" }),
      ]);
      if (bankTransactions.status === "fulfilled") {
        BANK_TRANSACTIONS = bankTransactions.value.transactions || [];
        writeCache(BANK_CACHE_KEY, BANK_TRANSACTIONS);
      }
      if (bankSummary.status === "fulfilled") BANK_SUMMARY = bankSummary.value.summary;
      const failure = [bankTransactions, bankSummary].find((r) => r.status === "rejected");
      if (failure && !BANK_TRANSACTIONS.length) toast("Couldn't load the account: " + failure.reason.message);
      loadedOnce = true;
      renderAll();
    })().finally(() => { loadInFlight = null; });
    return loadInFlight;
  }

  function renderAll() {
    renderBankAccount();
  }

  // ---- Bank account -------------------------------------------------------
  // Same shape bankAccountSummary() returns server-side — one account type's
  // worth of balance/flow figures, computed from whatever's cached locally.
  function accountSummaryFromCache(accountType) {
    const items = BANK_TRANSACTIONS.filter((item) => (item.accountType || "bank") === accountType);
    const month = new Date().toISOString().slice(0, 7);
    const deposits = items.filter((item) => item.kind === "deposit" && String(item.occurredAt).slice(0, 7) === month)
      .reduce((total, item) => total + Number(item.amount || 0), 0);
    const withdrawals = items.filter((item) => item.kind === "withdrawal" && String(item.occurredAt).slice(0, 7) === month)
      .reduce((total, item) => total + Number(item.amount || 0), 0);
    return {
      balance: items.reduce((total, item) => total + (item.kind === "deposit" ? 1 : -1) * Number(item.amount || 0), 0),
      depositsThisMonth: deposits,
      withdrawalsThisMonth: withdrawals,
      transactionCount: items.length,
      lastActivity: items[0]?.occurredAt || null,
    };
  }

  function bankSummaryFromCache() {
    const bank = accountSummaryFromCache("bank");
    return {
      ...bank,
      netChangeThisMonth: bank.depositsThisMonth - bank.withdrawalsThisMonth,
      cash: accountSummaryFromCache("cash"),
    };
  }

  function renderBankAccount() {
    const summary = BANK_SUMMARY || bankSummaryFromCache();
    const cash = summary.cash || { balance: 0, lastActivity: null };
    const setText = (id, value) => { const element = $(id); if (element) element.textContent = value; };
    setText("bankBalance", money(summary.balance));
    setText("bankDeposits", money(summary.depositsThisMonth));
    setText("bankWithdrawals", money(summary.withdrawalsThisMonth));
    setText("cashBalance", money(cash.balance));
    setText("bankBalanceSub", summary.lastActivity ? `Last activity ${formatDay(summary.lastActivity)}` : "No activity yet");
    setText("cashBalanceSub", cash.lastActivity ? `Last activity ${formatDay(cash.lastActivity)}` : "No activity yet");
    $("bankBalance")?.classList.toggle("money-negative", Number(summary.balance) < 0);
    $("cashBalance")?.classList.toggle("money-negative", Number(cash.balance) < 0);
    // Same transfer either way, but "Deposit to account" reads right while
    // looking at cash on hand — "Deposit cash to bank" only makes sense from
    // the bank side, where "to bank" isn't already implied by the tab you're on.
    setText("cashToBankBtn", bankAccountFilter === "cash" ? "Deposit to account" : "Deposit cash to bank");

    document.querySelectorAll("[data-bank-account]").forEach((button) => {
      const active = button.dataset.bankAccount === bankAccountFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-bank-kind]").forEach((button) => {
      const active = button.dataset.bankKind === bankKindFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    // The summary tiles are a second way to reach the same account+kind
    // filter the chips drive — clicking either moves the same state, so they
    // stay in sync and highlight together. "Current balance"/"Cash on hand"
    // have no kind of their own, so they open onto everything for that side.
    document.querySelectorAll("[data-tile-account]").forEach((tile) => {
      const active = tile.dataset.tileAccount === bankAccountFilter && tile.dataset.tileKind === bankKindFilter;
      tile.classList.toggle("is-active-filter", active);
    });
    const eyebrow = $("bankLedgerEyebrow");
    if (eyebrow) eyebrow.textContent = bankAccountFilter === "cash" ? "Cash ledger" : "Bank ledger";

    const query = bankSearchQuery.trim().toLowerCase();
    const scoped = BANK_TRANSACTIONS.filter((item) => (item.accountType || "bank") === bankAccountFilter);
    const visible = scoped.filter((item) => {
      if (bankKindFilter !== "all" && item.kind !== bankKindFilter) return false;
      return !query || [item.category, item.reference, item.notes].some((value) => String(value || "").toLowerCase().includes(query));
    });
    setText("bankTransactionCount", scoped.length ? `${visible.length} of ${scoped.length} transaction${scoped.length === 1 ? "" : "s"}` : `No ${bankAccountFilter} transactions yet`);
    const list = $("bankTransactionList");
    if (!list) return;
    if (!visible.length) {
      list.innerHTML = `<p class="ops-empty">${scoped.length ? "No transactions match this filter." : bankAccountFilter === "cash" ? "Record a cash deposit or withdrawal to begin." : "Add your current balance as an opening deposit to begin."}</p>`;
      return;
    }
    list.innerHTML = visible.map((item) => `
      <article class="ops-row acct-row bank-transaction-row">
        <div>
          <strong>${esc(item.category || (item.kind === "deposit" ? "Deposit" : "Withdrawal"))}</strong>
          <p>${esc(formatDay(item.occurredAt))}${item.reference ? ` · ${esc(item.reference)}` : ""}</p>
          ${item.notes ? `<small>${esc(item.notes)}</small>` : ""}
        </div>
        <div class="acct-row-side">
          <strong class="bank-amount bank-amount-${item.kind}">${item.kind === "deposit" ? "+" : "−"}${money(item.amount)}</strong>
          <span class="acct-pill bank-pill-${item.kind}">${item.kind === "deposit" ? "Deposit" : "Withdrawal"}</span>
          <span class="acct-pill acct-pill-${item.accountType || "bank"}">${item.accountType === "cash" ? "Cash" : "Bank"}</span>
          ${item.transferId ? `<span class="acct-pill acct-pill-transfer">Transfer</span>` : ""}
          <div class="ops-row-actions"><button type="button" data-bank-edit="${esc(item.id)}">Edit</button><button type="button" class="danger-text" data-bank-delete="${esc(item.id)}">Delete</button></div>
        </div>
      </article>`).join("");
  }

  let bankTransactionAccountType = "bank";

  function setBankTransactionAccountType(type) {
    bankTransactionAccountType = type === "cash" ? "cash" : "bank";
    document.querySelectorAll("[data-account-type]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.accountType === bankTransactionAccountType);
    });
  }

  function openBankTransactionModal(kind, transaction) {
    bankEditingId = transaction?.id || null;
    const selectedKind = transaction?.kind || (kind === "withdrawal" ? "withdrawal" : "deposit");
    $("bankTransactionTitle").textContent = transaction ? "Edit bank transaction" : selectedKind === "deposit" ? "Add deposit" : "Record withdrawal";
    $("bankTransactionSubmit").textContent = transaction ? "Save changes" : selectedKind === "deposit" ? "Save deposit" : "Save withdrawal";
    $("bankTransactionId").value = bankEditingId || "";
    $("bankTransactionKind").value = selectedKind;
    updateBankTransactionKindUI(selectedKind);
    // New entries default to whichever ledger is currently on screen — the
    // common case is adding to the one you're already looking at.
    setBankTransactionAccountType(transaction ? transaction.accountType || "bank" : bankAccountFilter);
    $("bankTransactionAmount").value = transaction ? Number(transaction.amount).toFixed(2) : "";
    $("bankTransactionDate").value = toDateInput(transaction?.occurredAt || new Date());
    $("bankTransactionCategory").value = transaction?.category || (BANK_TRANSACTIONS.length ? "" : "Opening balance");
    $("bankTransactionReference").value = transaction?.reference || "";
    $("bankTransactionNotes").value = transaction?.notes || "";
    setMessage("bankTransactionMessage", "");
    $("bankTransactionModal").hidden = false;
    setTimeout(() => $("bankTransactionAmount").focus(), 50);
  }

  function updateBankTransactionKindUI(kind) {
    const label = $("bankTransactionCategoryLabel");
    const input = $("bankTransactionCategory");
    if (!label || !input) return;
    const withdrawal = kind === "withdrawal";
    label.textContent = withdrawal ? "Merchant name" : "Category";
    input.placeholder = withdrawal ? "e.g. Courts, Massy Stores" : "e.g. Sales, rent";
    if (withdrawal) {
      renderMerchantOptions();
      input.setAttribute("list", "bankMerchantOptions");
    } else {
      input.setAttribute("list", "bankCategoryOptions");
    }
    input.setAttribute("aria-label", withdrawal ? "Merchant name" : "Category");
  }

  function renderMerchantOptions() {
    const list = $("bankMerchantOptions");
    if (!list) return;
    const merchants = [...new Set(BANK_TRANSACTIONS
      .filter((item) => item.kind === "withdrawal" && String(item.category || "").trim())
      .map((item) => String(item.category).trim()))]
      .sort((a, b) => a.localeCompare(b));
    list.innerHTML = merchants.map((merchant) => `<option value="${esc(merchant)}"></option>`).join("");
  }

  function closeBankTransactionModal() {
    $("bankTransactionModal").hidden = true;
    bankEditingId = null;
  }

  async function submitBankTransaction() {
    const amount = Number($("bankTransactionAmount").value || 0);
    if (amount <= 0) return setMessage("bankTransactionMessage", "Enter an amount greater than zero.");
    const date = $("bankTransactionDate").value;
    if (!date) return setMessage("bankTransactionMessage", "Choose the transaction date.");
    const wasEditing = !!bankEditingId;
    const button = $("bankTransactionSubmit");
    button.disabled = true;
    try {
      await api({
        action: wasEditing ? "updateBankTransaction" : "addBankTransaction",
        id: bankEditingId || undefined,
        kind: $("bankTransactionKind").value,
        accountType: bankTransactionAccountType,
        amount,
        occurredAt: new Date(`${date}T12:00:00`).toISOString(),
        category: $("bankTransactionCategory").value.trim(),
        reference: $("bankTransactionReference").value.trim(),
        notes: $("bankTransactionNotes").value.trim(),
      });
      closeBankTransactionModal();
      BANK_SUMMARY = null;
      await loadAll(true);
      toast(wasEditing ? `${bankTransactionAccountType === "cash" ? "Cash" : "Bank"} transaction updated` : `${bankTransactionAccountType === "cash" ? "Cash" : "Bank"} transaction saved`);
    } catch (error) {
      setMessage("bankTransactionMessage", error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteBankTransaction(id) {
    const transaction = BANK_TRANSACTIONS.find((item) => item.id === id);
    if (!transaction) return;
    const prompt = transaction.transferId
      ? `Delete this cash-to-bank transfer of ${money(transaction.amount)}? Both the cash and bank sides will be removed.`
      : `Delete this ${transaction.kind} of ${money(transaction.amount)}?`;
    if (!window.confirm(prompt)) return;
    try {
      await api({ action: "deleteBankTransaction", id });
      BANK_SUMMARY = null;
      await loadAll(true);
      toast(transaction.transferId ? "Transfer deleted" : "Bank transaction deleted");
    } catch (error) {
      toast(error.message);
    }
  }

  // ---- Cash-to-bank transfer -----------------------------------------------
  function openCashToBankModal() {
    $("cashToBankAmount").value = "";
    $("cashToBankDate").value = toDateInput(new Date());
    $("cashToBankNotes").value = "";
    setMessage("cashToBankMessage", "");
    $("cashToBankModal").hidden = false;
    setTimeout(() => $("cashToBankAmount").focus(), 50);
  }

  function closeCashToBankModal() {
    $("cashToBankModal").hidden = true;
  }

  async function submitCashToBank() {
    const amount = Number($("cashToBankAmount").value || 0);
    if (amount <= 0) return setMessage("cashToBankMessage", "Enter an amount greater than zero.");
    const date = $("cashToBankDate").value;
    if (!date) return setMessage("cashToBankMessage", "Choose the transfer date.");
    const button = $("cashToBankSubmit");
    button.disabled = true;
    try {
      await api({
        action: "addCashDepositToBank",
        amount,
        occurredAt: new Date(`${date}T12:00:00`).toISOString(),
        notes: $("cashToBankNotes").value.trim(),
      });
      closeCashToBankModal();
      BANK_SUMMARY = null;
      await loadAll(true);
      toast("Cash deposited to bank");
    } catch (error) {
      setMessage("cashToBankMessage", error.message);
    } finally {
      button.disabled = false;
    }
  }

  // ---- Wiring --------------------------------------------------------------
  function bind() {
    if (bound) return;
    bound = true;

    $("bankDepositBtn")?.addEventListener("click", () => openBankTransactionModal("deposit"));
    $("bankWithdrawalBtn")?.addEventListener("click", () => openBankTransactionModal("withdrawal"));
    $("cashToBankBtn")?.addEventListener("click", openCashToBankModal);
    $("closeCashToBankModal")?.addEventListener("click", closeCashToBankModal);
    $("cashToBankCancel")?.addEventListener("click", closeCashToBankModal);
    $("cashToBankSubmit")?.addEventListener("click", submitCashToBank);
    $("cashToBankForm")?.addEventListener("submit", (event) => { event.preventDefault(); submitCashToBank(); });
    $("closeBankTransactionModal")?.addEventListener("click", closeBankTransactionModal);
    $("bankTransactionCancel")?.addEventListener("click", closeBankTransactionModal);
    $("bankTransactionSubmit")?.addEventListener("click", submitBankTransaction);
    $("bankTransactionKind")?.addEventListener("change", (event) => updateBankTransactionKindUI(event.target.value));
    $("bankTransactionForm")?.addEventListener("submit", (event) => { event.preventDefault(); submitBankTransaction(); });
    $("bankTransactionAccountChips")?.addEventListener("click", (event) => {
      const type = event.target.closest("[data-account-type]")?.dataset.accountType;
      if (type) setBankTransactionAccountType(type);
    });
    $("bankAccountChips")?.addEventListener("click", (event) => {
      const account = event.target.closest("[data-bank-account]")?.dataset.bankAccount;
      if (!account) return;
      bankAccountFilter = account;
      renderBankAccount();
    });
    $("bankKindChips")?.addEventListener("click", (event) => {
      const kind = event.target.closest("[data-bank-kind]")?.dataset.bankKind;
      if (!kind) return;
      bankKindFilter = kind;
      renderBankAccount();
    });
    // The 4 summary tiles double as shortcuts into the same account+kind
    // filter the chips above the ledger drive — "Current balance" and "Cash
    // on hand" have no kind of their own, so they open onto everything for
    // that side rather than filtering to nothing.
    function applyTileFilter(tile) {
      const account = tile?.dataset.tileAccount;
      const kind = tile?.dataset.tileKind;
      if (!account || !kind) return;
      bankAccountFilter = account;
      bankKindFilter = kind;
      renderBankAccount();
      $("bankTransactionList")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    document.querySelectorAll("[data-tile-account]").forEach((tile) => {
      tile.addEventListener("click", () => applyTileFilter(tile));
      tile.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        applyTileFilter(tile);
      });
    });
    $("bankSearch")?.addEventListener("input", (event) => {
      bankSearchQuery = event.target.value;
      $("clearBankSearch").hidden = !bankSearchQuery;
      renderBankAccount();
    });
    $("clearBankSearch")?.addEventListener("click", () => {
      bankSearchQuery = "";
      $("bankSearch").value = "";
      $("clearBankSearch").hidden = true;
      renderBankAccount();
    });
    $("bankTransactionList")?.addEventListener("click", (event) => {
      const editId = event.target.closest("[data-bank-edit]")?.dataset.bankEdit;
      if (editId) return openBankTransactionModal(null, BANK_TRANSACTIONS.find((item) => item.id === editId));
      const deleteId = event.target.closest("[data-bank-delete]")?.dataset.bankDelete;
      if (deleteId) deleteBankTransaction(deleteId);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const el = $("bankTransactionModal");
      if (el && !el.hidden) el.hidden = true;
      const cashModal = $("cashToBankModal");
      if (cashModal && !cashModal.hidden) cashModal.hidden = true;
    });
  }

  // Remember which panel was open, so returning to Account lands where the
  // user left rather than always on Overview.
  function rememberPanel(panel) {
    try { localStorage.setItem(LS_LAST_PANEL, panel); } catch (_) { /* storage unavailable */ }
  }

  window.addEventListener("rpc-enter-account", () => {
    bind();
    let panel = "overview";
    try { panel = localStorage.getItem(LS_LAST_PANEL) || "overview"; } catch (_) { /* storage unavailable */ }
    // A browser that last visited before Card payments/Payouts were retired
    // may still have one of those saved — neither panel exists any more, so
    // land on the balance instead of a blank page.
    if (panel === "payments" || panel === "payouts") panel = "overview";
    if (typeof window.RPC_ACCOUNT_PANEL === "function") window.RPC_ACCOUNT_PANEL(panel);
    renderAll();
    loadAll(true);
  });

  window.addEventListener("rpc-account-panel", (e) => {
    bind();
    const panel = e.detail?.panel || "overview";
    rememberPanel(panel);
    renderAll();
  });
  window.addEventListener("rpc-enter-expenses", () => rememberPanel("expenses"));

  // Let other modules (the ticket form in assets/intake.js) push a change in
  // and have this tab reflect it without a reload.
  window.RPC_ACCOUNT_REFRESH = () => loadAll(true);
})();
