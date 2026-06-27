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

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let viewMonth = startOfMonth(new Date());
  let selectedDate = null; // "YYYY-MM-DD"
  let selectedTime = null; // "HH:MM"
  let selectedTechnician = ""; // "" = Any professional
  let technicians = [];
  let deviceImageCatalogPromise = null;
  let currentStep = 1;
  let bound = false;

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

    const prevBtn = $("apptPrevStep");
    const confirmBtn = $("apptConfirmBtn");
    if (prevBtn) prevBtn.hidden = n === 1;
    if (confirmBtn) confirmBtn.hidden = n !== 3;

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
    const issueInput = $("appointmentIssue");
    if (issueInput) issueInput.value = "";
    updateDeviceThumb("");
    renderTechnicianPicker();
    renderCalendar();
    renderSlots();
    setStep(1);
  }

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
        maybeAdvanceFromDevice();
      });
    });
  }

  // ---------- device sync (shared datalist + catalog thumbnail) ----------

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

  function maybeAdvanceFromDevice() {
    if (currentStep !== 2) return;
    const device = ($("appointmentDevice")?.value || "").trim();
    if (!device) return;
    setTimeout(() => setStep(3), 250);
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
    const completedList = $("appointmentCompletedList");
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
      completedList.innerHTML = completed.length
        ? completed.map(appointmentRowHtml).join("")
        : `<p class="booking-empty">No completed appointments yet.</p>`;
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
    $("appointmentDevice")?.addEventListener("input", (event) => {
      updateDeviceThumb(event.target.value.trim());
    });
    $("appointmentDevice")?.addEventListener("blur", () => maybeAdvanceFromDevice());
    $("appointmentDevice")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        maybeAdvanceFromDevice();
      }
    });

    $("apptPrevStep")?.addEventListener("click", () => {
      if (currentStep > 1) setStep(currentStep - 1);
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
          issue: ($("appointmentIssue")?.value || "").trim(),
          technician: selectedTechnician || "",
          date: selectedDate,
          time: selectedTime,
          notes: ($("appointmentNotes")?.value || "").trim(),
          status: "scheduled",
          created: new Date().toISOString(),
        };
        writeAppointments([appointment].concat(readAppointments()));
        if (msg) msg.hidden = true;
        resetSelection();
        renderList();
      });
    }
  }

  function init() {
    bindOnce();
    viewMonth = startOfMonth(new Date());
    renderCalendar();
    renderSlots();
    renderList();
    renderTechnicianPicker();
    fetchTechnicians();
    setStep(1);
    setPanel("create");
  }

  window.addEventListener("rpc-enter-appointments", init);
})();
