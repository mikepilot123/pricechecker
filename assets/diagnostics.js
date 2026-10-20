/* ============================================================
   Visual diagnostics — test a repair's device before and after the fix.

   Every test belongs to a repair: staff pick the ticket first (from the
   repairs in the shop, or by search), and the results are saved to that
   ticket as they go — no save button to forget. The repair's detail view
   (assets/intake.js) shows the same results back, with a button to carry
   on testing here.

   The tool is a *picture*, not a checklist: each testable part is a
   hotspot sitting where it physically lives (charging port on the bottom
   edge, volume keys on the left rail, webcam in the laptop lid), and
   setting it colours it in place.

   Tests are grouped into short sections — Display, Cameras, Audio,
   Connectivity, and so on — and staff step through them one at a time
   rather than facing every test at once. The device only ever shows the
   handful of parts belonging to the current section, so it reads as
   "test these two things, here" instead of a field of dots.

   Everything is recorded twice, once BEFORE the repair to capture what
   came in broken and once AFTER to prove what got fixed. The comparison
   panel calls out anything that regressed, which is the thing you never
   want to hand back to a client unnoticed.

   Storage is the ticket_diagnostics table (lib/diagnostics.js). Changes
   that haven't reached the server yet are kept in localStorage and
   retried, so a dropped connection mid-test loses nothing.
   ============================================================ */

