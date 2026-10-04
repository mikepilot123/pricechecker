/* ============================================================
   Settings → Zoho Books
   ------------------------------------------------------------
   Connect the shop's Zoho Books organisation once (Self Client keys + a
   one-time code), then see what's been synced and retry anything Zoho
   rejected. The sync itself runs on the server — lib/zoho.js via
   api/invoice.js — whenever an invoice or expense is saved.
   ============================================================ */
(() => {
  const $ = (id) => document.getElementById(id);
  const request = (body) => window.RPC_INVOICE_REQUEST(body);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const notify = (message, tone = "info") => {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message, { tone, duration: tone === "error" ? 9000 : 4000 });
  };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "");

  let status = null;

  function renderStatus(message = "") {
    const box = $("zohoStatusBox");
    if (!box) return;
    if (!status) {
      box.innerHTML = `<p class="settings-help">${esc(message || "Loading…")}</p>`;
      return;
    }
    if (!status.connected) {
      box.innerHTML = `
        <div class="zoho-card">
          <div class="zoho-card-head"><span class="zoho-dot"></span><div><strong>Not connected</strong><p>Nothing is being sent to Zoho Books.</p></div></div>
          ${message ? `<p class="field-error">${esc(message)}</p>` : ""}
          <div><button type="button" class="primary-btn" data-zoho-open>Connect Zoho Books</button></div>
        </div>`;
      return;
    }
    const failed = status.invoices.failed + status.expenses.failed;
    box.innerHTML = `
      <div class="zoho-card">
        <div class="zoho-card-head">
          <span class="zoho-dot is-on"></span>
          <div>
            <strong>Connected${status.organizationName ? ` to ${esc(status.organizationName)}` : ""}</strong>
            <p>Organization ${esc(status.organizationId)} · sending records created since ${esc(day(status.connectedAt))}</p>
          </div>
        </div>
        <div class="zoho-stats">
          <div class="${status.invoices.failed ? "has-failed" : ""}"><span>Invoices sent</span><strong>${status.invoices.synced}${status.invoices.failed ? ` · ${status.invoices.failed} failed` : ""}</strong></div>
          <div class="${status.expenses.failed ? "has-failed" : ""}"><span>Expenses sent</span><strong>${status.expenses.synced}${status.expenses.failed ? ` · ${status.expenses.failed} failed` : ""}</strong></div>
        </div>
        ${message ? `<p class="field-error">${esc(message)}</p>` : ""}
        ${status.issues.length ? `
          <p class="field-label">Needs attention</p>
          <ul class="zoho-issues">
            ${status.issues.map((i) => `
              <li class="zoho-issue ${i.status === "failed" ? "is-failed" : ""}">
                <strong>${i.type === "invoice" ? "Invoice" : "Expense"} · ${esc(i.label || i.id)}</strong>
                <p>${i.status === "failed" ? "Not sent yet — " : ""}${esc(i.error)}</p>
                ${i.status === "warning" ? `<button type="button" class="ghost-btn" data-zoho-dismiss="${esc(i.type)}|${esc(i.id)}">Fixed in Zoho — dismiss</button>` : ""}
              </li>`).join("")}
          </ul>` : ""}
        <div class="settings-actions">
          <button type="button" class="ghost-btn" data-zoho-retry ${failed ? "" : "disabled"}><svg class="icon"><use href="#i-refresh"></use></svg>Retry failed</button>
          <button type="button" class="ghost-btn danger-btn" data-zoho-disconnect>Disconnect</button>
        </div>
      </div>`;
  }

  async function load() {
    try {
      status = (await request({ action: "zohoStatus" })).zoho;
      fillRegions();
      renderStatus();
    } catch (err) {
      renderStatus(`Couldn't load Zoho status: ${err.message || err}`);
    }
  }

  function fillRegions() {
    const select = $("zohoDataCenter");
    if (!select || select.options.length || !status?.dataCenters) return;
    select.innerHTML = Object.entries(status.dataCenters)
      .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
    select.value = status.dataCenter || "com";
  }

  function showForm(show) {
    $("zohoConnectForm").hidden = !show;
    $("zohoConnectError").hidden = true;
    if (show) {
      $("zohoCode").value = "";
      $("zohoClientSecret").value = "";
      if (status?.organizationId) $("zohoOrgId").value = status.organizationId;
      $("zohoClientId").focus();
    }
  }

  async function connect(event) {
    event.preventDefault();
    const btn = $("zohoConnectSubmit");
    const err = $("zohoConnectError");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Connecting…";
    try {
      status = (await request({
        action: "zohoConnect",
        clientId: $("zohoClientId").value,
        clientSecret: $("zohoClientSecret").value,
        organizationId: $("zohoOrgId").value,
        dataCenter: $("zohoDataCenter").value,
        code: $("zohoCode").value,
      })).zoho;
      showForm(false);
      renderStatus();
      notify(`Zoho Books connected${status.organizationName ? ` — ${status.organizationName}` : ""}. New invoices and expenses will be sent there.`);
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  }

  async function onStatusClick(event) {
    const t = event.target.closest("button");
    if (!t) return;
    try {
      if (t.hasAttribute("data-zoho-open")) showForm(true);
      if (t.hasAttribute("data-zoho-retry")) {
        t.disabled = true;
        const res = await request({ action: "zohoRetry" });
        status = res.zoho;
        renderStatus();
        notify(res.tried ? `${res.synced} of ${res.tried} sent to Zoho.` : "Nothing waiting to retry.");
      }
      if (t.dataset.zohoDismiss) {
        const [type, id] = t.dataset.zohoDismiss.split("|");
        status = (await request({ action: "zohoDismiss", type, id })).zoho;
        renderStatus();
      }
      if (t.hasAttribute("data-zoho-disconnect")) {
        if (!window.confirm("Disconnect Zoho Books? New invoices and expenses will stop being sent there. Anything already in Zoho stays.")) return;
        status = (await request({ action: "zohoDisconnect" })).zoho;
        renderStatus();
      }
    } catch (err) {
      renderStatus(err.message || String(err));
    }
  }

  function bind() {
    const panel = document.querySelector('[data-settings-panel-section="zoho"]');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = "1";
    $("zohoStatusBox").addEventListener("click", onStatusClick);
    $("zohoConnectForm").addEventListener("submit", connect);
    $("zohoConnectCancel").addEventListener("click", () => showForm(false));
  }

  window.addEventListener("rpc-enter-zoho-settings", () => {
    bind();
    load();
  });
})();
