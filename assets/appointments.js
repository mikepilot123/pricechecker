/* ============================================================
   Appointments — Cal.com-style booking, now a 3-step wizard:
   1) pick a day + time on a month calendar, 2) pick the device
   (synced with the same model datalist/catalog images as Check-In)
   and a technician (Fresha-style chip picker, shared technician
   list), 3) add the client's details to confirm. Stored locally
   (no backend yet for the booking itself); booked slots are
   excluded from the picker so two clients can't be double-booked
   into the same time.
   ============================================================ */

(function () {
  const APPOINTMENTS_KEY = "rpc_repair_appointments";
  const OPEN_HOUR = 8.5; // 8:30 AM
  const CLOSE_HOUR = 16; // 4:00 PM
  const SLOT_MINUTES = 30;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const SCRIPT_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  const DEFAULT_TECHNICIANS = ["Liana", "Michael", "Marcus"];
  const DEVICE_IMAGE_CATALOG_URL = "assets/device-images/catalog.json";
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

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let viewMonth = startOfMonth(new Date());
  let selectedDate = null; // "YYYY-MM-DD"
  let selectedTime = null; // "HH:MM"
  let selectedTechnician = ""; // "" = Any professional
  let selectedIssues = new Set();
  let technicians = [];
  let deviceImageCatalogPromise = null;
  let currentStep = 1;
  let bound = false;
  let closeAppointmentDeviceDropdown = null;

  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function todayISO() { return toISODate(new Date()); }
  function toISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function minutesToLabel(mins) {
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const period = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${pad2(m)} ${period}`;
  }
  function minutesToValue(mins) { return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`; }

  function readAppointments() {
    try { return JSON.parse(localStorage.getItem(APPOINTMENTS_KEY) || "[]"); }
    catch (_) { return []; }
  }
  function writeAppointments(list) {
    try { localStorage.setItem(APPOINTMENTS_KEY, JSON.stringify(list)); } catch (_) { /* storage unavailable */ }
  }

  function isClosedDay(date) { return date.getDay() === 0; } // Sunday
  function isPastDay(date) {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return date < t;
  }

  function bookedTimesFor(dateStr) {
    return new Set(
      readAppointments()
        .filter((a) => a.date === dateStr && a.status !== "cancelled")
        .map((a) => a.time)
    );
  }

  function slotsFor(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (isClosedDay(date) || isPastDay(date)) return [];
    const booked = bookedTimesFor(dateStr);
    const isToday = dateStr === todayISO();
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const slots = [];
    for (let mins = OPEN_HOUR * 60; mins + SLOT_MINUTES <= CLOSE_HOUR * 60; mins += SLOT_MINUTES) {
      const value = minutesToValue(mins);
      if (booked.has(value)) continue;
      if (isToday && mins <= nowMins) continue;
      slots.push(value);
    }
    return slots;
  }

  function renderCalendar() {
    const label = $("bookingMonthLabel");
    const grid = $("bookingCalendarGrid");
    if (!label || !grid) return;
    label.textContent = `${MONTH_NAMES[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`;

    const firstWeekday = viewMonth.getDay();
    const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
    const today = todayISO();

    let html = "";
    for (let i = 0; i < firstWeekday; i++) html += `<span class="booking-day is-empty"></span>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
      const dateStr = toISODate(date);
      const disabled = isClosedDay(date) || isPastDay(date);
      const classes = ["booking-day"];
      if (dateStr === today) classes.push("is-today");
      if (dateStr === selectedDate) classes.push("is-selected");
      html += `<button type="button" class="${classes.join(" ")}" data-date="${dateStr}" ${disabled ? "disabled" : ""}>${day}</button>`;
    }
    grid.innerHTML = html;

    grid.querySelectorAll(".booking-day:not(.is-empty):not(:disabled)").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedDate = btn.dataset.date;
        selectedTime = null;
        renderCalendar();
        renderSlots();
      });
    });

    const prevBtn = $("bookingPrevMonth");
    if (prevBtn) prevBtn.disabled = viewMonth <= startOfMonth(new Date());
  }

  function renderSlots() {
    const label = $("bookingSlotsLabel");
    const list = $("bookingSlotsList");
    if (!label || !list) return;
    if (!selectedDate) {
      label.textContent = "Pick a day to see times";
      list.innerHTML = "";
      return;
    }
    const [y, m, d] = selectedDate.split("-").map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    label.textContent = dateLabel;
    const slots = slotsFor(selectedDate);
    list.innerHTML = slots.length
      ? slots.map((value) => `<button type="button" class="booking-slot-btn ${value === selectedTime ? "is-selected" : ""}" data-time="${value}">${minutesToLabel(timeToMinutes(value))}</button>`).join("")
      : `<p class="booking-slots-empty">No open times this day.</p>`;
    list.querySelectorAll(".booking-slot-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTime = btn.dataset.time;
        renderSlots();
        if (selectedDate && selectedTime) setTimeout(() => setStep(2), 250);
      });
    });
  }

  function timeToMinutes(value) {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  }

  // ---------- step wizard ----------

  function setStep(n) {
    currentStep = n;
    document.querySelectorAll(".form-step[data-appt-step]").forEach((section) => {
      section.hidden = Number(section.dataset.apptStep) !== n;
    });
    document.querySelectorAll(".form-progress-step[data-appt-progress-step]").forEach((chip) => {
      const stepNum = Number(chip.dataset.apptProgressStep);
      chip.classList.toggle("active", stepNum === n);
      chip.classList.toggle("complete", stepNum < n);
    });
    document.querySelectorAll(".form-progress-line").forEach((line, idx) => {
      line.classList.toggle("complete", idx + 1 < n);
    });

    const isComplete = n === 4;
    const prevBtn = $("apptPrevStep");
    const nextBtn = $("apptNextStep");
    const confirmBtn = $("apptConfirmBtn");
    const createAnotherBtn = $("apptCreateAnother");
    const goToViewBtn = $("apptGoToView");
    if (prevBtn) prevBtn.hidden = n === 1 || isComplete;
    if (nextBtn) nextBtn.hidden = n !== 2;
    if (confirmBtn) confirmBtn.hidden = n !== 3;
    if (createAnotherBtn) createAnotherBtn.hidden = !isComplete;
    if (goToViewBtn) goToViewBtn.hidden = !isComplete;

    if (n === 3) renderSummary();
  }

  function renderSummary() {
    const summary = $("bookingSelectedSummary");
    if (!summary || !selectedDate || !selectedTime) return;
    const [y, m, d] = selectedDate.split("-").map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    const device = ($("appointmentDevice")?.value || "").trim();
    const techLabel = selectedTechnician || "Any professional";
    summary.textContent = `${dateLabel} at ${minutesToLabel(timeToMinutes(selectedTime))} · ${device || "Device"} · ${techLabel}`;
  }

  function resetSelection() {
    selectedDate = null;
    selectedTime = null;
    selectedTechnician = "";
    const form = $("appointmentForm");
    if (form) form.reset();
    const deviceInput = $("appointmentDevice");
    if (deviceInput) deviceInput.value = "";
    updateDeviceThumb("");
    setIssueTags("");
    const step2Msg = $("apptStep2Message");
    if (step2Msg) step2Msg.hidden = true;
    renderTechnicianPicker();
    renderCalendar();
    renderSlots();
    setStep(1);
  }

  // ---------- issues (multi-select picker, mirrors Check-In's issue modal) ----------

  function populateIssueTags() {
    const box = $("apptIssueTags");
    if (!box) return;
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
    const otherInput = $("apptIssueOther");
    if (otherInput) {
      otherInput.hidden = !otherOn;
      if (otherOn) otherInput.focus();
    }
    updateIssueSummary();
  }

  function buildIssuesString() {
    const parts = [];
    selectedIssues.forEach((s) => {
      if (s !== "Other") parts.push(s);
    });
    if (selectedIssues.has("Other")) {
      const text = ($("apptIssueOther")?.value || "").trim();
      if (text) parts.push("Other: " + text);
    }
    return parts.join(", ");
  }

  function issueTagsHtml(issuesStr) {
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return `<span class="issue-chip muted">No issues recorded</span>`;
    return parts.map((p) => `<span class="issue-chip">${esc(p)}</span>`).join("");
  }

  function updateIssueSummary() {
    const str = buildIssuesString();
    const btn = $("openApptIssueModal");
    const count = selectedIssues.size;
    const label = $("apptIssueSelectLabel");
    if (label) label.textContent = count ? `${count} issue${count === 1 ? "" : "s"} selected` : "Select issues…";
    btn?.classList.toggle("has-selection", count > 0);
    const summary = $("apptIssueSummary");
    if (summary) summary.innerHTML = count ? issueTagsHtml(str) : "";
  }

  function setIssueTags(issuesStr) {
    selectedIssues = new Set();
    $("apptIssueTags")?.querySelectorAll(".issue-toggle").forEach((b) => b.classList.remove("active"));
    const otherInput = $("apptIssueOther");
    if (otherInput) { otherInput.hidden = true; otherInput.value = ""; }
    const parts = (issuesStr || "").split(",").map((s) => s.trim()).filter(Boolean);
    parts.forEach((part) => {
      const match = ISSUES.find((preset) => preset !== "Other" && preset === part);
      if (match) {
        selectedIssues.add(match);
        $("apptIssueTags")?.querySelector(`[data-issue="${CSS.escape(match)}"]`)?.classList.add("active");
      } else if (part.startsWith("Other:")) {
        selectedIssues.add("Other");
        $("apptIssueTags")?.querySelector(`[data-issue="Other"]`)?.classList.add("active");
        if (otherInput) { otherInput.hidden = false; otherInput.value = part.slice(6).trim(); }
      }
    });
    updateIssueSummary();
  }

  function openApptIssueModal() {
    closeAppointmentDeviceDropdown?.();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    $("apptIssueModal").hidden = false;
  }
  function closeApptIssueModal() { $("apptIssueModal").hidden = true; updateIssueSummary(); }

  // ---------- technicians (Fresha-style chip picker, shared with Check-In) ----------

  async function fetchTechnicians() {
    try {
      const pin = localStorage.getItem(LS_PIN) || "";
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "listTechnicians", pin }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Rejected");
      const names = (data.technicians || []).map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean);
      technicians = names.length ? names : DEFAULT_TECHNICIANS.slice();
    } catch (_) {
      technicians = DEFAULT_TECHNICIANS.slice();
    }
    renderTechnicianPicker();
  }

  function initials(name) {
    const parts = String(name).trim().split(/\s+/);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
  }

  function renderTechnicianPicker() {
    const wrap = $("technicianPicker");
    if (!wrap) return;
    const chips = [{ name: "Any professional", value: "" }].concat(
      technicians.map((name) => ({ name, value: name }))
    );
    wrap.innerHTML = chips.map((chip) => `
      <button type="button" class="technician-chip ${chip.value === selectedTechnician ? "is-selected" : ""}" data-technician="${esc(chip.value)}">
        <span class="technician-chip-avatar">${chip.value ? esc(initials(chip.name)) : "<svg class=\"icon\"><use href=\"#i-user\"></use></svg>"}</span>
        <span class="technician-chip-name">${esc(chip.name)}</span>
      </button>
    `).join("");
    wrap.querySelectorAll(".technician-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTechnician = btn.dataset.technician || "";
        renderTechnicianPicker();
      });
    });
  }

  // ---------- device sync (shared datalist + catalog thumbnail) ----------

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

  function updateDeviceThumb(device) {
    const thumb = $("apptDeviceThumb");
    const img = thumb?.querySelector("img");
    if (!thumb || !img) return;
    thumb.title = device || "";
    thumb.classList.remove("has-image");
    if (!device) return;
    fetchDeviceImage(device).then((url) => {
      if (!url) return;
      img.onload = () => thumb.classList.add("has-image");
      img.onerror = () => thumb.classList.remove("has-image");
      img.src = url;
    });
  }

  function setupDeviceCombobox({ comboboxId, inputId, dropdownId, toggleId, onType, onChoose }) {
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
    closeAppointmentDeviceDropdown = close;

    function choose(name) {
      input.value = name;
      close();
      if (onChoose) onChoose(name);
    }

    input.addEventListener("focus", () => open(true));
    input.addEventListener("click", () => open(true));
    input.addEventListener("input", () => {
      open(false);
      if (onType) onType(input.value.trim());
    });
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
        if (onChoose) onChoose(input.value.trim());
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

  // ---------- appointment lists ----------

  function appointmentRowHtml(item) {
    return `
      <article class="booking-row ${item.status === "completed" ? "is-completed" : ""}">
        <div class="booking-row-main">
          <strong>${esc(item.client)}</strong>
          <p>${esc(item.device)}${item.issue ? " · " + esc(item.issue) : ""}${item.technician ? " · Assigned to " + esc(item.technician) : ""}</p>
          <small>${esc(formatDateTime(item.date, item.time))}${item.phone ? " · " + esc(item.phone) : ""}</small>
        </div>
        <div class="booking-row-actions">
          <button type="button" data-complete="${esc(item.id)}">${item.status === "completed" ? "Reopen" : "Done"}</button>
          <button type="button" class="danger-text" data-delete="${esc(item.id)}">Delete</button>
        </div>
      </article>
    `;
  }

  function completedAppointmentCard(item) {
    const el = document.createElement("div");
    el.className = "ticket st-pickedup";

    const head = document.createElement("div");
    head.className = "ticket-head";
    const hasPhone = !!item.phone;
    const phoneLine = hasPhone
      ? `<a class="ticket-phone" href="tel:${esc(item.phone)}" aria-label="Call ${esc(item.client || "client")}"><svg class="icon ticket-phone-icon"><use href="#i-phone"></use></svg>${esc(item.phone)}</a>`
      : `<span class="ticket-phone no-phone">No number on file</span>`;
    const deviceIcon = deviceTypeIcon(item.device);
    const technicianLabel = item.technician ? `Assigned to ${item.technician}` : "Any professional";
    head.classList.add("no-click");
    head.innerHTML = `
      <div class="ticket-device-thumb" title="${esc(item.device || "Device")}">
        <svg class="icon ticket-device-fallback" aria-hidden="true"><use href="#${deviceIcon}"></use></svg>
        <img alt="" />
      </div>
      <div class="ticket-identity">
        <span class="ticket-num mono">${esc(formatDateTime(item.date, item.time))}</span>
        <div class="ticket-customer">${esc(item.client)}<span class="source-tag source-tag-appointment">Appointment</span></div>
        <div class="ticket-sub">${esc(item.device || "—")}</div>
        ${phoneLine}
      </div>
      <div class="ticket-repair">
        <span class="ticket-repair-label">Repair</span>
        <div class="issue-tags issue-tags-readonly">${issueTagsHtml(item.issue)}</div>
      </div>
      <div class="ticket-status">
        <span class="status-badge st-pickedup">Completed</span>
        <span class="ticket-tech-label">${esc(technicianLabel)}</span>
        <div class="ticket-row-actions">
          <button type="button" data-complete="${esc(item.id)}">Reopen</button>
          <button type="button" class="danger-text" data-delete="${esc(item.id)}">Delete</button>
        </div>
      </div>`;
    const phoneEl = head.querySelector("a.ticket-phone");
    if (phoneEl) phoneEl.onclick = (e) => e.stopPropagation();
    const thumb = head.querySelector(".ticket-device-thumb");
    const thumbImg = head.querySelector(".ticket-device-thumb img");
    if (thumbImg) {
      fetchDeviceImage(item.device).then((url) => {
        if (!url) return;
        thumbImg.onload = () => thumb.classList.add("has-image");
        thumbImg.onerror = () => thumb.classList.remove("has-image");
        thumbImg.src = url;
      });
    }
    el.appendChild(head);
    return el;
  }

  function bindRowActions(list) {
    list.querySelectorAll("[data-complete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        writeAppointments(readAppointments().map((item) =>
          item.id === btn.dataset.complete
            ? Object.assign({}, item, { status: item.status === "completed" ? "scheduled" : "completed" })
            : item
        ));
        renderList();
      });
    });
    list.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        writeAppointments(readAppointments().filter((item) => item.id !== btn.dataset.delete));
        renderList();
        renderSlots();
      });
    });
  }

  function renderList() {
    const upcomingList = $("appointmentList");
    const completedList = $("completedAppointmentsList");
    const appointments = readAppointments().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    const upcoming = appointments.filter((a) => a.status !== "completed");
    const completed = appointments.filter((a) => a.status === "completed");

    if (upcomingList) {
      upcomingList.innerHTML = upcoming.length
        ? upcoming.map(appointmentRowHtml).join("")
        : `<p class="booking-empty">No appointments scheduled yet.</p>`;
      bindRowActions(upcomingList);
    }
    if (completedList) {
      completedList.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const item of completed) frag.appendChild(completedAppointmentCard(item));
      completedList.appendChild(frag);
      bindRowActions(completedList);
    }
  }

  function formatDateTime(dateStr, timeStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${dateLabel} at ${minutesToLabel(timeToMinutes(timeStr))}`;
  }

  function setPanel(panel) {
    document.querySelectorAll(".appt-panel[data-appt-panel-section]").forEach((section) => {
      section.hidden = section.dataset.apptPanelSection !== panel;
    });
    document.querySelectorAll(".appt-subnav-btn[data-appt-panel]").forEach((btn) => {
      const active = btn.dataset.apptPanel === panel;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;

    document.querySelectorAll(".appt-subnav-btn[data-appt-panel]").forEach((btn) => {
      btn.addEventListener("click", () => setPanel(btn.dataset.apptPanel));
    });

    $("bookingPrevMonth")?.addEventListener("click", () => {
      const prev = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
      if (prev >= startOfMonth(new Date())) {
        viewMonth = prev;
        renderCalendar();
      }
    });
    $("bookingNextMonth")?.addEventListener("click", () => {
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
      renderCalendar();
    });
    setupDeviceCombobox({
      comboboxId: "appointmentDeviceCombobox",
      inputId: "appointmentDevice",
      dropdownId: "appointmentDeviceDropdown",
      toggleId: "openApptDeviceDropdown",
      onType: (value) => updateDeviceThumb(value),
      onChoose: (value) => updateDeviceThumb(value),
    });

    $("openApptIssueModal")?.addEventListener("click", openApptIssueModal);
    $("closeApptIssueModal")?.addEventListener("click", closeApptIssueModal);
    $("apptIssueModalDone")?.addEventListener("click", closeApptIssueModal);
    $("apptIssueModal")?.addEventListener("click", (e) => {
      if (e.target.id === "apptIssueModal") closeApptIssueModal();
    });
    $("apptIssueOther")?.addEventListener("input", updateIssueSummary);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("apptIssueModal")?.hidden) closeApptIssueModal();
    });

    $("apptPrevStep")?.addEventListener("click", () => {
      if (currentStep > 1) setStep(currentStep - 1);
    });
    $("apptNextStep")?.addEventListener("click", () => {
      closeAppointmentDeviceDropdown?.();
      const msg = $("apptStep2Message");
      const device = ($("appointmentDevice")?.value || "").trim();
      if (!device) {
        if (msg) { msg.textContent = "Add the device or model."; msg.hidden = false; }
        return;
      }
      if (!selectedIssues.size) {
        if (msg) { msg.textContent = "Select at least one issue."; msg.hidden = false; }
        return;
      }
      if (msg) msg.hidden = true;
      setStep(3);
    });

    const form = $("appointmentForm");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const msg = $("appointmentMessage");
        const client = ($("appointmentClient")?.value || "").trim();
        const device = ($("appointmentDevice")?.value || "").trim();
        if (!client || !device || !selectedDate || !selectedTime) {
          if (msg) { msg.textContent = "Add the client name and device."; msg.hidden = false; }
          return;
        }
        const appointment = {
          id: uid(),
          client,
          phone: ($("appointmentPhone")?.value || "").trim(),
          device,
          issue: buildIssuesString(),
          technician: selectedTechnician || "",
          date: selectedDate,
          time: selectedTime,
          notes: ($("appointmentNotes")?.value || "").trim(),
          status: "scheduled",
          created: new Date().toISOString(),
        };
        writeAppointments([appointment].concat(readAppointments()));
        if (msg) msg.hidden = true;
        renderList();
        const [y, m, d] = appointment.date.split("-").map(Number);
        const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
        const successMsg = $("apptSuccessMessage");
        if (successMsg) {
          successMsg.textContent = `${client}'s appointment is booked for ${dateLabel} at ${minutesToLabel(timeToMinutes(appointment.time))}.`;
        }
        setStep(4);
      });
    }

    $("apptCreateAnother")?.addEventListener("click", () => resetSelection());
    $("apptGoToView")?.addEventListener("click", () => {
      resetSelection();
      setPanel("view");
    });
  }

  function init() {
    bindOnce();
    viewMonth = startOfMonth(new Date());
    renderCalendar();
    renderSlots();
    renderList();
    renderTechnicianPicker();
    populateIssueTags();
    fetchTechnicians();
    setStep(1);
    setPanel("create");
  }

  window.addEventListener("rpc-enter-appointments", init);
  window.addEventListener("rpc-enter-completed-repairs", renderList);
})();
