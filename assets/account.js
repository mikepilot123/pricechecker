/* ============================================================
   Account — the card takings ledger.

   The shop's card machine is registered to the owner's brother, so
   every swipe is money that reaches HIS account the next business
   day and then has to be transferred across. This tab tracks the
   three things that follow from that: what has been taken, what has
   settled and is therefore owed, and which transfer cleared it.

   State is never stored — the server derives it from settles_at and
   payout_id (see lib/card-payments.js) — so the balance on screen is
   correct the moment it renders, with no overnight job to go wrong.

   Expenses lives in this tab too, as its own panel, unchanged and
   still driven by assets/dashboard.js.
   ============================================================ */

(function () {
  const SCRIPT_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  // Offline fallback: the last lists the server returned, so opening the tab
  // on a phone with one bar shows yesterday's ledger instead of nothing.
  const PAYMENTS_CACHE_KEY = "rpc_card_payments_cache";
  const PAYOUTS_CACHE_KEY = "rpc_payouts_cache";
  const SETTINGS_CACHE_KEY = "rpc_account_settings_cache";
  const LS_LAST_PANEL = "rpc_account_panel";
  const LS_LAST_PAYOUT_METHOD = "rpc_last_payout_method";

  const DEFAULT_SETTINGS = { debitFee: 0.75, creditFeePct: 4, settlementHour: 9, holdAlertDays: 2, holderName: "" };
  const BUSINESS_LABELS = { jq: "JQ Electronics", hj: "Hidden Jewels" };
  const STATE_LABELS = { pending: "Pending", settled: "Settled", collected: "Collected", void: "Void" };
  const STATE_FILTERS = [
    { key: "all", label: "All" },
    { key: "settled", label: "Owed" },
    { key: "pending", label: "Pending" },
    { key: "collected", label: "Collected" },
    { key: "void", label: "Voided" },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Cents matter here in a way they don't on the dashboard: a debit fee is
  // $0.75, so rounding to whole dollars would erase the entire charge.
  function money(value) {
    const n = Number(value || 0);
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  let PAYMENTS = readCache(PAYMENTS_CACHE_KEY);
  let PAYOUTS = readCache(PAYOUTS_CACHE_KEY);
  let SUMMARY = null;
  let SETTINGS = readCache(SETTINGS_CACHE_KEY, DEFAULT_SETTINGS);
  let stateFilter = "all";
  let searchQuery = "";
  let editingId = null;
  let cardType = "debit";
  let voidTarget = null; // { kind: "payment" | "payout", id, label }
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
  function toLocalInput(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
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
  function formatDayTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  // ---- Loading -------------------------------------------------------------
  let loadInFlight = null;
  function loadAll(force) {
    if (loadInFlight) return loadInFlight;
    if (loadedOnce && !force) return Promise.resolve();
    loadInFlight = (async () => {
      const [payments, payouts, summary, settings] = await Promise.allSettled([
        api({ action: "listCardPayments", includeVoided: true }),
        api({ action: "listPayouts" }),
        api({ action: "accountSummary" }),
        api({ action: "getAccountSettings" }),
      ]);
      if (payments.status === "fulfilled") {
        PAYMENTS = payments.value.payments || [];
        writeCache(PAYMENTS_CACHE_KEY, PAYMENTS);
      }
      if (payouts.status === "fulfilled") {
        PAYOUTS = payouts.value.payouts || [];
        writeCache(PAYOUTS_CACHE_KEY, PAYOUTS);
      }
      if (summary.status === "fulfilled") SUMMARY = summary.value.summary;
      if (settings.status === "fulfilled") {
        SETTINGS = settings.value.settings || DEFAULT_SETTINGS;
        writeCache(SETTINGS_CACHE_KEY, SETTINGS);
      }
      const failure = [payments, payouts, summary, settings].find((r) => r.status === "rejected");
      if (failure && !PAYMENTS.length) toast("Couldn't load the account: " + failure.reason.message);
      loadedOnce = true;
      fillSettingsForm();
      renderAll();
    })().finally(() => { loadInFlight = null; });
    return loadInFlight;
  }

  function renderAll() {
    renderOverview();
    renderPayments();
    renderPayouts();
  }

  // ---- Overview ------------------------------------------------------------
  function renderOverview() {
    // Fall back to computing from the cached list when the summary call didn't
    // land, so an offline open still shows a balance rather than four zeroes.
    const s = SUMMARY || summaryFromCache();
    const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };

    setText("acctOwed", money(s.owed));
    setText("acctOwedSub", s.owedCount
      ? `${s.owedCount} payment${s.owedCount === 1 ? "" : "s"} · oldest ${s.oldestUncollectedDays === 0 ? "today" : s.oldestUncollectedDays + " day" + (s.oldestUncollectedDays === 1 ? "" : "s") + " ago"}`
      : "Nothing waiting");
    setText("acctPending", money(s.pending));
    setText("acctPendingSub", s.pendingCount
      ? `${s.pendingCount} payment${s.pendingCount === 1 ? "" : "s"} not settled yet`
      : "Nothing in flight");
    setText("acctCollected", money(s.collectedThisMonth));
    setText("acctFees", money(s.feesThisMonth));

    // The jq/hj split belongs to the owed figure, not to what's been collected —
    // it answers "whose money is he holding", which is only a question while
    // it's still outstanding. Hidden entirely when Hidden Jewels isn't
    // involved, so the usual single-business case stays uncluttered.
    const jq = s.owedByBusiness ? s.owedByBusiness.jq : 0;
    const hj = s.owedByBusiness ? s.owedByBusiness.hj : 0;
    const split = $("acctOwedSplit");
    if (split) {
      split.hidden = !hj;
      split.textContent = hj ? `${BUSINESS_LABELS.jq} ${money(jq)} · ${BUSINESS_LABELS.hj} ${money(hj)}` : "";
    }
    const thisMonth = new Date().toISOString().slice(0, 7);
    const payoutsThisMonth = PAYOUTS.filter((p) => !p.voidedAt && String(p.paidAt || "").slice(0, 7) === thisMonth).length;
    setText("acctCollectedSub", payoutsThisMonth
      ? `${payoutsThisMonth} payout${payoutsThisMonth === 1 ? "" : "s"} received`
      : "No payouts yet this month");
    setText("acctFeesSub", "What the machine kept");

    const banner = $("acctOverdueBanner");
    if (banner) {
      const holder = SETTINGS.holderName || "the card machine holder";
      banner.hidden = !s.overdue;
      banner.textContent = s.overdue
        ? `${money(s.owed)} has been sitting settled for ${s.oldestUncollectedDays} day${s.oldestUncollectedDays === 1 ? "" : "s"}. Chase ${holder}.`
        : "";
    }

    // Ageing list — only worth showing when something is actually waiting.
    const held = PAYMENTS.filter((p) => p.state === "settled").sort((a, b) => String(a.settlesAt).localeCompare(String(b.settlesAt)));
    const section = $("acctHeldSection");
    const list = $("acctHeldList");
    if (section) section.hidden = held.length === 0;
    if (list && held.length) {
      list.innerHTML = held.map((p) => `
        <article class="ops-row acct-row">
          <div>
            <strong>${money(p.net)}</strong>
            <p>${esc(p.customer || BUSINESS_LABELS[p.business] || "Card payment")}</p>
            <small>Settled ${esc(formatDay(p.settlesAt))} · taken ${esc(formatDay(p.takenAt))}${p.receiptRef ? " · " + esc(p.receiptRef) : ""}</small>
          </div>
          <div class="acct-row-side">${statePill(p)}</div>
        </article>
      `).join("");
    }

    const reclaim = s.expenseReclaim || { total: 0, count: 0 };
    setText("acctReclaimTotal", money(reclaim.total));
    setText("acctReclaimSub", reclaim.count
      ? `${reclaim.count} expense${reclaim.count === 1 ? "" : "s"} paid with cash you still need back. See the Expenses panel.`
      : "Nothing outstanding.");
  }

  /** Offline stand-in for accountSummary(), from whatever list is cached. */
  function summaryFromCache() {
    const live = PAYMENTS.filter((p) => p.state !== "void");
    const owedList = live.filter((p) => p.state === "settled");
    const round = (n) => Math.round(n * 100) / 100;
    const sum = (list) => round(list.reduce((t, p) => t + Number(p.net || 0), 0));
    const thisMonth = new Date().toISOString().slice(0, 7);
    const inMonth = (p) => String(p.takenAt || "").slice(0, 7) === thisMonth;
    const oldest = owedList.map((p) => p.settlesAt).sort()[0];
    const days = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000) : 0;
    return {
      owed: sum(owedList),
      owedCount: owedList.length,
      pending: sum(live.filter((p) => p.state === "pending")),
      pendingCount: live.filter((p) => p.state === "pending").length,
      owedByBusiness: {
        jq: sum(owedList.filter((p) => p.business === "jq")),
        hj: sum(owedList.filter((p) => p.business === "hj")),
      },
      collectedThisMonth: sum(live.filter((p) => p.state === "collected" && inMonth(p))),
      feesThisMonth: round(live.filter(inMonth).reduce((t, p) => t + Number(p.fee || 0), 0)),
      oldestUncollectedDays: days,
      overdue: !!oldest && days >= (SETTINGS.holdAlertDays ?? 2),
      expenseReclaim: { total: 0, count: 0 },
    };
  }

  // ---- Card payments -------------------------------------------------------
  function statePill(payment) {
    return `<span class="acct-pill acct-pill-${payment.state}">${STATE_LABELS[payment.state] || payment.state}</span>`;
  }

  function visiblePayments() {
    const q = searchQuery.trim().toLowerCase();
    return PAYMENTS.filter((p) => {
      if (stateFilter === "all" ? p.state === "void" : p.state !== stateFilter) return false;
      if (!q) return true;
      return [p.customer, p.receiptRef, p.last4, p.ticketId, p.notes, BUSINESS_LABELS[p.business]]
        .some((field) => String(field || "").toLowerCase().includes(q));
    });
  }

  function renderStateChips() {
    const box = $("cardPayStateChips");
    if (!box) return;
    const counts = PAYMENTS.reduce((acc, p) => { acc[p.state] = (acc[p.state] || 0) + 1; return acc; }, {});
    box.innerHTML = STATE_FILTERS.map((f) => {
      const n = f.key === "all" ? PAYMENTS.filter((p) => p.state !== "void").length : (counts[f.key] || 0);
      return `<button type="button" class="chip${stateFilter === f.key ? " active" : ""}" data-state-filter="${f.key}" role="tab" aria-selected="${stateFilter === f.key}">${f.label}${n ? ` <span class="chip-count">${n}</span>` : ""}</button>`;
    }).join("");
  }

  function renderPayments() {
    renderStateChips();
    const list = $("cardPayList");
    const count = $("cardPayCount");
    const total = $("cardPayTotal");
    if (!list) return;
    const visible = visiblePayments();
    const netTotal = visible.filter((p) => p.state !== "void").reduce((t, p) => t + Number(p.net || 0), 0);
    if (total) total.textContent = money(netTotal);
    if (count) {
      count.textContent = PAYMENTS.length
        ? `${visible.length} of ${PAYMENTS.length} payment${PAYMENTS.length === 1 ? "" : "s"}`
        : "No card payments logged yet";
    }
    if (!visible.length) {
      list.innerHTML = `<p class="ops-empty">${PAYMENTS.length ? "No payments match this filter." : "Nothing logged yet. Tap “Log a card payment” after the next swipe."}</p>`;
      return;
    }
    list.innerHTML = visible.map((p) => {
      const payout = PAYOUTS.find((po) => po.id === p.payoutId);
      const editable = p.state === "pending" || p.state === "settled";
      return `
        <article class="ops-row acct-row${p.state === "void" ? " is-void" : ""}">
          <div>
            <strong>${money(p.gross)} <span class="acct-cardtype">${p.cardType === "credit" ? "Credit" : "Debit"}</span></strong>
            <p>${esc(p.customer || "No name")}${p.business === "hj" ? ` · ${BUSINESS_LABELS.hj}` : ""}</p>
            <small>${esc(formatDayTime(p.takenAt))} · fee ${money(p.fee)} · net <strong class="money-positive">${money(p.net)}</strong></small>
            <small>${p.state === "pending" ? "Settles " + esc(formatDay(p.settlesAt)) : p.state === "settled" ? "Settled " + esc(formatDay(p.settlesAt)) : ""}${payout ? "Paid out " + esc(formatDay(payout.paidAt)) + (payout.reference ? " · " + esc(payout.reference) : "") : ""}${p.state === "void" ? "Voided — " + esc(p.voidReason) : ""}${p.receiptRef ? " · " + esc(p.receiptRef) : ""}</small>
          </div>
          <div class="acct-row-side">
            ${statePill(p)}
            <div class="ops-row-actions">
              ${editable ? `<button type="button" data-cardpay-edit="${esc(p.id)}">Edit</button>` : ""}
              ${editable ? `<button type="button" class="danger-text" data-cardpay-void="${esc(p.id)}">Void</button>` : ""}
            </div>
          </div>
        </article>`;
    }).join("");
  }

  // ---- Payouts -------------------------------------------------------------
  function renderPayouts() {
    const list = $("payoutList");
    const count = $("payoutCount");
    if (!list) return;
    if (count) {
      count.textContent = PAYOUTS.length
        ? `${PAYOUTS.length} payout${PAYOUTS.length === 1 ? "" : "s"}`
        : "No payouts recorded yet";
    }
    if (!PAYOUTS.length) {
      list.innerHTML = `<p class="ops-empty">No transfers recorded yet. Record one once the money lands.</p>`;
      return;
    }
    list.innerHTML = PAYOUTS.map((po) => `
      <article class="ops-row acct-row${po.voidedAt ? " is-void" : ""}">
        <div>
          <strong>${money(po.amount)}</strong>
          <p>${esc(po.method || "Transfer")}${po.reference ? " · " + esc(po.reference) : ""}</p>
          <small>${esc(formatDay(po.paidAt))} · cleared ${po.paymentCount} payment${po.paymentCount === 1 ? "" : "s"}${po.notes ? " · " + esc(po.notes) : ""}</small>
          ${po.voidedAt ? `<small class="acct-void-note">Voided — ${esc(po.voidReason)}</small>` : ""}
        </div>
        <div class="acct-row-side">
          ${po.voidedAt ? `<span class="acct-pill acct-pill-void">Void</span>` : `<span class="acct-pill acct-pill-collected">Received</span>`}
          <div class="ops-row-actions">
            ${po.voidedAt ? "" : `<button type="button" class="danger-text" data-payout-void="${esc(po.id)}">Void</button>`}
          </div>
        </div>
      </article>`).join("");
  }

  // ---- Card payment modal --------------------------------------------------
  function computeFee(type, gross) {
    const raw = type === "credit" ? Number(gross || 0) * (Number(SETTINGS.creditFeePct || 0) / 100) : Number(SETTINGS.debitFee || 0);
    return Math.round(raw * 100) / 100;
  }

  function refreshFeePreview() {
    const gross = Number($("cardPayGross").value || 0);
    const override = $("cardPayFeeOverride").checked;
    const fee = override ? Number($("cardPayFee").value || 0) : computeFee(cardType, gross);
    if (!override) $("cardPayFee").value = fee ? fee.toFixed(2) : "";
    $("cardPayFeePreview").textContent = money(fee);
    $("cardPayNetPreview").textContent = money(Math.max(0, gross - fee));
    const hint = $("cardPaySettlesHint");
    if (hint) {
      hint.textContent = cardType === "credit"
        ? `Credit cards cost ${SETTINGS.creditFeePct}%. Settles the next business day.`
        : `Debit cards cost ${money(SETTINGS.debitFee)} flat. Settles the next business day.`;
    }
  }

  function setCardType(type) {
    cardType = type === "credit" ? "credit" : "debit";
    document.querySelectorAll("[data-card-type]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.cardType === cardType);
    });
    refreshFeePreview();
  }

  function openPaymentModal(payment) {
    editingId = payment ? payment.id : null;
    $("cardPayFormTitle").textContent = payment ? "Edit card payment" : "Log a card payment";
    $("cardPaySubmit").textContent = payment ? "Save changes" : "Save payment";
    $("cardPayId").value = payment ? payment.id : "";
    $("cardPayTakenAt").value = toLocalInput(payment ? payment.takenAt : new Date());
    $("cardPayGross").value = payment ? Number(payment.gross).toFixed(2) : "";
    $("cardPayBusiness").value = payment ? payment.business : "jq";
    $("cardPayCustomer").value = payment ? payment.customer : "";
    $("cardPayReceipt").value = payment ? payment.receiptRef : "";
    $("cardPayLast4").value = payment ? payment.last4 : "";
    $("cardPayNotes").value = payment ? payment.notes : "";
    // Only pre-tick the override when the stored fee genuinely differs from
    // what the rates would produce — otherwise editing an ordinary payment
    // would look like it had a manual fee all along.
    const standard = payment ? computeFee(payment.cardType, payment.gross) : 0;
    const overridden = !!payment && Math.abs(Number(payment.fee) - standard) > 0.005;
    $("cardPayFeeOverride").checked = overridden;
    $("cardPayFee").hidden = !overridden;
    $("cardPayFee").value = payment ? Number(payment.fee).toFixed(2) : "";
    setCardType(payment ? payment.cardType : "debit");
    setMessage("cardPayMessage", "");
    $("cardPayFormModal").hidden = false;
    setTimeout(() => $("cardPayGross").focus(), 50);
  }

  function closePaymentModal() {
    $("cardPayFormModal").hidden = true;
    editingId = null;
  }

  function setMessage(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  async function submitPayment() {
    const gross = Number($("cardPayGross").value || 0);
    if (!gross || gross <= 0) return setMessage("cardPayMessage", "Enter the amount the customer paid.");
    const takenAt = $("cardPayTakenAt").value;
    if (!takenAt) return setMessage("cardPayMessage", "Enter when the payment was taken.");
    const override = $("cardPayFeeOverride").checked;
    const payload = {
      action: editingId ? "updateCardPayment" : "addCardPayment",
      id: editingId || undefined,
      takenAt: new Date(takenAt).toISOString(),
      gross,
      cardType,
      business: $("cardPayBusiness").value,
      customer: $("cardPayCustomer").value.trim(),
      receiptRef: $("cardPayReceipt").value.trim(),
      last4: $("cardPayLast4").value.trim(),
      notes: $("cardPayNotes").value.trim(),
      // Sending "" lets the server recompute from its own rates, which keeps
      // the two sides from disagreeing about what the machine charged.
      fee: override ? Number($("cardPayFee").value || 0) : "",
    };
    const btn = $("cardPaySubmit");
    btn.disabled = true;
    try {
      await api(payload);
      closePaymentModal();
      await loadAll(true);
      toast(editingId ? "Payment updated" : "Payment logged");
    } catch (err) {
      setMessage("cardPayMessage", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Payout modal --------------------------------------------------------
  let payoutCandidates = [];
  const payoutPicked = new Set();

  function renderPayoutPicks() {
    const list = $("payoutPickList");
    if (!list) return;
    if (!payoutCandidates.length) {
      list.innerHTML = `<p class="ops-empty">Nothing has settled yet, so there's nothing to collect.</p>`;
    } else {
      list.innerHTML = payoutCandidates.map((p) => `
        <label class="acct-pick${payoutPicked.has(p.id) ? " is-picked" : ""}">
          <input type="checkbox" data-payout-pick="${esc(p.id)}"${payoutPicked.has(p.id) ? " checked" : ""} />
          <span class="acct-pick-body">
            <strong>${money(p.net)}</strong>
            <small>${esc(formatDay(p.takenAt))} · ${esc(p.customer || BUSINESS_LABELS[p.business])} · ${p.cardType === "credit" ? "Credit" : "Debit"} ${money(p.gross)} less ${money(p.fee)}</small>
          </span>
        </label>`).join("");
    }
    const total = payoutCandidates.filter((p) => payoutPicked.has(p.id)).reduce((t, p) => t + Number(p.net || 0), 0);
    $("payoutTotal").textContent = money(total);
    $("payoutSubmit").disabled = payoutPicked.size === 0;
  }

  async function openPayoutModal() {
    setMessage("payoutMessage", "");
    $("payoutPaidAt").value = toDateInput(new Date());
    $("payoutNotes").value = "";
    $("payoutReference").value = "";
    try {
      const last = localStorage.getItem(LS_LAST_PAYOUT_METHOD);
      if (last) $("payoutMethod").value = last;
    } catch (_) { /* storage unavailable */ }
    payoutCandidates = [];
    payoutPicked.clear();
    $("payoutPickList").innerHTML = `<p class="ops-empty">Loading…</p>`;
    $("payoutFormModal").hidden = false;
    try {
      const data = await api({ action: "listCollectable" });
      payoutCandidates = data.payments || [];
      // Everything ticked by default: the normal case is that he transferred
      // the whole batch, so the common path should be one tap.
      payoutCandidates.forEach((p) => payoutPicked.add(p.id));
    } catch (err) {
      setMessage("payoutMessage", err.message);
    }
    renderPayoutPicks();
  }

  async function submitPayout() {
    if (!payoutPicked.size) return setMessage("payoutMessage", "Tick at least one payment.");
    const paidAt = $("payoutPaidAt").value;
    if (!paidAt) return setMessage("payoutMessage", "Enter the date the money arrived.");
    const method = $("payoutMethod").value;
    const btn = $("payoutSubmit");
    btn.disabled = true;
    try {
      const data = await api({
        action: "addPayout",
        // Midday avoids a date-only value landing on the previous day once the
        // browser converts it to an instant.
        paidAt: new Date(paidAt + "T12:00:00").toISOString(),
        method,
        reference: $("payoutReference").value.trim(),
        notes: $("payoutNotes").value.trim(),
        paymentIds: [...payoutPicked],
      });
      try { localStorage.setItem(LS_LAST_PAYOUT_METHOD, method); } catch (_) { /* storage unavailable */ }
      $("payoutFormModal").hidden = true;
      await loadAll(true);
      toast(`Payout of ${money(data.payout.amount)} recorded`);
    } catch (err) {
      setMessage("payoutMessage", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Void modal ----------------------------------------------------------
  function openVoidModal(kind, id) {
    const isPayment = kind === "payment";
    const record = isPayment ? PAYMENTS.find((p) => p.id === id) : PAYOUTS.find((p) => p.id === id);
    if (!record) return;
    voidTarget = { kind, id };
    $("acctVoidTitle").textContent = isPayment ? "Void this payment" : "Void this payout";
    $("acctVoidBlurb").textContent = isPayment
      ? `${money(record.net)} taken ${formatDay(record.takenAt)}. It stays in the ledger with your reason, but stops counting toward what you're owed.`
      : `${money(record.amount)} received ${formatDay(record.paidAt)}. The ${record.paymentCount} payment${record.paymentCount === 1 ? " it cleared goes" : "s it cleared go"} back to being owed.`;
    $("acctVoidReason").value = "";
    setMessage("acctVoidMessage", "");
    $("acctVoidModal").hidden = false;
    setTimeout(() => $("acctVoidReason").focus(), 50);
  }

  async function confirmVoid() {
    if (!voidTarget) return;
    const reason = $("acctVoidReason").value.trim();
    if (!reason) return setMessage("acctVoidMessage", "Say why, so the ledger explains itself later.");
    const btn = $("acctVoidConfirmBtn");
    btn.disabled = true;
    try {
      await api({
        action: voidTarget.kind === "payment" ? "voidCardPayment" : "voidPayout",
        id: voidTarget.id,
        reason,
      });
      $("acctVoidModal").hidden = true;
      voidTarget = null;
      await loadAll(true);
      toast("Voided");
    } catch (err) {
      setMessage("acctVoidMessage", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Monthly statement ---------------------------------------------------
  // The thing you actually send him to check against his bank statement. The
  // receipt number and last four are what make that a two-minute job.
  // Readable local timestamps, not raw ISO: this file exists to be read
  // side-by-side with a bank statement, and "2026-09-04T14:33:53.988Z" is not
  // the time anyone at the shop remembers taking the payment.
  function csvDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function csvCell(value) {
    const text = String(value == null ? "" : value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function exportMonth() {
    const month = new Date().toISOString().slice(0, 7);
    const rows = PAYMENTS.filter((p) => String(p.takenAt || "").slice(0, 7) === month);
    if (!rows.length) return toast("Nothing taken this month to export yet.");
    const header = ["Taken", "Business", "Card type", "Gross", "Fee", "Net owed", "State", "Settles", "Customer", "Receipt", "Last 4", "Payout", "Payout date", "Notes"];
    const body = rows.map((p) => {
      const payout = PAYOUTS.find((po) => po.id === p.payoutId);
      return [
        csvDate(p.takenAt), BUSINESS_LABELS[p.business] || p.business, p.cardType,
        Number(p.gross).toFixed(2), Number(p.fee).toFixed(2), Number(p.net).toFixed(2),
        STATE_LABELS[p.state], csvDate(p.settlesAt), p.customer, p.receiptRef, p.last4,
        payout ? (payout.reference || payout.id) : "", payout ? csvDate(payout.paidAt) : "",
        p.state === "void" ? "VOID: " + p.voidReason : p.notes,
      ].map(csvCell).join(",");
    });
    const totalNet = rows.filter((p) => p.state !== "void").reduce((t, p) => t + Number(p.net || 0), 0);
    const csv = [header.map(csvCell).join(","), ...body, "", `Total net,${totalNet.toFixed(2)}`].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `card-takings-${month}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${rows.length} payment${rows.length === 1 ? "" : "s"} for ${month}`);
  }

  // ---- Settings ------------------------------------------------------------
  function fillSettingsForm() {
    if (!$("acctDebitFee")) return;
    $("acctDebitFee").value = SETTINGS.debitFee;
    $("acctCreditFeePct").value = SETTINGS.creditFeePct;
    $("acctHolderName").value = SETTINGS.holderName || "";
    $("acctHoldAlertDays").value = SETTINGS.holdAlertDays;
  }

  async function saveSettings() {
    const btn = $("acctSettingsSave");
    btn.disabled = true;
    setMessage("acctSettingsMessage", "");
    try {
      const data = await api({
        action: "saveAccountSettings",
        settings: {
          debitFee: Number($("acctDebitFee").value || 0),
          creditFeePct: Number($("acctCreditFeePct").value || 0),
          holderName: $("acctHolderName").value.trim(),
          holdAlertDays: Number($("acctHoldAlertDays").value || 0),
        },
      });
      SETTINGS = data.settings;
      writeCache(SETTINGS_CACHE_KEY, SETTINGS);
      fillSettingsForm();
      renderOverview();
      toast("Card machine settings saved");
    } catch (err) {
      setMessage("acctSettingsMessage", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Wiring --------------------------------------------------------------
  function bind() {
    if (bound) return;
    bound = true;

    $("cardPayNewBtn")?.addEventListener("click", () => openPaymentModal(null));
    $("closeCardPayFormModal")?.addEventListener("click", closePaymentModal);
    $("cardPayCancelBtn")?.addEventListener("click", closePaymentModal);
    $("cardPaySubmit")?.addEventListener("click", submitPayment);
    $("cardPayForm")?.addEventListener("submit", (e) => { e.preventDefault(); submitPayment(); });
    $("cardPayGross")?.addEventListener("input", refreshFeePreview);
    $("cardPayFee")?.addEventListener("input", refreshFeePreview);
    $("cardPayFeeOverride")?.addEventListener("change", (e) => {
      $("cardPayFee").hidden = !e.target.checked;
      refreshFeePreview();
    });
    document.querySelectorAll("[data-card-type]").forEach((btn) => {
      btn.addEventListener("click", () => setCardType(btn.dataset.cardType));
    });

    $("acctExportBtn")?.addEventListener("click", exportMonth);
    $("acctSettingsSave")?.addEventListener("click", saveSettings);
    $("acctPayoutBtn")?.addEventListener("click", openPayoutModal);
    $("acctPayoutBtn2")?.addEventListener("click", openPayoutModal);
    $("closePayoutFormModal")?.addEventListener("click", () => { $("payoutFormModal").hidden = true; });
    $("payoutCancelBtn")?.addEventListener("click", () => { $("payoutFormModal").hidden = true; });
    $("payoutSubmit")?.addEventListener("click", submitPayout);
    $("payoutForm")?.addEventListener("submit", (e) => { e.preventDefault(); submitPayout(); });
    $("payoutSelectAll")?.addEventListener("click", () => {
      payoutCandidates.forEach((p) => payoutPicked.add(p.id));
      renderPayoutPicks();
    });
    $("payoutSelectNone")?.addEventListener("click", () => {
      payoutPicked.clear();
      renderPayoutPicks();
    });
    $("payoutPickList")?.addEventListener("change", (e) => {
      const id = e.target.dataset?.payoutPick;
      if (!id) return;
      e.target.checked ? payoutPicked.add(id) : payoutPicked.delete(id);
      renderPayoutPicks();
    });

    $("closeAcctVoidModal")?.addEventListener("click", () => { $("acctVoidModal").hidden = true; voidTarget = null; });
    $("acctVoidCancelBtn")?.addEventListener("click", () => { $("acctVoidModal").hidden = true; voidTarget = null; });
    $("acctVoidConfirmBtn")?.addEventListener("click", confirmVoid);

    $("cardPayStateChips")?.addEventListener("click", (e) => {
      const key = e.target.closest("[data-state-filter]")?.dataset.stateFilter;
      if (!key) return;
      stateFilter = key;
      renderPayments();
    });
    $("cardPaySearch")?.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      $("clearCardPaySearch").hidden = !searchQuery;
      renderPayments();
    });
    $("clearCardPaySearch")?.addEventListener("click", () => {
      searchQuery = "";
      $("cardPaySearch").value = "";
      $("clearCardPaySearch").hidden = true;
      renderPayments();
    });

    $("cardPayList")?.addEventListener("click", (e) => {
      const edit = e.target.closest("[data-cardpay-edit]")?.dataset.cardpayEdit;
      if (edit) return openPaymentModal(PAYMENTS.find((p) => p.id === edit));
      const kill = e.target.closest("[data-cardpay-void]")?.dataset.cardpayVoid;
      if (kill) openVoidModal("payment", kill);
    });
    $("payoutList")?.addEventListener("click", (e) => {
      const kill = e.target.closest("[data-payout-void]")?.dataset.payoutVoid;
      if (kill) openVoidModal("payout", kill);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      ["cardPayFormModal", "payoutFormModal", "acctVoidModal"].forEach((id) => {
        const el = $(id);
        if (el && !el.hidden) el.hidden = true;
      });
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
  // The card machine's rates are edited in Settings, not here, so make sure
  // they're loaded when that tab is opened without visiting Account first.
  document.getElementById("intakeSettings")?.addEventListener("click", () => {
    bind();
    loadAll().then(fillSettingsForm);
  });

  // Let other modules (the ticket form in assets/intake.js) push a payment in
  // and have this tab reflect it without a reload.
  window.RPC_ACCOUNT_REFRESH = () => loadAll(true);

  // Entry point for the "Collect $X card takings" reminder, which can't be
  // ticked off the way an ordinary reminder can — the balance is derived, so
  // the only thing that actually settles it is recording the transfer.
  window.RPC_RECORD_PAYOUT = () => {
    bind();
    if (typeof window.RPC_SHOW_VIEW === "function") window.RPC_SHOW_VIEW("account");
    if (typeof window.RPC_ACCOUNT_PANEL === "function") window.RPC_ACCOUNT_PANEL("overview");
    loadAll(true);
    openPayoutModal();
  };
})();
