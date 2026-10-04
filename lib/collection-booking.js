/* ---- Client picks their collection day ----------------------------------
   The ready-for-collection email (lib/email.js) opens with a row of
   calendar-style day tiles, each a signed link for that repair. Tapping one
   books the collection for any time that day — no form, no time to pick:
   the page that opens (served by api/invoice.js) posts the booking straight
   away and shows the confirmation. Booking adds it to the Appointments tab,
   raises an alert in the app, leaves a note on the repair and emails the
   shop with an "Add to Google Calendar" button.

   The link itself (a GET) never books: email scanners open links on their
   own, so the page sends the booking from the browser (a POST). Scanners
   that only fetch the page book nothing. */
import { bookCollectionAppointment, getCollectionAppointment, raiseCollectionNotice } from "./appointments.js";
import { addTicketNote } from "./tickets.js";
import { signPublicLink, validPublicLink } from "./security.js";

const LINK_PURPOSE = "collection-day";
// Trinidad & Tobago is UTC-4 all year (no DST) — see lib/appointments.js.
const SHOP_UTC_OFFSET_HOURS = -4;
const SHOP_TIME_ZONE = "America/Port_of_Spain";
// Open Mon–Sat, 8:30 AM–4:30 PM. Today stops being offered at 4:00 PM.
const LAST_BOOKABLE_MINUTES = 16 * 60;
export const OPENING_HOURS = "8:30 AM–4:30 PM";
// Collections are for any time that day; stored at opening time so the
// appointment's reminder lands before the shop opens.
const STORED_TIME = "08:30";
// The page offers two weeks of opening days; the email shows the first few.
const PAGE_DAYS = 12;
export const EMAIL_DAYS = 6;
// Repairs that are already over — nothing left to collect.
const CLOSED_STATUSES = new Set(["Picked Up", "Cancelled"]);

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

/* ---- days ---- */

/** The next `count` opening days (YYYY-MM-DD), starting today until 4 PM. */
export function openDays(count, now = new Date()) {
  // A Date whose UTC fields read as the shop's wall clock.
  const local = new Date(now.getTime() + SHOP_UTC_OFFSET_HOURS * 3600 * 1000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  if (local.getUTCHours() * 60 + local.getUTCMinutes() >= LAST_BOOKABLE_MINUTES) day.setUTCDate(day.getUTCDate() + 1);
  const days = [];
  while (days.length < count) {
    if (day.getUTCDay() !== 0) days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

/** Whether `day` can still be booked: one of the next two weeks' opening days. */
export function isBookableDay(day, now = new Date()) {
  return openDays(PAGE_DAYS, now).includes(day);
}

function dayParts(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return { weekday: DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], day: d, month: MONTH_NAMES[m - 1] };
}

/** "Tuesday 6 October" (long) or "Tue 6 Oct" (short). */
export function dayLabel(iso, short = false) {
  const p = dayParts(iso);
  return short ? `${p.weekday.slice(0, 3)} ${p.day} ${p.month.slice(0, 3)}` : `${p.weekday} ${p.day} ${p.month}`;
}

/** Google Calendar "add event" link for the collection, any time that day. */
export function googleCalendarUrl({ title, day, details, location }) {
  const d = String(day).replace(/-/g, "");
  return "https://calendar.google.com/calendar/render?" + new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${d}T083000/${d}T163000`,
    ctz: SHOP_TIME_ZONE,
    details: details || "",
    location: location || "",
  }).toString();
}

function shopAddress(business) {
  return [business?.name, ...(business?.addressLines || []).slice(0, 3)].filter(Boolean).join(", ");
}

/* ---- booking ---- */

export function collectionClosed(ticket) {
  return CLOSED_STATUSES.has(ticket?.status);
}

export async function currentCollection(ticketId) {
  return getCollectionAppointment(ticketId);
}

/**
 * Books (or moves) the client's collection for any time on `day`, raises the
 * in-app alert and notes it on the repair. `repair` is the repair done, as
 * named to the client. Throws with a message fit to show the client.
 */
export async function bookCollection({ ticket, repair, day, now = new Date() }) {
  if (collectionClosed(ticket)) throw new Error("This repair has already been collected.");
  if (!isBookableDay(day, now)) throw new Error("That day isn't available any more — please pick another.");
  const when = `${dayLabel(day)}, any time ${OPENING_HOURS}`;
  const client = ticket.customerName || "Client";
  const appointment = await bookCollectionAppointment({
    ticketId: ticket.id,
    client,
    phone: ticket.phone,
    device: ticket.device,
    issue: ["Collection", repair].filter(Boolean).join(", "),
    date: day,
    time: STORED_TIME,
    source: "Ready email",
    notes: `Collecting repair #${ticket.id} any time that day (${OPENING_HOURS}) — chosen by the client from the ready-for-collection email.`,
  });
  await raiseCollectionNotice({
    ticketId: ticket.id,
    ticketLabel: `${client} — ${ticket.device || "Device"}`,
    title: `Client coming to collect: ${client} — ${ticket.device || "device"}, ${dayLabel(day, true)}`,
    notes: [
      `${client} chose to collect their ${ticket.device || "device"} on ${when}.`,
      repair ? `Repair: ${repair}.` : "",
      ticket.phone ? `Phone: ${ticket.phone}.` : "",
      `Ticket #${ticket.id}. It's in Appointments.`,
    ].filter(Boolean).join(" "),
  });
  await addTicketNote({ ticketId: ticket.id, note: `Client chose to collect on ${when} (from the ready email).` });
  return { appointment, when };
}

