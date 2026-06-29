/* ============================================================
   Leads — shared sales/repair prospect pipeline.
   Uses the same team PIN saved by Check In and the same Vercel API shape:
   { action, pin, ...fields } -> { ok, ... }.
   ============================================================ */

(function () {
  const LEADS_URL = "https://pricechecker-cyan.vercel.app/api/leads";
  const LS_PIN = "rpc_intake_pin";
  const STATUSES = ["New", "Contacted", "Quoted", "Follow-up", "Won", "Lost"];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let leads = [];
  let bound = false;
  let loadedOnce = false;

  function getPin() {
    try { return localStorage.getItem(LS_PIN) || ""; }
    catch (_) { return ""; }
  }

  async function api(payload) {
    const res = await fetch(LEADS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: getPin() }, payload)),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function setStatus(state, text) {
    const dot = $("leadsStatusDot");
    const updated = $("leadsUpdated");
    if (dot) {
      dot.classList.remove("live", "stale", "error");
      dot.classList.add(state);
    }
    if (updated) updated.textContent = text;
  }

  function money(value) {
    const n = Number(value || 0);
    if (!n) return "";
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "TTD", currencyDisplay: "narrowSymbol" }).format(n);
  }

  function formatDate(date) {
    if (!date) return "";
    const parsed = new Date(date + "T00:00:00");
    return isNaN(parsed) ? date : parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function isDue(date) {
    return !!date && date <= todayISO();
  }

  function statusClass(status) {
    return "lead-status-" + String(status || "New").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function statusOptions(selected, includeAll) {
    const options = includeAll ? ['<option value="all">All statuses</option>'] : [];
    return options.concat(STATUSES.map((status) =>
      `<option value="${esc(status)}" ${status === selected ? "selected" : ""}>${esc(status)}</option>`
    )).join("");
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    const form = $("leadForm");
    if (form) form.addEventListener("submit", saveLead);
    $("leadCancelEdit")?.addEventListener("click", resetForm);
    $("leadRefresh")?.addEventListener("click", () => loadLeads({ force: true }));
    $("leadStatusFilter")?.addEventListener("change", render);
    $("leadFollowUpFilter")?.addEventListener("change", render);
    $("leadSearch")?.addEventListener("input", () => {
      const clear = $("clearLeadSearch");
      if (clear) clear.hidden = !$("leadSearch").value;
      render();
    });
    $("clearLeadSearch")?.addEventListener("click", () => {
      $("leadSearch").value = "";
      $("clearLeadSearch").hidden = true;
      render();
    });
    $("leadList")?.addEventListener("click", handleListClick);
    $("leadList")?.addEventListener("change", handleListChange);
  }

  function populateControls() {
    const status = $("leadStatus");
    const filter = $("leadStatusFilter");
    if (status && !status.innerHTML) status.innerHTML = statusOptions("New", false);
    if (filter && !filter.innerHTML) filter.innerHTML = statusOptions("", true);
  }

  async function loadLeads({ force = false } = {}) {
    bindOnce();
    populateControls();
    if (!getPin()) {
      leads = [];
      setStatus("stale", "Save the Check In PIN in Settings before loading leads.");
      render();
      return;
    }
    if (loadedOnce && !force) {
      render();
      return;
    }
    setStatus("stale", "Loading leads…");
    try {
      const data = await api({ action: "list" });
      leads = Array.isArray(data.leads) ? data.leads : [];
      loadedOnce = true;
      setStatus("live", `Leads synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      render();
    } catch (err) {
      setStatus("error", "Couldn't load leads: " + err.message);
      render();
    }
  }

  function formPayload() {
    return {
      id: $("leadId")?.value || "",
      customerName: ($("leadName")?.value || "").trim(),
      phone: ($("leadPhone")?.value || "").trim(),
      email: ($("leadEmail")?.value || "").trim(),
      device: ($("leadDevice")?.value || "").trim(),
      issue: ($("leadIssue")?.value || "").trim(),
      quotedAmount: ($("leadQuotedAmount")?.value || "").trim(),
      source: ($("leadSource")?.value || "").trim(),
      status: $("leadStatus")?.value || "New",
      followUpDate: $("leadFollowUpDate")?.value || "",
      notes: ($("leadNotes")?.value || "").trim(),
    };
  }

  async function saveLead(event) {
    event.preventDefault();
    const msg = $("leadMessage");
    const submit = $("leadSubmit");
    const payload = formPayload();
    if (!payload.customerName && !payload.phone) {
      if (msg) msg.textContent = "Add a name or phone number.";
      return;
    }
    if (!getPin()) {
      if (msg) msg.textContent = "Save the Check In PIN in Settings before adding leads.";
      return;
    }
    if (submit) submit.disabled = true;
    try {
      const action = payload.id ? "update" : "add";
      const data = await api(Object.assign({ action }, payload));
      mergeLead(data.lead);
      resetForm();
      if (msg) msg.textContent = action === "add" ? "Lead added." : "Lead updated.";
      setStatus("live", `Leads synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      render();
    } catch (err) {
      if (msg) msg.textContent = err.message;
      setStatus("error", "Lead sync failed");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function mergeLead(lead) {
    if (!lead || !lead.id) return;
    const index = leads.findIndex((item) => item.id === lead.id);
    if (index === -1) leads.unshift(lead);
    else leads[index] = lead;
  }

  function resetForm() {
    $("leadForm")?.reset();
    if ($("leadStatus")) $("leadStatus").value = "New";
    if ($("leadId")) $("leadId").value = "";
    if ($("leadSubmit")) $("leadSubmit").textContent = "Save lead";
    if ($("leadCancelEdit")) $("leadCancelEdit").hidden = true;
  }

  function editLead(lead) {
    if (!lead) return;
    $("leadId").value = lead.id || "";
    $("leadName").value = lead.customerName || "";
    $("leadPhone").value = lead.phone || "";
    $("leadEmail").value = lead.email || "";
    $("leadDevice").value = lead.device || "";
    $("leadIssue").value = lead.issue || "";
    $("leadQuotedAmount").value = lead.quotedAmount || "";
    $("leadSource").value = lead.source || "";
    $("leadStatus").value = STATUSES.includes(lead.status) ? lead.status : "New";
    $("leadFollowUpDate").value = lead.followUpDate || "";
    $("leadNotes").value = lead.notes || "";
    $("leadSubmit").textContent = "Update lead";
    $("leadCancelEdit").hidden = false;
    $("leadName").focus();
    $("view-leads")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function filteredLeads() {
    const status = $("leadStatusFilter")?.value || "all";
    const follow = $("leadFollowUpFilter")?.value || "all";
    const query = ($("leadSearch")?.value || "").trim().toLowerCase();
    return leads.filter((lead) => {
      if (status !== "all" && lead.status !== status) return false;
      if (follow === "due" && !isDue(lead.followUpDate)) return false;
      if (follow === "today" && lead.followUpDate !== todayISO()) return false;
      if (follow === "upcoming" && (!lead.followUpDate || lead.followUpDate <= todayISO())) return false;
      if (follow === "none" && lead.followUpDate) return false;
      if (!query) return true;
      return [lead.customerName, lead.phone, lead.email, lead.device, lead.issue, lead.source, lead.notes]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
  }

  function render() {
    populateControls();
    const list = $("leadList");
    const count = $("leadCount");
    if (!list) return;
    const visible = filteredLeads();
    if (count) {
      const total = leads.length;
      count.textContent = total ? `${visible.length} of ${total} lead${total === 1 ? "" : "s"}` : "No leads yet";
    }
    list.innerHTML = visible.length
      ? visible.map(leadCardHtml).join("")
      : `<p class="ops-empty">No leads match the current filters.</p>`;
  }

  function leadCardHtml(lead) {
    const phone = lead.phone
      ? `<a class="ticket-phone" href="tel:${esc(lead.phone)}"><svg class="icon ticket-phone-icon"><use href="#i-phone"></use></svg>${esc(lead.phone)}</a>`
      : `<span class="ticket-phone no-phone">No phone</span>`;
    const quote = money(lead.quotedAmount);
    const dueClass = isDue(lead.followUpDate) && !["Won", "Lost"].includes(lead.status) ? " is-due" : "";
    return `<article class="ops-row lead-row ${statusClass(lead.status)}" data-lead-id="${esc(lead.id)}">
      <div class="lead-main">
        <div class="lead-title-row">
          <strong>${esc(lead.customerName || "Unnamed lead")}</strong>
          <span class="lead-status-pill">${esc(lead.status || "New")}</span>
        </div>
        <p>${esc([lead.device, lead.issue].filter(Boolean).join(" · ") || "No device or issue yet")}</p>
        <small>${phone}${lead.email ? ` · ${esc(lead.email)}` : ""}${quote ? ` · Quote ${esc(quote)}` : ""}${lead.source ? ` · ${esc(lead.source)}` : ""}</small>
        <div class="lead-meta${dueClass}">${lead.followUpDate ? `Follow up ${esc(formatDate(lead.followUpDate))}` : "No follow-up date"}${lead.notes ? ` · ${esc(lead.notes)}` : ""}</div>
      </div>
      <div class="ops-row-actions lead-actions">
        <select class="text-input select-input lead-card-status" data-lead-status="${esc(lead.id)}" aria-label="Lead status">${statusOptions(lead.status, false)}</select>
        <button type="button" data-lead-edit="${esc(lead.id)}">Edit</button>
        <button type="button" class="danger-text" data-lead-delete="${esc(lead.id)}">Delete</button>
      </div>
    </article>`;
  }

  async function handleListClick(event) {
    const editBtn = event.target.closest("[data-lead-edit]");
    const deleteBtn = event.target.closest("[data-lead-delete]");
    if (editBtn) {
      editLead(leads.find((lead) => lead.id === editBtn.dataset.leadEdit));
      return;
    }
    if (!deleteBtn) return;
    const id = deleteBtn.dataset.leadDelete;
    const lead = leads.find((item) => item.id === id);
    if (!lead || !window.confirm(`Delete lead for ${lead.customerName || lead.phone || "this customer"}?`)) return;
    try {
      await api({ action: "delete", id });
      leads = leads.filter((item) => item.id !== id);
      render();
      setStatus("live", `Leads synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch (err) {
      setStatus("error", "Couldn't delete lead: " + err.message);
    }
  }

  async function handleListChange(event) {
    const select = event.target.closest("[data-lead-status]");
    if (!select) return;
    const id = select.dataset.leadStatus;
    try {
      const data = await api({ action: "update", id, status: select.value });
      mergeLead(data.lead);
      render();
      setStatus("live", `Leads synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch (err) {
      setStatus("error", "Couldn't update lead: " + err.message);
      render();
    }
  }

  window.addEventListener("rpc-enter-leads", () => loadLeads());
})();
