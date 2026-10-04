/* ---- Client picks their collection day ----------------------------------
   The ready-for-collection email (lib/email.js) carries a signed link per
   repair. It opens a small page (served by api/invoice.js) where the client
   chooses the day — and roughly the time — they'll come in. Confirming books
   it as an appointment in the Appointments tab (with its usual reminder) and
   leaves a note on the repair, so staff see it without anyone typing it in.

   Opening the link never books anything: email scanners follow links on
   their own, so only the page's Confirm button (a POST) does. */
import { bookCollectionAppointment, getCollectionAppointment } from "./appointments.js";
import { addTicketNote } from "./tickets.js";
import { signPublicLink, validPublicLink } from "./security.js";

const LINK_PURPOSE = "collection-day";
// Trinidad & Tobago is UTC-4 all year (no DST) — see lib/appointments.js.
const SHOP_UTC_OFFSET_HOURS = -4;
// Mon–Sat, 8:30 AM–4:30 PM; the last half-hour slot starts at 4:00 PM, the
// same slots as the Appointments tab (assets/appointments.js).
const OPEN_MINUTES = 8 * 60 + 30;
const LAST_SLOT_MINUTES = 16 * 60;
const SLOT_MINUTES = 30;
export const ANY_TIME = "any";
// "Any time" is stored at opening time so the appointment's reminder still
// lands before the shop opens that day.
const ANY_TIME_STORED = "08:30";
// The page offers two weeks of opening days; the email shows the first few.
const PAGE_DAYS = 12;
export const EMAIL_DAYS = 6;
// Repairs that are already over — nothing left to collect.
const CLOSED_STATUSES = new Set(["Picked Up", "Cancelled"]);

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");

/* ---- signed link ---- */

export function collectionToken(ticketId) {
  const id = String(ticketId || "").trim();
  return `${Buffer.from(id).toString("base64url")}.${signPublicLink(LINK_PURPOSE, id)}`;
}

/** The ticket id a token was made for, or "" if it's not a genuine link. */
export function ticketIdFromToken(token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) return "";
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  return id && validPublicLink(LINK_PURPOSE, id, signature) ? id : "";
}

export function collectionUrl(baseUrl, ticketId, day) {
  const base = `${String(baseUrl || "").replace(/\/$/, "")}/api/invoice?pickup=${encodeURIComponent(collectionToken(ticketId))}`;
  return day ? `${base}&day=${encodeURIComponent(day)}` : base;
}

/* ---- days and times ---- */

function shopNow(now = new Date()) {
  // A Date whose UTC fields read as the shop's wall clock.
  return new Date(now.getTime() + SHOP_UTC_OFFSET_HOURS * 3600 * 1000);
}

/** The next `count` opening days (YYYY-MM-DD), starting today if a slot is still ahead. */
export function openDays(count, now = new Date()) {
  const local = shopNow(now);
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes();
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  if (minutesNow >= LAST_SLOT_MINUTES) day.setUTCDate(day.getUTCDate() + 1);
  const days = [];
  while (days.length < count) {
    if (day.getUTCDay() !== 0) days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

/** Slot times ("HH:MM") still open on `day` — today's skip the ones gone by. */
export function timeSlots(day, now = new Date()) {
  const local = shopNow(now);
  const today = local.toISOString().slice(0, 10);
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes();
  const slots = [];
  for (let m = OPEN_MINUTES; m <= LAST_SLOT_MINUTES; m += SLOT_MINUTES) {
    if (day === today && m <= minutesNow) continue;
    slots.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
  }
  return slots;
}

export function timeLabel(value) {
  if (!value || value === ANY_TIME) return "any time, 8:30 AM–4:30 PM";
  const [h, m] = value.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h >= 12 ? "PM" : "AM"}`;
}

/** "Tuesday 6 October" (long) or "Tue 6 Oct" (short). */
export function dayLabel(iso, short = false) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const weekday = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return short
    ? `${weekday.slice(0, 3)} ${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`
    : `${weekday} ${d} ${MONTH_NAMES[m - 1]}`;
}

/* ---- booking ---- */

export function collectionClosed(ticket) {
  return CLOSED_STATUSES.has(ticket?.status);
}

export async function currentCollection(ticketId) {
  return getCollectionAppointment(ticketId);
}

/**
 * Books (or moves) the client's collection. `repair` is the repair done, as
 * named to the client. Throws with a message fit to show the client.
 */
export async function bookCollection({ ticket, repair, day, time, now = new Date() }) {
  if (collectionClosed(ticket)) throw new Error("This repair has already been collected.");
  if (!openDays(PAGE_DAYS, now).includes(day)) throw new Error("Please choose one of the days shown.");
  const anyTime = !time || time === ANY_TIME;
  if (!anyTime && !timeSlots(day, now).includes(time)) throw new Error("Please choose one of the times shown.");
  const when = `${dayLabel(day)}, ${timeLabel(anyTime ? ANY_TIME : time)}`;
  const appointment = await bookCollectionAppointment({
    ticketId: ticket.id,
    client: ticket.customerName,
    phone: ticket.phone,
    device: ticket.device,
    issue: ["Collection", repair].filter(Boolean).join(", "),
    date: day,
    time: anyTime ? ANY_TIME_STORED : time,
    source: "Ready email",
    notes: [
      `Collecting repair #${ticket.id} — chosen by the client from the ready-for-collection email.`,
      anyTime ? "Any time that day (stored at opening time)." : "",
    ].filter(Boolean).join(" "),
  });
  await addTicketNote({ ticketId: ticket.id, note: `Client chose to collect on ${when} (from the ready email).` });
  return { appointment, when };
}