/* ---- shared look: a calendar-page tile per day ---- */

function tile(day, accent, href, size = "email") {
  const p = dayParts(day);
  const big = size === "page";
  const inner = `<span style="display:block;background:${accent};color:#ffffff;font-size:${big ? 12 : 11}px;font-weight:bold;letter-spacing:0.08em;padding:${big ? 5 : 4}px 0">${esc(p.weekday.slice(0, 3).toUpperCase())}</span>`
    + `<span style="display:block;font-size:${big ? 28 : 24}px;font-weight:bold;color:#202124;line-height:1;padding:${big ? 8 : 7}px 0 0">${p.day}</span>`
    + `<span style="display:block;font-size:11px;color:#5f6368;letter-spacing:0.06em;padding:3px 0 ${big ? 8 : 7}px">${esc(p.month.slice(0, 3).toUpperCase())}</span>`;
  return big
    ? `<a class="tile" href="${esc(href)}">${inner}</a>`
    : `<a href="${esc(href)}" style="display:inline-block;width:64px;margin:0 6px 8px 0;border:1px solid #dadce0;border-radius:8px;overflow:hidden;background:#ffffff;text-align:center;text-decoration:none;vertical-align:top">${inner}</a>`;
}

/* ---- the email's part ---- */

/** The "Pick your collection day" card that heads the ready email. */
export function collectionEmailHtml(baseUrl, ticketId, accent = "#1f5fbf", now = new Date()) {
  const days = openDays(EMAIL_DAYS, now);
  return `<tr><td style="padding:16px 24px 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dadce0;border-radius:10px;background:#f8f9fa"><tr><td style="padding:16px 16px 8px">
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr>
        <td style="vertical-align:middle;padding-right:10px;font-size:26px;line-height:1">&#128197;</td>
        <td style="vertical-align:middle">
          <p style="margin:0;font-size:16px;font-weight:bold;color:#202124">Pick your collection day</p>
          <p style="margin:2px 0 0;font-size:13px;color:#5f6368">Tap a day and we'll expect you any time ${esc(OPENING_HOURS)}.</p>
        </td>
      </tr></table>
      <div>${days.map((d) => tile(d, accent, collectionUrl(baseUrl, ticketId, d))).join("")}</div>
      <p style="margin:2px 0 8px;font-size:13px"><a href="${esc(collectionUrl(baseUrl, ticketId))}" style="color:${accent}">Another day</a></p>
    </td></tr></table>
  </td></tr>`;
}

