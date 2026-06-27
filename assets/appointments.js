/* ============================================================
   Appointments — Cal.com-style booking: pick a day on a month
   calendar, pick an open time slot, then add the client's
   details to confirm. Stored locally (no backend yet); booked
   slots are excluded from the picker so two clients can't be
   double-booked into the same time.
   ============================================================ */

(function () {
  const APPOINTMENTS_KEY = "rpc_repair_appointments";
  const OPEN_HOUR = 8.5; // 8:30 AM
  const CLOSE_HOUR = 16; // 4:00 PM
  const SLOT_MINUTES = 30;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let viewMonth = startOfMonth(new Date());
  let selectedDate = null; // "YYYY-MM-DD"
  let selectedTime = null; // "HH:MM"
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
      hideDetails();
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
        showDetails();
      });
    });
  }

  function timeToMinutes(value) {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  }

  function showDetails() {
    const card = $("bookingDetailsCard");
    const summary = $("bookingSelectedSummary");
    if (!card || !summary || !selectedDate || !selectedTime) return;
    const [y, m, d] = selectedDate.split("-").map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    summary.textContent = `${dateLabel} at ${minutesToLabel(timeToMinutes(selectedTime))} · 30 min · In-store`;
    card.hidden = false;
  }

  function hideDetails() {
    const card = $("bookingDetailsCard");
    if (card) card.hidden = true;
  }

  function resetSelection() {
    selectedDate = null;
    selectedTime = null;
    const form = $("appointmentForm");
    if (form) form.reset();
    hideDetails();
    renderCalendar();
    renderSlots();
  }

  function renderList() {
    const list = $("appointmentList");
    if (!list) return;
    const appointments = readAppointments().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    list.innerHTML = appointments.length
      ? appointments.map((item) => `
        <article class="booking-row ${item.status === "completed" ? "is-completed" : ""}">
          <div class="booking-row-main">
            <strong>${esc(item.client)}</strong>
            <p>${esc(item.device)}${item.issue ? " · " + esc(item.issue) : ""}</p>
            <small>${esc(formatDateTime(item.date, item.time))}${item.phone ? " · " + esc(item.phone) : ""}</small>
          </div>
          <div class="booking-row-actions">
            <button type="button" data-complete="${esc(item.id)}">${item.status === "completed" ? "Reopen" : "Done"}</button>
            <button type="button" class="danger-text" data-delete="${esc(item.id)}">Delete</button>
          </div>
        </article>
      `).join("")
      : `<p class="booking-empty">No appointments scheduled yet.</p>`;

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

  function formatDateTime(dateStr, timeStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${dateLabel} at ${minutesToLabel(timeToMinutes(timeStr))}`;
  }

  function bindOnce() {
    if (bound) return;
    bound = true;

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
    $("cancelBookingDetails")?.addEventListener("click", () => resetSelection());

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
  }

  window.addEventListener("rpc-enter-appointments", init);
})();