/* ---- the client's page ---- */

function shell(title, inner, accent) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f4f5f7;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#222;line-height:1.5}
  main{max-width:520px;margin:0 auto;padding:24px 16px 40px}
  .card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:22px}
  h1{font-size:21px;margin:0 0 6px}
  p{margin:0 0 12px}
  .muted{color:#667085;font-size:14px}
  .booked{background:#eef6ee;border:1px solid #cfe6cf;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:14px}
  .error{background:#fdecec;border:1px solid #f4c7c7;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:14px;color:#8a1c1c}
  fieldset{border:0;padding:0;margin:18px 0 0}
  legend{font-weight:600;font-size:15px;margin-bottom:8px}
  .days{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .days input{position:absolute;opacity:0;pointer-events:none}
  .days label{display:block;text-align:center;border:1px solid #d0d5dd;border-radius:8px;padding:10px 4px;font-size:14px;cursor:pointer;background:#fff}
  .days label b{display:block;font-size:13px;color:#667085;font-weight:600}
  .days input:checked+label{border-color:${accent};background:${accent};color:#fff}
  .days input:checked+label b{color:#fff}
  .days input:focus-visible+label{outline:2px solid ${accent};outline-offset:2px}
  select{width:100%;font:inherit;padding:10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff}
  button{margin-top:20px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:8px;background:${accent};color:#fff;cursor:pointer}
  a{color:${accent}}
  footer{margin-top:16px;text-align:center;font-size:13px;color:#667085}
</style></head><body><main>${inner}
<footer>Opening hours: 8:30 AM–4:30 PM, Monday to Saturday<br><span style="white-space:nowrap">482-0451</span> / <span style="white-space:nowrap">613-7993</span></footer>
</main></body></html>`;
}

/** Page for a link that's been altered, or a repair that's gone. */
export function collectionUnavailableHtml(business, accent) {
  return shell("Link unavailable", `<div class="card">
    <h1>This link is no longer available</h1>
    <p class="muted">Please contact ${esc(business?.name || "JQ Electronics")} on 482-0451 or 613-7993 to arrange collection.</p>
  </div>`, accent);
}

export function collectionPageHtml({ ticket, repair, business, booked, chosenDay, chosenTime, error, confirmed, selfUrl, accent = "#1f5fbf", now = new Date() }) {
  const name = (ticket.customerName || "").trim().split(/\s+/)[0] || "there";
  const device = ticket.device || "device";
  if (collectionClosed(ticket)) {
    return shell("Already collected", `<div class="card">
      <h1>Already collected</h1>
      <p class="muted">Our records show your ${esc(device)} has already been collected. If that's not right, please call us on 482-0451 or 613-7993.</p>
    </div>`, accent);
  }
  if (confirmed) {
    return shell("Collection booked", `<div class="card">
      <h1>Thanks, ${esc(name)} — see you then!</h1>
      <p>You're booked to collect your ${esc(device)} on <strong>${esc(confirmed)}</strong>.</p>
      <p class="muted">Collect from ${esc([business?.name, ...(business?.addressLines || []).slice(0, 3)].filter(Boolean).join(", "))}.</p>
      <p class="muted">Plans changed? <a href="${esc(selfUrl)}">Choose another day</a>.</p>
    </div>`, accent);
  }
  const days = openDays(PAGE_DAYS, now);
  const day = days.includes(chosenDay) ? chosenDay : (booked && days.includes(booked.date) ? booked.date : days[0]);
  const bookedTime = booked && !/Any time that day/.test(booked.notes || "") ? booked.time : ANY_TIME;
  const time = chosenTime || bookedTime;
  // Every day's slots go in the page; a tiny script shows the chosen day's.
  // Without script, the select lists every slot and the server checks it.
  const slotsByDay = Object.fromEntries(days.map((d) => [d, timeSlots(d, now)]));
  const allSlots = timeSlots("", now);
  const option = (v) => `<option value="${v}"${v === time ? " selected" : ""}>${esc(v === ANY_TIME ? "Any time (8:30 AM–4:30 PM)" : timeLabel(v))}</option>`;
  return shell("Choose your collection day", `<div class="card">
    <h1>Hi ${esc(name)}, when will you collect your ${esc(device)}?</h1>
    <p class="muted">${esc(repair ? `${repair} · ` : "")}Repair #${esc(ticket.id)}</p>
    ${booked ? `<p class="booked">You're booked for <strong>${esc(dayLabel(booked.date))}, ${esc(bookedTime === ANY_TIME ? timeLabel(ANY_TIME) : timeLabel(booked.time))}</strong>. Pick a new day below to change it.</p>` : ""}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post" action="${esc(selfUrl)}">
      <fieldset>
        <legend>Day</legend>
        <div class="days">${days.map((d, i) => `<input type="radio" name="day" id="d${i}" value="${d}"${d === day ? " checked" : ""}><label for="d${i}"><b>${esc(dayLabel(d, true).split(" ")[0])}</b>${esc(dayLabel(d, true).split(" ").slice(1).join(" "))}</label>`).join("")}</div>
      </fieldset>
      <fieldset>
        <legend><label for="time">Roughly what time?</label></legend>
        <select name="time" id="time">${[ANY_TIME, ...allSlots].map(option).join("")}</select>
      </fieldset>
      <button type="submit">Confirm collection day</button>
    </form>
  </div>
  <script>
    (function () {
      var slots = ${JSON.stringify(slotsByDay)};
      var select = document.getElementById("time");
      var label = ${JSON.stringify(Object.fromEntries(allSlots.map((s) => [s, timeLabel(s)])))};
      function refresh() {
        var picked = document.querySelector('input[name="day"]:checked');
        var keep = select.value;
        var list = ["${ANY_TIME}"].concat(slots[picked ? picked.value : ""] || []);
        select.innerHTML = "";
        list.forEach(function (v) {
          var o = document.createElement("option");
          o.value = v;
          o.textContent = v === "${ANY_TIME}" ? "Any time (8:30 AM–4:30 PM)" : label[v];
          if (v === keep) o.selected = true;
          select.appendChild(o);
        });
      }
      document.querySelectorAll('input[name="day"]').forEach(function (r) { r.addEventListener("change", refresh); });
      refresh();
    })();
  </script>`, accent);
}

/* ---- the email's part ---- */

/** Day buttons for the ready email's HTML: each opens the page with that day picked. */
export function collectionEmailHtml(baseUrl, ticketId, accent = "#1f5fbf", now = new Date()) {
  const days = openDays(EMAIL_DAYS, now);
  const button = (d) => `<a href="${esc(collectionUrl(baseUrl, ticketId, d))}" style="display:inline-block;margin:0 6px 8px 0;padding:8px 12px;border:1px solid ${accent};border-radius:6px;color:${accent};text-decoration:none;font-size:13px;font-weight:bold">${esc(dayLabel(d, true))}</a>`;
  return `<tr><td style="padding:0 24px 24px">
    <p style="margin:0 0 10px;font-size:15px;font-weight:bold;color:#111111">When will you collect it?</p>
    <p style="margin:0 0 12px;font-size:13px;color:#666666">Tap a day to let us know — you'll be able to pick a time too.</p>
    <div>${days.map(button).join("")}</div>
    <p style="margin:4px 0 0;font-size:13px"><a href="${esc(collectionUrl(baseUrl, ticketId))}" style="color:${accent}">Another day</a></p>
  </td></tr>`;
}