/** The email the shop gets when a client books. Sent by api/invoice.js. */
export function collectionNoticeEmail({ ticket, repair, day, business, accent = "#1f5fbf" }) {
  const client = ticket.customerName || "A client";
  const device = ticket.device || "device";
  const balance = Math.max(0, Math.round((Number(ticket.repairCost || 0) - Number(ticket.amountPaid || 0)) * 100) / 100);
  const calendarUrl = googleCalendarUrl({
    title: `${client} collecting ${device}`,
    day,
    details: [`Repair #${ticket.id}${repair ? ` — ${repair}` : ""}`, ticket.phone ? `Phone: ${ticket.phone}` : "", balance > 0.004 ? `Balance due: TTD $${money(balance)}` : "Paid in full"].filter(Boolean).join("\n"),
    location: shopAddress(business),
  });
  const rows = [
    ["When", `${dayLabel(day)}, any time ${OPENING_HOURS}`],
    ["Phone", ticket.phone],
    ["Device", ticket.device],
    ["Repair", repair],
    ["Ticket", `#${ticket.id}`],
    ["Balance due", balance > 0.004 ? `TTD $${money(balance)}` : "Paid in full"],
  ].filter(([, v]) => v);
  const subject = `Collection booked: ${client} — ${device}, ${dayLabel(day, true)}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#202124">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dadce0;border-radius:10px"><tr><td style="padding:20px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;padding-right:14px">${tile(day, accent, calendarUrl).replace("margin:0 6px 8px 0", "margin:0")}</td>
        <td style="vertical-align:top">
          <p style="margin:0;font-size:12px;font-weight:bold;letter-spacing:0.06em;color:${accent};text-transform:uppercase">Collection booked</p>
          <p style="margin:4px 0 0;font-size:18px;font-weight:bold">${esc(client)} is coming to collect their ${esc(device)}</p>
          <p style="margin:4px 0 0;font-size:14px;color:#5f6368">${esc(dayLabel(day))} · any time ${esc(OPENING_HOURS)}</p>
        </td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-top:1px solid #e8eaed">
        ${rows.map(([k, v]) => `<tr><td style="padding:8px 0;font-size:13px;color:#5f6368;width:38%;border-bottom:1px solid #e8eaed">${esc(k)}</td><td style="padding:8px 0;font-size:14px;border-bottom:1px solid #e8eaed">${esc(v)}</td></tr>`).join("")}
      </table>
      <a href="${esc(calendarUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 16px;border-radius:6px">Add to Google Calendar</a>
      <p style="margin:14px 0 0;font-size:12px;color:#5f6368">Booked by the client from their ready-for-collection email. It's in the app under Appointments, with an alert on screen.</p>
    </td></tr></table>
  </td></tr></table>
</body></html>`;
  const text = [
    `${client} is coming to collect their ${device}.`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    `Add to Google Calendar: ${calendarUrl}`,
  ].join("\n");
  return { subject, html, text };
}

/* ---- the client's page ---- */