(function () {
  const SCRIPT_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  const LS_STATE = "rpc_diagnostics_state";     // which repair/stage/section was open
  const LS_PENDING = "rpc_diagnostics_pending"; // { ticketId: record } not yet saved
  const SAVE_DELAY = 700;
  const RETRY_DELAY = 8000;
  const PICKER_LIMIT = 40;

  // "In the shop" is everything not yet handed back.
  const INACTIVE_STATUSES = new Set(["Picked Up", "Cancelled"]);
  // A repair already at one of these with nothing tested yet opens straight
  // on the after-repair pass — there's no "before" left to record.
  const REPAIRED_STATUSES = new Set(["Repaired", "Checked Out - Waiting on Client", "Picked Up", "No Fix"]);

  const STATES = ["untested", "pass", "fail", "na"];
  const STATE_LABEL = { untested: "Untested", pass: "Pass", fail: "Fail", na: "N/A" };
  const SETTABLE = ["pass", "fail", "na"];

  // Parts sit where they physically are on the device, so the map reads as
  // the device rather than as a list. x/y are in the layout's viewBox units.
  // `groups` splits them into the sections staff step through.
  const LAYOUTS = {
    phone: {
      viewBox: "0 0 300 450",
      frame: `
        <rect class="dg-frame" x="70" y="30" width="160" height="390" rx="26"/>
        <rect class="dg-frame-screen" x="80" y="54" width="140" height="342" rx="14"/>`,
      parts: [
        { key: "earpiece", label: "Earpiece speaker", icon: "i-earbuds", x: 131, y: 42 },
        { key: "frontCamera", label: "Front camera", icon: "i-camera", x: 169, y: 42 },
        { key: "display", label: "Display", icon: "i-screen", x: 120, y: 100 },
        { key: "touch", label: "Touchscreen", icon: "i-touch", x: 180, y: 100 },
        { key: "rearCamera", label: "Rear camera", icon: "i-camera", x: 120, y: 158 },
        { key: "battery", label: "Battery", icon: "i-battery", x: 180, y: 158 },
        { key: "wifi", label: "Wi-Fi / Bluetooth", icon: "i-wifi", x: 120, y: 216 },
        { key: "cellular", label: "Cellular / SIM", icon: "i-signal", x: 180, y: 216 },
        { key: "biometrics", label: "Face ID / fingerprint", icon: "i-face-id", x: 120, y: 274 },
        { key: "vibration", label: "Vibration", icon: "i-vibrate", x: 180, y: 274 },
        { key: "sensors", label: "Proximity / light sensors", icon: "i-target", x: 120, y: 332 },
        { key: "software", label: "Software / boots up", icon: "i-gear", x: 180, y: 332 },
        { key: "volumeButtons", label: "Volume buttons", icon: "i-volume-btn", x: 70, y: 150 },
        { key: "powerButton", label: "Power button", icon: "i-power-btn", x: 230, y: 150 },
        { key: "mic", label: "Microphone", icon: "i-mic", x: 112, y: 408 },
        { key: "charging", label: "Charging port", icon: "i-usb", x: 150, y: 408 },
        { key: "speaker", label: "Loudspeaker", icon: "i-speaker", x: 188, y: 408 },
      ],
      groups: [
        { label: "Display & touch", icon: "i-screen", hint: "Look over the panel, then swipe around the whole screen.", parts: ["display", "touch"] },
        { label: "Cameras", icon: "i-camera", hint: "Open the camera app and try both lenses and the flash.", parts: ["frontCamera", "rearCamera"] },
        { label: "Audio", icon: "i-speaker", hint: "Ring it, play a clip, then record a voice note.", parts: ["earpiece", "speaker", "mic"] },
        { label: "Connectivity", icon: "i-wifi", hint: "Join Wi-Fi, pair Bluetooth, check signal with a SIM in.", parts: ["wifi", "cellular"] },
        { label: "Buttons & sensors", icon: "i-power-btn", hint: "Press every button; test unlock, vibrate and auto-brightness.", parts: ["powerButton", "volumeButtons", "biometrics", "vibration", "sensors"] },
        { label: "Power & software", icon: "i-battery", hint: "Check battery health, plug in to charge, confirm it boots clean.", parts: ["battery", "charging", "software"] },
      ],
    },
    laptop: {
      viewBox: "0 0 400 340",
      frame: `
        <rect class="dg-frame" x="80" y="20" width="240" height="170" rx="10"/>
        <rect class="dg-frame-screen" x="92" y="40" width="216" height="138" rx="6"/>
        <rect class="dg-frame" x="50" y="200" width="300" height="112" rx="10"/>`,
      parts: [
        { key: "webcam", label: "Webcam", icon: "i-camera", x: 200, y: 30 },
        { key: "display", label: "Display", icon: "i-screen", x: 150, y: 95 },
        { key: "wifi", label: "Wi-Fi / Bluetooth", icon: "i-wifi", x: 250, y: 95 },
        { key: "hinge", label: "Hinge", icon: "i-tools", x: 200, y: 195 },
        { key: "keyboard", label: "Keyboard", icon: "i-keyboard", x: 110, y: 232 },
        { key: "speaker", label: "Speakers", icon: "i-speaker", x: 180, y: 232 },
        { key: "ports", label: "USB / video ports", icon: "i-usb", x: 250, y: 232 },
        { key: "powerButton", label: "Power button", icon: "i-power-btn", x: 320, y: 232 },
        { key: "trackpad", label: "Trackpad", icon: "i-touch", x: 110, y: 278 },
        { key: "battery", label: "Battery", icon: "i-battery", x: 180, y: 278 },
        { key: "audio", label: "Audio jack / mic", icon: "i-mic", x: 250, y: 278 },
        { key: "thermals", label: "Fan / thermals", icon: "i-refresh", x: 320, y: 278 },
        { key: "charging", label: "Charging port", icon: "i-usb", x: 50, y: 255 },
      ],
      groups: [
        { label: "Display & lid", icon: "i-screen", hint: "Check the panel for marks, then open and close the lid.", parts: ["display", "webcam", "hinge"] },
        { label: "Input", icon: "i-keyboard", hint: "Type every key and test clicks, scroll and gestures.", parts: ["keyboard", "trackpad"] },
        { label: "Audio", icon: "i-speaker", hint: "Play a clip, then plug in headphones and record something.", parts: ["speaker", "audio"] },
        { label: "Connectivity & ports", icon: "i-wifi", hint: "Join Wi-Fi, pair Bluetooth, try each USB and video port.", parts: ["wifi", "ports"] },
        { label: "Power & thermals", icon: "i-battery", hint: "Check battery health, charge it, listen to the fan under load.", parts: ["battery", "charging", "powerButton", "thermals"] },
      ],
    },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let draft = null;          // the repair being tested — null while picking one
  let records = new Map();   // ticketId → saved diagnostic, for the picker's badges
  let pickerFilter = "active";
  let saveState = "idle";    // idle | dirty | saving | saved | error
  let saveError = "";
  let saveTimer = null;
  let retryTimer = null;
  let saving = null;
  let saveAgain = false;
  let selectSeq = 0;
  let openRequest = null;    // a repair asked for by RPC_OPEN_DIAGNOSTICS
  let ticketsRequested = false;
  let recordsPromise = null;
  let bound = false;

  function newDraft(ticketId, deviceType) {
    return {
      ticketId,
      deviceType: LAYOUTS[deviceType] ? deviceType : "phone",
      stage: "before",
      section: 0,
      before: {},
      after: {},
      notes: "",
      updated: "",
    };
  }

  const layoutFor = (type) => LAYOUTS[type] || LAYOUTS.phone;
  const layout = () => layoutFor(draft && draft.deviceType);
  const groups = () => layout().groups;
  const partByKey = (key) => layout().parts.find((p) => p.key === key);

  function sectionIndex() {
    const max = groups().length - 1;
    return Math.min(Math.max(Number(draft.section) || 0, 0), max);
  }
  const currentGroup = () => groups()[sectionIndex()];

  // Same broad buckets intake.js uses for its device thumbnails — a
  // laptop gets the laptop map, everything else the handheld one.
  function detectType(device) {
    return /\b(macbook|laptop|notebook|chromebook|surface|thinkpad|ideapad|latitude|inspiron|pavilion|elitebook|probook|zenbook|vivobook|xps)\b/i.test(String(device || ""))
      ? "laptop"
      : "phone";
  }

  // ---- Derived data --------------------------------------------------------
  // These take any record (the draft, a saved diagnostic, a pending one) so
  // the repair modal's summary is drawn by exactly the same rules.

  const resultOf = (rec, stage, key) => (rec && rec[stage] && rec[stage][key]) || "untested";

  function tallyOf(rec, stage) {
    const parts = layoutFor(rec && rec.deviceType).parts;
    const out = { pass: 0, fail: 0, na: 0, untested: 0, total: parts.length };
    parts.forEach((p) => { out[resultOf(rec, stage, p.key)] += 1; });
    out.tested = out.total - out.untested;
    return out;
  }

  // fail → pass is the win; pass → fail is the one that must never ship.
  function comparisonOf(rec) {
    const out = { fixed: [], stillFaulty: [], newIssues: [] };
    layoutFor(rec && rec.deviceType).parts.forEach((p) => {
      const before = resultOf(rec, "before", p.key);
      const after = resultOf(rec, "after", p.key);
      if (before === "fail" && after === "pass") out.fixed.push(p);
      else if (before === "fail" && after === "fail") out.stillFaulty.push(p);
      else if (before === "pass" && after === "fail") out.newIssues.push(p);
    });
    return out;
  }

  const stateOf = (stage, key) => resultOf(draft, stage, key);
  const tally = (stage) => tallyOf(draft, stage);
  const comparison = () => comparisonOf(draft);

  function groupTally(group, stage) {
    const out = { tested: 0, fail: 0, total: group.parts.length };
    group.parts.forEach((key) => {
      const s = stateOf(stage, key);
      if (s !== "untested") out.tested += 1;
      if (s === "fail") out.fail += 1;
    });
    out.complete = out.tested === out.total;
    return out;
  }

  function pickStage(rec, ticket) {
    const before = tallyOf(rec, "before");
    const after = tallyOf(rec, "after");
    if (after.tested) return "after";
    if (before.tested && before.tested === before.total) return "after";
    if (!before.tested && ticket && REPAIRED_STATUSES.has(ticket.status)) return "after";
    return "before";
  }

  function firstOpenSection(stage) {
    const i = groups().findIndex((g) => !groupTally(g, stage).complete);
    return i < 0 ? 0 : i;
  }

  function whenLabel(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "";
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // ---- Repairs ---------------------------------------------------------------
  // The ticket list is owned by assets/intake.js; it publishes a copy on
  // window.RPC_INTAKE_TICKETS whenever it loads.

  const allTickets = () => (Array.isArray(window.RPC_INTAKE_TICKETS) ? window.RPC_INTAKE_TICKETS : []);
  const findTicket = (id) => allTickets().find((t) => t.id === id);
  const statusClass = (status) => (window.RPC_STATUS_CLASS && window.RPC_STATUS_CLASS[status]) || "st-received";
  const deviceIcon = (type) => (type === "laptop" ? "i-laptop" : "i-smartphone");

  function storedPin() {
    try { return localStorage.getItem(LS_PIN) || ""; } catch (_) { return ""; }
  }

  // Repairs only loads its list when that tab is opened, so ask it to if
  // this tab is reached first.
  async function ensureTickets() {
    if (Array.isArray(window.RPC_INTAKE_TICKETS) || ticketsRequested || !storedPin()) return;
    if (typeof window.RPC_RELOAD_TICKETS !== "function") return;
    ticketsRequested = true;
    try { await window.RPC_RELOAD_TICKETS(); } catch (_) { /* Repairs shows its own error */ }
    ticketsRequested = false;
  }

  // ---- Server --------------------------------------------------------------

  async function api(payload, { keepalive = false } = {}) {
    // text/plain avoids a CORS preflight, matching how Check-In calls the API.
    const res = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: storedPin() }, payload)),
      keepalive,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Rejected");
    return data;
  }

  const payloadOf = (rec) => ({
    ticketId: rec.ticketId,
    deviceType: rec.deviceType,
    before: rec.before || {},
    after: rec.after || {},
    notes: rec.notes || "",
  });

  function readPending() {
    try {
      const map = JSON.parse(localStorage.getItem(LS_PENDING) || "{}");
      return map && typeof map === "object" && !Array.isArray(map) ? map : {};
    } catch (_) { return {}; }
  }

  function writePending(map) {
    try {
      if (Object.keys(map).length) localStorage.setItem(LS_PENDING, JSON.stringify(map));
      else localStorage.removeItem(LS_PENDING);
    } catch (_) { /* storage full/unavailable — the in-memory draft still saves */ }
  }

  function loadRecords() {
    if (!storedPin()) return Promise.resolve();
    if (recordsPromise) return recordsPromise;
    recordsPromise = api({ action: "listTicketDiagnostics" })
      .then((data) => {
        records = new Map((data.diagnostics || []).map((d) => [d.ticketId, d]));
        // Unsaved local changes are newer than anything the server has.
        Object.values(readPending()).forEach((p) => records.set(p.ticketId, Object.assign({}, records.get(p.ticketId), p)));
      })
      .catch(() => { /* badges just stay as they were */ })
      .finally(() => {
        recordsPromise = null;
        if (!$("dgPicker")?.hidden) renderPicker();
      });
    return recordsPromise;
  }

  // Sends one record and, if nothing has changed since it was sent, drops it
  // from the unsaved list.
  async function pushRecord(rec, opts) {
    const body = payloadOf(rec);
    const sent = JSON.stringify(body);
    let diagnostic = null;
    try {
      diagnostic = (await api(Object.assign({ action: "saveTicketDiagnostic" }, body), opts)).diagnostic;
    } catch (err) {
      // A repair deleted since the test was run can never be saved to —
      // let it go rather than retrying forever.
      if (!/ticket not found/i.test(String(err && err.message))) throw err;
    }
    if (diagnostic) records.set(body.ticketId, diagnostic);
    else records.delete(body.ticketId);
    const pending = readPending();
    if (pending[body.ticketId] && JSON.stringify(payloadOf(pending[body.ticketId])) === sent) {
      delete pending[body.ticketId];
      writePending(pending);
    }
    return diagnostic;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flushPending, RETRY_DELAY);
  }

  function saveNow(opts) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!draft) return Promise.resolve();
    if (saving) { saveAgain = true; return saving; }
    const target = draft;
    saveState = "saving";
    renderSaveState();
    saving = pushRecord(target, opts)
      .then((diagnostic) => {
        if (draft !== target) return;
        draft.updated = diagnostic ? diagnostic.updated : "";
        saveError = "";
        // Edits made while this was in flight are still on their way.
        saveState = saveTimer || saveAgain ? "dirty" : "saved";
      }, (err) => {
        if (draft !== target) return;
        const message = String((err && err.message) || err);
        saveError = /invalid pin/i.test(message)
          ? "Not saved — reconnect this device in Settings"
          : "Not saved yet — retrying";
        saveState = "error";
        if (!/invalid pin/i.test(message)) scheduleRetry();
      })
      .then(() => {
        saving = null;
        if (saveAgain) {
          saveAgain = false;
          if (draft === target) return saveNow(opts);
        }
        renderSaveState();
      });
    return saving;
  }

  // Everything this device still owes the server, including tests on other
  // repairs that were run while offline.
  async function flushPending() {
    clearTimeout(retryTimer);
    const pending = readPending();
    for (const id of Object.keys(pending)) {
      if (draft && draft.ticketId === id) { await saveNow(); continue; }
      try { await pushRecord(pending[id]); }
      catch (_) { scheduleRetry(); return; }
    }
  }

  // Every edit lands in the unsaved list straight away, then goes to the
  // server once tapping pauses — so a burst of "All pass" taps is one save.
  function markChanged() {
    if (!draft) return;
    const pending = readPending();
    pending[draft.ticketId] = payloadOf(draft);
    writePending(pending);
    records.set(draft.ticketId, Object.assign({}, records.get(draft.ticketId), payloadOf(draft)));
    saveState = "dirty";
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    saveTimer = setTimeout(() => saveNow(), SAVE_DELAY);
    render();
  }

  function rememberState() {
    try {
      if (!draft) localStorage.removeItem(LS_STATE);
      else localStorage.setItem(LS_STATE, JSON.stringify({ ticketId: draft.ticketId, stage: draft.stage, section: draft.section }));
    } catch (_) { /* non-fatal */ }
  }

  function readState() {
    try { return JSON.parse(localStorage.getItem(LS_STATE) || "null"); } catch (_) { return null; }
  }

  // ---- Choosing a repair ---------------------------------------------------

  async function selectTicket(id, opts = {}) {
    const ticket = findTicket(id);
    if (!ticket) {
      toast("Couldn't find that repair — it may have been deleted.");
      showPicker();
      return;
    }
    // Finish saving the repair being left before switching away from it.
    if (draft && draft.ticketId !== id && (saveTimer || saving)) await saveNow();

    const seq = ++selectSeq;
    const pending = readPending()[id] || null;
    let record = pending;
    if (!record) {
      try {
        record = (await api({ action: "getTicketDiagnostic", ticketId: id })).diagnostic;
        if (record) records.set(id, record);
        else records.delete(id);
      } catch (_) {
        // Starting blank here would overwrite results saved from another
        // device the moment anything was tapped, so don't open it at all.
        if (seq !== selectSeq) return;
        toast("Couldn't load this repair's saved results — check the connection and try again.");
        showPicker();
        return;
      }
    }
    if (seq !== selectSeq) return;

    draft = newDraft(id, record ? record.deviceType : detectType(ticket.device));
    if (record) {
      draft.before = Object.assign({}, record.before);
      draft.after = Object.assign({}, record.after);
      draft.notes = record.notes || "";
      draft.updated = record.updated || "";
    }
    draft.stage = opts.stage === "before" || opts.stage === "after" ? opts.stage : pickStage(draft, ticket);
    draft.section = Number.isInteger(opts.section) ? opts.section : firstOpenSection(draft.stage);
    draft.section = sectionIndex();
    saveError = "";
    saveState = pending ? "dirty" : record ? "saved" : "idle";
    rememberState();
    showWorkspace();
    if (pending) saveNow();
  }

  async function leaveRepair() {
    if (draft && (saveTimer || saving)) await saveNow();
    draft = null;
    selectSeq++;
    rememberState();
    showPicker();
    $("dgRepairSearch")?.focus();
  }

  function diagBadge(rec) {
    if (!rec) return { cls: "", text: "Not tested" };
    const before = tallyOf(rec, "before");
    const after = tallyOf(rec, "after");
    if (after.tested) {
      const c = comparisonOf(rec);
      if (c.newIssues.length) return { cls: "is-new", text: `${c.newIssues.length} new issue${c.newIssues.length === 1 ? "" : "s"}` };
      if (after.fail) return { cls: "is-still", text: `After · ${after.fail} fail` };
      return { cls: "is-fixed", text: after.tested === after.total ? "After · all pass" : `After · ${after.tested}/${after.total}` };
    }
    if (before.tested) {
      return {
        cls: before.fail ? "is-still" : "is-fixed",
        text: `Before · ${before.fail} fail${before.tested < before.total ? ` · ${before.tested}/${before.total}` : ""}`,
      };
    }
    return { cls: "", text: "Notes only" };
  }

  function renderPicker() {
    const box = $("dgPickerList");
    if (!box) return;
    const query = String($("dgRepairSearch")?.value || "").trim().toLowerCase();
    document.querySelectorAll("[data-dg-filter]").forEach((btn) => {
      const active = !query && btn.dataset.dgFilter === pickerFilter;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    if (!storedPin()) {
      box.innerHTML = `<p class="ops-empty">This device isn't connected to the shop yet — open <strong>Repairs</strong> and enter the team PIN, then come back here.</p>`;
      return;
    }
    if (!Array.isArray(window.RPC_INTAKE_TICKETS)) {
      box.innerHTML = `<p class="ops-empty">Loading repairs…</p>`;
      return;
    }

    const tickets = allTickets();
    let list;
    if (query) {
      list = tickets.filter((t) =>
        [t.customerName, t.phone, t.email, t.device, t.id, t.issues]
          .some((v) => String(v || "").toLowerCase().includes(query))
      );
    } else if (pickerFilter === "tested") {
      list = tickets
        .filter((t) => records.has(t.id))
        .sort((a, b) => String(records.get(b.id).updated || "").localeCompare(String(records.get(a.id).updated || "")));
    } else if (pickerFilter === "active") {
      list = tickets.filter((t) => !INACTIVE_STATUSES.has(t.status));
    } else {
      list = tickets.slice();
    }

    if (!list.length) {
      const empty = query
        ? `No repair matches “${esc(query)}”.`
        : pickerFilter === "tested"
          ? "No repairs have been tested yet — pick one under <strong>In the shop</strong> to start."
          : pickerFilter === "active"
            ? "No repairs in the shop right now."
            : "No repairs logged yet.";
      box.innerHTML = `<p class="ops-empty">${empty}</p>`;
      return;
    }

    const shown = list.slice(0, PICKER_LIMIT);
    box.innerHTML = (query ? `<p class="dg-picker-note">Searching all repairs</p>` : "") + shown.map((t) => {
      const badge = diagBadge(records.get(t.id));
      return `
        <button type="button" class="dg-pick-row" data-dg-pick="${esc(t.id)}">
          <span class="dg-pick-icon"><svg class="icon"><use href="#${deviceIcon(detectType(t.device))}"></use></svg></span>
          <span class="dg-pick-main">
            <span class="dg-pick-name">${esc(t.customerName || "Unnamed client")}</span>
            <span class="dg-pick-sub">${esc(t.device || "No device")} · <span class="mono">#${esc(t.id || "")}</span></span>
          </span>
          <span class="dg-pick-tags">
            <span class="status-badge ${statusClass(t.status)}">${esc(t.status || "—")}</span>
            <span class="dg-saved-stat ${badge.cls}">${esc(badge.text)}</span>
          </span>
          <svg class="icon dg-pick-go" aria-hidden="true"><use href="#i-chevron-right"></use></svg>
        </button>`;
    }).join("") + (list.length > shown.length
      ? `<p class="dg-picker-note">Showing ${shown.length} of ${list.length} — search to find the rest.</p>`
      : "");
  }

  function showPicker() {
    if ($("dgPicker")) $("dgPicker").hidden = false;
    if ($("dgWorkspace")) $("dgWorkspace").hidden = true;
    renderPicker();
    renderStatusLine();
  }

  function showWorkspace() {
    if ($("dgPicker")) $("dgPicker").hidden = true;
    if ($("dgWorkspace")) $("dgWorkspace").hidden = false;
    renderFields();
    render();
  }

  // ---- Rendering -----------------------------------------------------------

  function renderRepairCard() {
    const box = $("dgRepairCard");
    if (!box) return;
    const t = findTicket(draft.ticketId) || { id: draft.ticketId };
    box.innerHTML = `
      <span class="dg-repair-icon"><svg class="icon"><use href="#${deviceIcon(draft.deviceType)}"></use></svg></span>
      <div class="dg-repair-main">
        <p class="dg-repair-eyebrow">Testing repair <span class="mono">#${esc(t.id)}</span></p>
        <h3 class="dg-repair-title">${esc(t.device || "Device")}</h3>
        <p class="dg-repair-sub">${esc(t.customerName || "Unnamed client")}${t.issues ? ` · ${esc(t.issues)}` : ""}</p>
      </div>
      <div class="dg-repair-side">
        ${t.status ? `<span class="status-badge ${statusClass(t.status)}">${esc(t.status)}</span>` : ""}
        <span id="dgSaveState" class="dg-save-state" aria-live="polite"></span>
      </div>`;
    renderSaveState();
  }

  function renderSaveState() {
    const el = $("dgSaveState");
    if (!el || !draft) return;
    let cls = "";
    let html = "";
    if (saveState === "dirty" || saveState === "saving") {
      cls = "is-pending";
      html = `<span class="dg-save-dot"></span>Saving…`;
    } else if (saveState === "saved") {
      cls = "is-saved";
      html = `<svg class="icon"><use href="#i-check"></use></svg>Saved to repair${draft.updated ? ` · ${esc(whenLabel(draft.updated))}` : ""}`;
    } else if (saveState === "error") {
      cls = "is-error";
      html = `<svg class="icon"><use href="#i-alert"></use></svg>${esc(saveError)}<button type="button" class="dg-save-retry" id="dgSaveRetry">Retry</button>`;
    } else {
      html = `Results save to this repair as you test`;
    }
    el.className = `dg-save-state ${cls}`;
    el.innerHTML = html;
  }

  // Only the current section's parts are drawn. Showing all seventeen at
  // once — even dimmed — buries the handful actually being tested under a
  // field of dots; an near-empty device with two markers on it says
  // "test these two things, here" at a glance.
  function renderMap() {
    const box = $("dgMap");
    if (!box) return;
    const l = layout();
    const g = currentGroup();
    const hotspots = g.parts.map((key) => {
      const p = partByKey(key);
      if (!p) return "";
      const state = stateOf(draft.stage, key);
      return `
        <g class="dg-hotspot state-${state}" data-dg-part="${esc(p.key)}"
           transform="translate(${p.x},${p.y})" role="button" tabindex="0"
           aria-label="${esc(p.label)}: ${STATE_LABEL[state]}">
          <title>${esc(p.label)} — ${STATE_LABEL[state]}</title>
          <circle class="dg-dot" r="22"/>
          <use class="dg-dot-icon" href="#${esc(p.icon)}" x="-12" y="-12" width="24" height="24"/>
          ${state === "pass" ? `<circle class="dg-dot-badge" cx="16" cy="-16" r="7"/><path class="dg-dot-tick" d="M12.8 -16.4l2.2 2.2 4.2-4.4"/>` : ""}
          ${state === "fail" ? `<circle class="dg-dot-badge" cx="16" cy="-16" r="7"/><path class="dg-dot-tick" d="M13.4 -18.6l5.2 5.2M18.6 -18.6l-5.2 5.2"/>` : ""}
          ${state === "na" ? `<circle class="dg-dot-badge" cx="16" cy="-16" r="7"/><path class="dg-dot-tick" d="M13 -16h6"/>` : ""}
        </g>`;
    }).join("");

    box.innerHTML = `
      <svg class="dg-svg" viewBox="${l.viewBox}" role="group" aria-label="${esc(g.label)} — tap a part on the device to set its result">
        ${l.frame}
        ${hotspots}
      </svg>`;
  }

  function renderStepper() {
    const box = $("dgStepper");
    if (!box) return;
    const active = sectionIndex();
    box.innerHTML = groups().map((g, i) => {
      const t = groupTally(g, draft.stage);
      const cls = ["dg-step"];
      if (i === active) cls.push("active");
      if (t.complete) cls.push("is-complete");
      if (t.fail) cls.push("has-fail");
      return `
        <button type="button" class="${cls.join(" ")}" data-dg-section="${i}" role="tab"
          aria-selected="${i === active ? "true" : "false"}" title="${esc(g.label)} — ${t.tested}/${t.total} tested">
          <span class="dg-step-mark">${t.complete ? `<svg class="icon"><use href="#i-check"></use></svg>` : i + 1}</span>
          <span class="dg-step-text">
            <span class="dg-step-label">${esc(g.label)}</span>
            <span class="dg-step-meta">${t.tested}/${t.total}${t.fail ? ` · ${t.fail} fail` : ""}</span>
          </span>
        </button>`;
    }).join("");
  }

  function renderSectionPanel() {
    const box = $("dgSectionPanel");
    if (!box) return;
    const g = currentGroup();
    const t = groupTally(g, draft.stage);
    const rows = g.parts.map((key) => {
      const p = partByKey(key);
      if (!p) return "";
      const state = stateOf(draft.stage, key);
      const buttons = SETTABLE.map((s) => `
        <button type="button" class="dg-test-btn is-${s}${state === s ? " active" : ""}"
          data-dg-set="${esc(key)}" data-dg-value="${s}" aria-pressed="${state === s ? "true" : "false"}">
          ${STATE_LABEL[s]}
        </button>`).join("");
      return `
        <div class="dg-test-card state-${state}">
          <span class="dg-test-icon"><svg class="icon"><use href="#${esc(p.icon)}"></use></svg></span>
          <span class="dg-test-name">${esc(p.label)}</span>
          <span class="dg-test-btns">${buttons}</span>
        </div>`;
    }).join("");

    box.innerHTML = `
      <div class="dg-section-head">
        <span class="dg-section-icon"><svg class="icon"><use href="#${esc(g.icon)}"></use></svg></span>
        <div class="dg-section-titles">
          <p class="dg-section-eyebrow">Section ${sectionIndex() + 1} of ${groups().length} · ${draft.stage === "before" ? "Before repair" : "After repair"}</p>
          <h3 class="dg-section-title">${esc(g.label)}</h3>
        </div>
        <span class="dg-section-count${t.complete ? " is-complete" : ""}">${t.tested}/${t.total}</span>
      </div>
      <p class="dg-section-hint">${esc(g.hint)}</p>
      <div class="dg-section-quick">
        <button type="button" class="dg-quick-btn is-pass" data-dg-section-bulk="pass">All pass</button>
        <button type="button" class="dg-quick-btn is-na" data-dg-section-bulk="na">All N/A</button>
        <button type="button" class="dg-quick-btn" data-dg-section-bulk="clear">Clear</button>
      </div>
      <div class="dg-test-cards">${rows}</div>`;
  }

  function renderSectionNav() {
    const prev = $("dgPrevSection");
    const next = $("dgNextSection");
    const i = sectionIndex();
    const last = groups().length - 1;
    if (prev) prev.disabled = i === 0;
    if (next) {
      const done = groupTally(currentGroup(), draft.stage).complete;
      const stageDone = tally(draft.stage).untested === 0;
      // The last section of a finished before-pass leads straight on to
      // the after-pass, so nobody has to hunt for the stage switch.
      const toAfter = i === last && draft.stage === "before" && stageDone;
      next.disabled = i === last && !toAfter;
      next.classList.toggle("attention", (done && i < last) || toAfter);
      next.innerHTML = toAfter
        ? `Start after-repair test<svg class="icon"><use href="#i-chevron-right"></use></svg>`
        : i === last
          ? `All sections done<svg class="icon"><use href="#i-check"></use></svg>`
          : `Next: ${esc(groups()[i + 1].label)}<svg class="icon"><use href="#i-chevron-right"></use></svg>`;
    }
  }

  function renderTypeSwitch() {
    document.querySelectorAll("[data-dg-type]").forEach((btn) => {
      const active = btn.dataset.dgType === draft.deviceType;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function renderStage() {
    document.querySelectorAll("[data-dg-stage]").forEach((btn) => {
      const active = btn.dataset.dgStage === draft.stage;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    ["before", "after"].forEach((stage) => {
      const el = document.querySelector(`[data-dg-stage-meta="${stage}"]`);
      if (!el) return;
      const t = tally(stage);
      el.textContent = t.tested ? `${t.tested}/${t.total} tested · ${t.fail} fail` : "Not started";
    });
  }

  function renderProgress() {
    const box = $("dgProgress");
    if (!box) return;
    const t = tally(draft.stage);
    const pct = t.total ? Math.round((t.tested / t.total) * 100) : 0;
    box.innerHTML = `
      <div class="dg-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
           aria-label="${draft.stage === "before" ? "Before" : "After"} repair progress">
        <div class="dg-progress-fill" style="width:${pct}%"></div>
      </div>
      <p class="dg-progress-sub">${t.tested}/${t.total} tested · <span class="dg-ink-pass">${t.pass} pass</span> · <span class="dg-ink-fail">${t.fail} fail</span></p>`;
  }

  function renderOverview() {
    const box = $("dgOverview");
    if (!box) return;
    const before = tally("before");
    const after = tally("after");
    const active = tally(draft.stage);
    const activeLabel = draft.stage === "before" ? "Before" : "After";
    const activePct = active.total ? Math.round((active.tested / active.total) * 100) : 0;
    box.innerHTML = `
      <div class="dg-overview-item${draft.stage === "before" ? " active" : ""}">
        <span class="dg-overview-label">Before</span>
        <strong>${before.tested}/${before.total}</strong>
        <span>${before.fail} fail</span>
      </div>
      <div class="dg-overview-item${draft.stage === "after" ? " active" : ""}">
        <span class="dg-overview-label">After</span>
        <strong>${after.tested}/${after.total}</strong>
        <span>${after.fail} fail</span>
      </div>
      <div class="dg-overview-active">
        <span class="dg-overview-label">${activeLabel} progress</span>
        <div class="dg-overview-bar"><span style="width:${activePct}%"></span></div>
      </div>`;
  }

  function renderCompare() {
    const box = $("dgCompare");
    if (!box) return;
    const c = comparison();
    const beforeTested = tally("before").tested;
    const afterTested = tally("after").tested;

    if (!beforeTested || !afterTested) {
      box.innerHTML = `
        <div class="dg-compare-empty">
          <svg class="icon"><use href="#i-diagnose"></use></svg>
          <p>${!beforeTested
            ? "Run the <strong>before repair</strong> pass first — then the after pass to see what changed."
            : "Now run the <strong>after repair</strong> pass to compare it against the before results."}</p>
        </div>`;
      return;
    }

    const chips = (list) => list.length
      ? list.map((p) => `<span class="dg-chip">${esc(p.label)}</span>`).join("")
      : `<span class="dg-chip dg-chip-none">None</span>`;

    box.innerHTML = `
      <p class="dg-compare-title">Before → after</p>
      <div class="dg-compare-grid">
        <div class="dg-compare-block is-fixed">
          <span class="dg-compare-count">${c.fixed.length}</span>
          <span class="dg-compare-label">Fixed</span>
          <div class="dg-chips">${chips(c.fixed)}</div>
        </div>
        <div class="dg-compare-block is-still">
          <span class="dg-compare-count">${c.stillFaulty.length}</span>
          <span class="dg-compare-label">Still faulty</span>
          <div class="dg-chips">${chips(c.stillFaulty)}</div>
        </div>
        <div class="dg-compare-block is-new${c.newIssues.length ? " is-alert" : ""}">
          <span class="dg-compare-count">${c.newIssues.length}</span>
          <span class="dg-compare-label">New issues</span>
          <div class="dg-chips">${chips(c.newIssues)}</div>
        </div>
      </div>
      ${c.newIssues.length ? `<p class="dg-compare-warning"><svg class="icon"><use href="#i-alert"></use></svg>Something that worked before the repair is failing now — check these before handing the device back.</p>` : ""}`;
  }

  function renderFields() {
    if (!draft) return;
    if ($("dgNotes") && $("dgNotes").value !== draft.notes) $("dgNotes").value = draft.notes;
  }

  function renderStatusLine() {
    const el = $("dgStatusLine");
    if (!el) return;
    if (!draft) {
      el.textContent = records.size ? `${records.size} repair${records.size === 1 ? "" : "s"} tested` : "";
      return;
    }
    const b = tally("before");
    const a = tally("after");
    el.textContent = b.tested || a.tested
      ? `Before ${b.tested}/${b.total} · After ${a.tested}/${a.total}`
      : "";
  }

  // Everything except the notes box, which is left alone so typing never
  // loses focus or caret position.
  function render() {
    if (!draft) return;
    renderRepairCard();
    renderTypeSwitch();
    renderStage();
    renderStepper();
    renderMap();
    renderSectionPanel();
    renderSectionNav();
    renderOverview();
    renderProgress();
    renderCompare();
    renderStatusLine();
  }

  // ---- Interactions --------------------------------------------------------

  function setPartState(key, value) {
    // Tapping the state a part is already in clears it back to untested,
    // so a mis-tap is undone with a second tap on the same button.
    if (stateOf(draft.stage, key) === value) delete draft[draft.stage][key];
    else draft[draft.stage][key] = value;
    markChanged();
  }

  function cyclePart(key) {
    const current = stateOf(draft.stage, key);
    const next = STATES[(STATES.indexOf(current) + 1) % STATES.length];
    if (next === "untested") delete draft[draft.stage][key];
    else draft[draft.stage][key] = next;
    markChanged();
  }

  function setCurrentSectionState(value) {
    currentGroup().parts.forEach((key) => {
      if (value === "clear") delete draft[draft.stage][key];
      else draft[draft.stage][key] = value;
    });
    markChanged();
  }

  function setSection(index) {
    const max = groups().length - 1;
    draft.section = Math.min(Math.max(index, 0), max);
    rememberState();
    render();
    $("dgStepper")?.querySelector(".dg-step.active")?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }

  function setStage(stage) {
    draft.stage = stage === "after" ? "after" : "before";
    draft.section = firstOpenSection(draft.stage);
    rememberState();
    render();
  }

  function nextSection() {
    const i = sectionIndex();
    if (i === groups().length - 1 && draft.stage === "before") {
      setStage("after");
      $("dgWorkspace")?.querySelector(".dg-stage-bar")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setSection(i + 1);
  }

  function setDeviceType(type) {
    if (!LAYOUTS[type] || draft.deviceType === type) return;
    draft.deviceType = type;
    draft.section = 0; // the two layouts have different sections
    rememberState();
    markChanged();
  }

  // Clears just the current stage's results, keeping the notes and the
  // other stage — for when a test run needs starting over.
  function resetStage() {
    const stageLabel = draft.stage === "before" ? "before repair" : "after repair";
    if (!tally(draft.stage).tested) {
      toast(`Nothing recorded in the ${stageLabel} test yet.`);
      return;
    }
    if (!window.confirm(`Clear every result in the ${stageLabel} test for this repair? The notes and the other test are kept.`)) return;
    draft[draft.stage] = {};
    draft.section = 0;
    rememberState();
    markChanged();
    toast(`Cleared the ${stageLabel} test.`);
  }

  async function openRepair() {
    if (!draft) return;
    const id = draft.ticketId;
    if (saveTimer || saving) await saveNow();
    if (typeof window.RPC_OPEN_TICKET_BY_ID === "function") window.RPC_OPEN_TICKET_BY_ID(id);
  }

  // ---- Summary text (Copy summary) -----------------------------------------

  function summaryText(rec, ticket) {
    const l = layoutFor(rec.deviceType);
    const c = comparisonOf(rec);
    const t = ticket || {};
    const lines = [];
    lines.push(`Device Diagnostic${t.device ? ` — ${t.device}` : ""}`);
    if (t.customerName || t.phone) lines.push(`Client: ${t.customerName || "—"}${t.phone ? ` (${t.phone})` : ""}`);
    lines.push(`Repair: #${rec.ticketId}`);
    lines.push(new Date(rec.updated || Date.now()).toLocaleDateString());
    lines.push("");

    ["before", "after"].forEach((stage) => {
      if (!tallyOf(rec, stage).tested) return;
      lines.push(stage === "before" ? "BEFORE REPAIR" : "AFTER REPAIR");
      l.groups.forEach((g) => {
        const tested = g.parts.filter((k) => resultOf(rec, stage, k) !== "untested");
        if (!tested.length) return;
        lines.push(`  ${g.label}`);
        tested.forEach((k) => {
          const s = resultOf(rec, stage, k);
          const p = l.parts.find((part) => part.key === k);
          lines.push(`  ${s === "pass" ? "[OK]" : s === "fail" ? "[X]" : "[-]"} ${p ? p.label : k}`);
        });
      });
      lines.push("");
    });

    if (tallyOf(rec, "before").tested && tallyOf(rec, "after").tested) {
      lines.push(`Fixed (${c.fixed.length}): ${c.fixed.map((p) => p.label).join(", ") || "—"}`);
      lines.push(`Still faulty (${c.stillFaulty.length}): ${c.stillFaulty.map((p) => p.label).join(", ") || "—"}`);
      lines.push(`New issues (${c.newIssues.length}): ${c.newIssues.map((p) => p.label).join(", ") || "—"}`);
      lines.push("");
    }
    if (String(rec.notes || "").trim()) {
      lines.push("Notes");
      lines.push(rec.notes.trim());
    }
    return lines.join("\n").trim();
  }

  async function copyText(text, btn) {
    const original = btn ? btn.innerHTML : "";
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      if (btn) {
        btn.innerHTML = `<svg class="icon"><use href="#i-check"></use></svg>Copied`;
        setTimeout(() => { btn.innerHTML = original; }, 1600);
      }
    } catch (_) {
      if (btn) {
        btn.innerHTML = "Copy failed";
        setTimeout(() => { btn.innerHTML = original; }, 1600);
      }
    }
  }

  function toast(message) {
    if (typeof window.RPC_TOAST === "function") window.RPC_TOAST(message, { tone: "info", duration: 3000 });
  }

  // ---- Summary inside the repair's detail view -----------------------------
  // assets/intake.js calls this when a repair is opened, passing the
  // container in its modal.

  function ticketSummaryHtml(rec, loadFailed) {
    const before = rec ? tallyOf(rec, "before") : null;
    const after = rec ? tallyOf(rec, "after") : null;
    if (!rec || (!before.tested && !after.tested && !String(rec.notes || "").trim())) {
      return `
        <div class="dg-ticket-empty">
          <p>${loadFailed ? "Couldn't load diagnostics — check the connection." : "Not tested yet."}</p>
          <button type="button" class="ghost-btn" data-dg-run><svg class="icon"><use href="#i-diagnose"></use></svg>Run diagnostics</button>
        </div>`;
    }

    const l = layoutFor(rec.deviceType);
    const stat = (label, t) => `
      <div class="dg-ticket-stat${t.fail ? " has-fail" : ""}">
        <span class="dg-overview-label">${label}</span>
        <strong>${t.tested ? `${t.tested}/${t.total}` : "—"}</strong>
        <span>${t.tested ? `${t.pass} pass · ${t.fail} fail` : "Not run"}</span>
      </div>`;
    const chips = (list) => list.map((p) => `<span class="dg-chip">${esc(p.label)}</span>`).join("");
    const group = (cls, label, list) => list.length ? `
      <div class="dg-ticket-group ${cls}">
        <span class="dg-ticket-group-label">${label} (${list.length})</span>
        <div class="dg-chips">${chips(list)}</div>
      </div>` : "";

    let detail;
    if (before.tested && after.tested) {
      const c = comparisonOf(rec);
      detail = group("is-new", "New issues", c.newIssues)
        + group("is-still", "Still faulty", c.stillFaulty)
        + group("is-fixed", "Fixed", c.fixed);
      if (!detail) detail = `<p class="dg-ticket-line">No faults found before or after the repair.</p>`;
    } else {
      const stage = after.tested ? "after" : "before";
      const fails = l.parts.filter((p) => resultOf(rec, stage, p.key) === "fail");
      detail = fails.length
        ? group("is-still", `Faults found ${stage} repair`, fails)
        : `<p class="dg-ticket-line">No faults found ${stage} the repair.</p>`;
    }

    const action = after.tested
      ? "Open diagnostics"
      : before.tested === before.total ? "Run after-repair test" : "Continue testing";
    return `
      <div class="dg-ticket-summary">
        <div class="dg-ticket-stats">${stat("Before repair", before)}${stat("After repair", after)}</div>
        ${detail}
        ${String(rec.notes || "").trim() ? `<p class="dg-ticket-notes">${esc(rec.notes.trim())}</p>` : ""}
        <div class="dg-ticket-foot">
          <span class="dg-ticket-when">${rec.updated ? `Updated ${esc(whenLabel(rec.updated))}` : "Not saved yet"}</span>
          <span class="dg-ticket-actions">
            <button type="button" class="ghost-btn" data-dg-copy><svg class="icon"><use href="#i-clipboard"></use></svg>Copy</button>
            <button type="button" class="ghost-btn" data-dg-run><svg class="icon"><use href="#i-diagnose"></use></svg>${action}</button>
          </span>
        </div>
      </div>`;
  }

  async function renderTicketDiagnostics(box, ticket, opts = {}) {
    if (!box || !ticket || !ticket.id) return;
    const id = ticket.id;
    let rec = null;
    let loadFailed = false;
    const unsaved = draft && draft.ticketId === id && saveState !== "saved" && saveState !== "idle";
    if (unsaved) rec = draft;
    else if (readPending()[id]) rec = readPending()[id];
    else {
      try {
        rec = (await api({ action: "getTicketDiagnostic", ticketId: id })).diagnostic;
        if (rec) records.set(id, rec);
        else records.delete(id);
      } catch (_) {
        loadFailed = true;
        rec = records.get(id) || null;
      }
    }
    // The modal may have moved on to another repair while this loaded.
    if (!box.isConnected || box.dataset.ticketId !== id) return;
    box.innerHTML = ticketSummaryHtml(rec, loadFailed);
    box.querySelectorAll("[data-dg-run]").forEach((btn) => btn.addEventListener("click", () => {
      if (typeof opts.onOpen === "function") opts.onOpen();
      openDiagnostics(id);
    }));
    box.querySelector("[data-dg-copy]")?.addEventListener("click", (e) => copyText(summaryText(rec, ticket), e.currentTarget));
  }

  function openDiagnostics(ticketId, opts = {}) {
    openRequest = { id: ticketId, opts };
    if (typeof window.RPC_SHOW_VIEW === "function") window.RPC_SHOW_VIEW("diagnostics");
    else enterDiagnostics();
    window.scrollTo({ top: 0 });
  }

  window.RPC_RENDER_TICKET_DIAGNOSTICS = renderTicketDiagnostics;
  window.RPC_OPEN_DIAGNOSTICS = openDiagnostics;

  // ---- Wiring --------------------------------------------------------------

  function bindOnce() {
    if (bound) return;
    const shell = document.getElementById("view-diagnostics");
    if (!shell) return;
    bound = true;

    shell.addEventListener("click", (event) => {
      const pick = event.target.closest("[data-dg-pick]");
      if (pick) { selectTicket(pick.dataset.dgPick); return; }
      const filter = event.target.closest("[data-dg-filter]");
      if (filter) {
        pickerFilter = filter.dataset.dgFilter;
        if ($("dgRepairSearch")) $("dgRepairSearch").value = "";
        renderPicker();
        return;
      }
      if (event.target.closest("#dgSaveRetry")) { flushPending(); saveNow(); return; }
      if (!draft) return;
      const setBtn = event.target.closest("[data-dg-set]");
      if (setBtn) { setPartState(setBtn.dataset.dgSet, setBtn.dataset.dgValue); return; }
      const bulkBtn = event.target.closest("[data-dg-section-bulk]");
      if (bulkBtn) { setCurrentSectionState(bulkBtn.dataset.dgSectionBulk); return; }
      const hotspot = event.target.closest("[data-dg-part]");
      if (hotspot) { cyclePart(hotspot.dataset.dgPart); return; }
      const step = event.target.closest("[data-dg-section]");
      if (step) { setSection(Number(step.dataset.dgSection)); return; }
      const stageBtn = event.target.closest("[data-dg-stage]");
      if (stageBtn) { setStage(stageBtn.dataset.dgStage); return; }
      const typeBtn = event.target.closest("[data-dg-type]");
      if (typeBtn) { setDeviceType(typeBtn.dataset.dgType); return; }
    });

    // Hotspots are SVG <g> elements, so they need explicit keyboard handling.
    shell.addEventListener("keydown", (event) => {
      const hotspot = event.target.closest("[data-dg-part]");
      if (draft && hotspot && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        cyclePart(hotspot.dataset.dgPart);
      }
    });

    $("dgRepairSearch")?.addEventListener("input", renderPicker);
    $("dgPrevSection")?.addEventListener("click", () => setSection(sectionIndex() - 1));
    $("dgNextSection")?.addEventListener("click", nextSection);
    $("dgNotes")?.addEventListener("input", (e) => {
      if (!draft) return;
      draft.notes = e.target.value;
      markChanged();
    });
    $("dgCopy")?.addEventListener("click", (e) => draft && copyText(summaryText(draft, findTicket(draft.ticketId)), e.currentTarget));
    $("dgResetStage")?.addEventListener("click", () => draft && resetStage());
    $("dgOpenRepair")?.addEventListener("click", openRepair);
    $("dgChangeRepair")?.addEventListener("click", leaveRepair);

    // Status changes and newly logged devices show up in the picker and the
    // repair header as soon as Repairs reloads.
    window.addEventListener("rpc-tickets", () => {
      if (!$("dgPicker")?.hidden) renderPicker();
      if (draft) renderRepairCard();
    });

    // Closing the tab or switching apps mid-test: send what's waiting now
    // rather than after the debounce, and let it outlive the page.
    const flushOnLeave = () => { if (draft && (saveTimer || saveState === "dirty")) saveNow({ keepalive: true }); };
    window.addEventListener("pagehide", flushOnLeave);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnLeave(); });
  }

  async function enterDiagnostics() {
    bindOnce();
    const request = openRequest;
    openRequest = null;
    if (!draft && !request) showPicker();
    loadRecords();
    flushPending();
    await ensureTickets();

    if (request) return selectTicket(request.id, request.opts);
    if (draft) {
      // Pick up anything saved from another device since — unless this one
      // still has changes of its own on the way.
      if (saveState === "dirty" || saveState === "saving" || saveState === "error") showWorkspace();
      else selectTicket(draft.ticketId, { stage: draft.stage, section: draft.section });
      return;
    }
    const last = readState();
    if (last && last.ticketId && findTicket(last.ticketId)) {
      return selectTicket(last.ticketId, { stage: last.stage, section: last.section });
    }
    showPicker();
  }

  window.addEventListener("rpc-enter-diagnostics", enterDiagnostics);
})();