function shell(title, inner, accent, head = "") {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>${head}
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f4f5f7;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#202124;line-height:1.5}
  main{max-width:520px;margin:0 auto;padding:24px 16px 40px}
  .card{background:#fff;border:1px solid #dadce0;border-radius:12px;padding:22px}
  h1{font-size:21px;margin:0 0 6px}
  p{margin:0 0 12px}
  .muted{color:#5f6368;font-size:14px}
  .booked{background:#e6f4ea;border:1px solid #ceead6;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:14px}
  .error{background:#fce8e6;border:1px solid #f6c7c2;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:14px;color:#a50e0e}
  .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
  .tile{display:block;border:1px solid #dadce0;border-radius:10px;overflow:hidden;text-align:center;text-decoration:none;background:#fff}
  .tile:hover,.tile:focus-visible{border-color:${accent};box-shadow:0 1px 4px rgba(60,64,67,.25)}
  .event{display:flex;gap:14px;align-items:flex-start;margin:16px 0}
  .event .tile{flex:0 0 72px;pointer-events:none}
  .btn{display:inline-block;margin-top:4px;font:inherit;font-weight:600;padding:11px 16px;border:0;border-radius:8px;background:${accent};color:#fff;text-decoration:none;cursor:pointer}
  a{color:${accent}}
  .spinner{width:28px;height:28px;border:3px solid #dadce0;border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite;margin:6px 0 14px}
  @keyframes spin{to{transform:rotate(360deg)}}
  footer{margin-top:16px;text-align:center;font-size:13px;color:#5f6368}
</style></head><body><main>${inner}
<footer>Opening hours: ${OPENING_HOURS}, Monday to Saturday<br><span style="white-space:nowrap">482-0451</span> / <span style="white-space:nowrap">613-7993</span></footer>
</main></body></html>`;
}

function firstName(ticket) {
  return (ticket.customerName || "").trim().split(/\s+/)[0] || "there";
}

/** Page for a link that's been altered, or a repair that's gone. */
export function collectionUnavailableHtml(business, accent) {
  return shell("Link unavailable", `<div class="card">
    <h1>This link is no longer available</h1>
    <p class="muted">Please contact ${esc(business?.name || "JQ Electronics")} on 482-0451 or 613-7993 to arrange collection.</p>
  </div>`, accent);
}

function alreadyCollectedHtml(ticket, accent) {
  return shell("Already collected", `<div class="card">
    <h1>Already collected</h1>
    <p class="muted">Our records show your ${esc(ticket.device || "device")} has already been collected. If that's not right, please call us on 482-0451 or 613-7993.</p>
  </div>`, accent);
}

/** Opened from a day tile: books it straight away (see the note at the top). */
export function collectionBookingHtml({ ticket, day, selfUrl, accent = "#1f5fbf" }) {
  if (collectionClosed(ticket)) return alreadyCollectedHtml(ticket, accent);
  return shell("Booking your collection day", `<div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h1>Booking ${esc(dayLabel(day))}…</h1>
    <p class="muted">One moment, ${esc(firstName(ticket))}.</p>
    <form id="book" method="post" action="${esc(selfUrl)}">
      <input type="hidden" name="day" value="${esc(day)}">
      <noscript><button class="btn" type="submit">Confirm ${esc(dayLabel(day))}</button></noscript>
    </form>
  </div>
  <script>document.getElementById("book").submit();</script>`, accent);
}

/** "Another day": every opening day for the next two weeks, one tap each. */
export function collectionPageHtml({ ticket, repair, booked, error, selfUrl, accent = "#1f5fbf", now = new Date() }) {
  if (collectionClosed(ticket)) return alreadyCollectedHtml(ticket, accent);
  const days = openDays(PAGE_DAYS, now);
  return shell("Pick your collection day", `<div class="card">
    <h1>Hi ${esc(firstName(ticket))}, when will you collect your ${esc(ticket.device || "device")}?</h1>
    <p class="muted">${esc(repair ? `${repair} · ` : "")}Repair #${esc(ticket.id)} · any time ${esc(OPENING_HOURS)}</p>
    ${booked ? `<p class="booked">You're booked for <strong>${esc(dayLabel(booked.date))}</strong>. Tap another day to change it.</p>` : ""}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <div class="tiles">${days.map((d) => tile(d, accent, `${selfUrl}&day=${d}`, "page")).join("")}</div>
  </div>`, accent);
}

/** After booking: the confirmation, with the client's own calendar button. */
export function collectionConfirmedHtml({ ticket, booked, business, selfUrl, accent = "#1f5fbf" }) {
  if (collectionClosed(ticket)) return alreadyCollectedHtml(ticket, accent);
  const device = ticket.device || "device";
  const calendarUrl = googleCalendarUrl({
    title: `Collect ${device} from ${business?.name || "JQ Electronics"}`,
    day: booked.date,
    details: `Repair #${ticket.id}. Open ${OPENING_HOURS}. Call 482-0451 or 613-7993 with any questions.`,
    location: shopAddress(business),
  });
  return shell("Collection booked", `<div class="card">
    <h1>Thanks, ${esc(firstName(ticket))} — see you then!</h1>
    <div class="event">
      ${tile(booked.date, accent, "#", "page")}
      <div>
        <p style="margin:0;font-weight:600">Collect your ${esc(device)}</p>
        <p class="muted" style="margin:2px 0 0">${esc(dayLabel(booked.date))} · any time ${esc(OPENING_HOURS)}</p>
        <p class="muted" style="margin:2px 0 0">${esc(shopAddress(business))}</p>
      </div>
    </div>
    <a class="btn" href="${esc(calendarUrl)}" target="_blank" rel="noopener">Add to Google Calendar</a>
    <p class="muted" style="margin-top:16px">Plans changed? <a href="${esc(selfUrl)}">Pick another day</a>.</p>
  </div>`, accent);
}
