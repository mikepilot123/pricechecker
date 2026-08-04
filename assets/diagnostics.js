/* ============================================================
   Visual diagnostics — test a device before and after a repair.

   The point of this tool is that it is a *picture*, not a checklist:
   staff tap the part of the device they just tested (charging port at
   the bottom edge, volume keys on the left rail, camera in the top
   bezel…) and it turns green/red in place. Each part is tested twice —
   once BEFORE the repair to record what came in broken, once AFTER to
   prove what got fixed — and the comparison panel calls out anything
   that regressed, which is the thing you never want to hand back to a
   client unnoticed.

   Client details can be typed in free-hand for a walk-in, or the report
   can be tagged to a device already logged in Repairs, in which case the
   name/contact/device are pulled from that ticket and the report keeps a
   reference to it.

   Storage is local to the device (localStorage) — same as the rest of
   the shop tools' offline drafts; nothing here needs the team PIN.
   ============================================================ */

(function () {
  const LS_DRAFT = "rpc_diagnostics_draft";
  const LS_REPORTS = "rpc_diagnostics_reports";
  const MAX_REPORTS = 60;

  const STATES = ["untested", "pass", "fail", "na"];
  const STATE_LABEL = { untested: "Untested", pass: "Pass", fail: "Fail", na: "N/A" };

  // Each part sits where it physically lives on the device, so the map
  // reads as the device rather than as a list. x/y are in the layout's
  // own viewBox units.
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
    },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let draft = newDraft();
  let reports = [];
  let bound = false;
  let comboOpen = false;

  function newDraft() {
    return {
      id: "",
      clientName: "",
      clientContact: "",
      device: "",
      deviceType: "phone",
      ticketId: "",
      ticketLabel: "",
      stage: "before",
      before: {},
      after: {},
      notes: "",
      created: "",
    };
  }

  function layout() {
    return LAYOUTS[draft.deviceType] || LAYOUTS.phone;
  }

  // Same broad buckets intake.js uses for its device thumbnails — a
  // laptop gets the laptop map, everything else the handheld one.
  function detectType(device) {
    return /\b(macbook|laptop|notebook|chromebook|surface|thinkpad|ideapad|latitude|inspiron|pavilion|elitebook|probook|zenbook|vivobook|xps)\b/i.test(String(device || ""))
      ? "laptop"
      : "phone";
  }

  // ---- Persistence ---------------------------------------------------------

  function loadStored() {
    try {
      const rawDraft = localStorage.getItem(LS_DRAFT);
      if (rawDraft) draft = Object.assign(newDraft(), JSON.parse(rawDraft));
    } catch (_) { /* ignore malformed draft */ }
    if (!LAYOUTS[draft.deviceType]) draft.deviceType = "phone";
    if (draft.stage !== "after") draft.stage = "before";
    if (!draft.before || typeof draft.before !== "object") draft.before = {};
    if (!draft.after || typeof draft.after !== "object") draft.after = {};

    try {
      const rawReports = localStorage.getItem(LS_REPORTS);
      reports = rawReports ? JSON.parse(rawReports) : [];
      if (!Array.isArray(reports)) reports = [];
    } catch (_) { reports = []; }
  }

  function saveDraft() {
    try { localStorage.setItem(LS_DRAFT, JSON.stringify(draft)); }
    catch (_) { /* storage full/unavailable — non-fatal */ }
  }

  function saveReports() {
    try { localStorage.setItem(LS_REPORTS, JSON.stringify(reports.slice(0, MAX_REPORTS))); }
    catch (_) { /* non-fatal */ }
  }

  // ---- Derived data --------------------------------------------------------

  const stateOf = (stage, key) => (draft[stage] && draft[stage][key]) || "untested";

  function tally(stage) {
    const parts = layout().parts;
    const out = { pass: 0, fail: 0, na: 0, untested: 0, total: parts.length };
    parts.forEach((p) => { out[stateOf(stage, p.key)] += 1; });
    out.tested = out.total - out.untested;
    return out;
  }

  // fail → pass is the win; pass → fail is the one that must never ship.
  function comparison() {
    const out = { fixed: [], stillFaulty: [], newIssues: [] };
    layout().parts.forEach((p) => {
      const before = stateOf("before", p.key);
      const after = stateOf("after", p.key);
      if (before === "fail" && after === "pass") out.fixed.push(p);
      else if (before === "fail" && after === "fail") out.stillFaulty.push(p);
      else if (before === "pass" && after === "fail") out.newIssues.push(p);
    });
    return out;
  }

  // ---- Rendering -----------------------------------------------------------

  function renderMap() {
    const box = $("dgMap");
    if (!box) return;
    const l = layout();
    const hotspots = l.parts.map((p) => {
      const state = stateOf(draft.stage, p.key);
      return `
        <g class="dg-hotspot state-${state}" data-dg-part="${esc(p.key)}" transform="translate(${p.x},${p.y})"
           role="button" tabindex="0" aria-label="${esc(p.label)}: ${STATE_LABEL[state]}">
          <title>${esc(p.label)} — ${STATE_LABEL[state]}</title>
          <circle class="dg-dot" r="18"/>
          <use class="dg-dot-icon" href="#${esc(p.icon)}" x="-10" y="-10" width="20" height="20"/>
          ${state === "pass" ? `<circle class="dg-dot-badge" cx="13" cy="-13" r="6"/><path class="dg-dot-tick" d="M10.2 -13.3l1.9 1.9 3.7-3.9"/>` : ""}
          ${state === "fail" ? `<circle class="dg-dot-badge" cx="13" cy="-13" r="6"/><path class="dg-dot-tick" d="M10.8 -15.2l4.4 4.4M15.2 -15.2l-4.4 4.4"/>` : ""}
          ${state === "na" ? `<circle class="dg-dot-badge" cx="13" cy="-13" r="6"/><path class="dg-dot-tick" d="M10.4 -13h5.2"/>` : ""}
        </g>`;
    }).join("");

    box.innerHTML = `
      <svg class="dg-svg" viewBox="${l.viewBox}" role="group" aria-label="Device diagram — tap a part to set its result">
        ${l.frame}
        ${hotspots}
      </svg>`;
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
      <p class="dg-progress-title">${draft.stage === "before" ? "Before repair" : "After repair"}</p>
      <div class="dg-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="dg-progress-fill" style="width:${pct}%"></div>
      </div>
      <p class="dg-progress-sub">${t.tested} of ${t.total} parts tested</p>
      <div class="dg-tallies">
        <span class="dg-tally is-pass"><strong>${t.pass}</strong> pass</span>
        <span class="dg-tally is-fail"><strong>${t.fail}</strong> fail</span>
        <span class="dg-tally is-na"><strong>${t.na}</strong> n/a</span>
      </div>`;
  }

  function renderPartList() {
    const box = $("dgPartList");
    if (!box) return;
    box.innerHTML = layout().parts.map((p) => {
      const before = stateOf("before", p.key);
      const after = stateOf("after", p.key);
      return `
        <button type="button" class="dg-part-row" data-dg-part="${esc(p.key)}">
          <span class="dg-part-icon"><svg class="icon"><use href="#${esc(p.icon)}"></use></svg></span>
          <span class="dg-part-name">${esc(p.label)}</span>
          <span class="dg-part-states">
            <i class="dg-swatch state-${before}" title="Before: ${STATE_LABEL[before]}"></i>
            <svg class="icon dg-part-arrow"><use href="#i-chevron-right"></use></svg>
            <i class="dg-swatch state-${after}" title="After: ${STATE_LABEL[after]}"></i>
          </span>
        </button>`;
    }).join("");
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

  function renderTagged() {
    const box = $("dgTagged");
    if (!box) return;
    if (!draft.ticketId) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <span class="dg-tag-chip">
        <svg class="icon"><use href="#i-clipboard"></use></svg>
        Linked to ticket <strong>#${esc(draft.ticketId)}</strong>${draft.ticketLabel ? ` · ${esc(draft.ticketLabel)}` : ""}
        <button type="button" id="dgUntag" class="dg-tag-clear" aria-label="Unlink ticket"><svg class="icon"><use href="#i-xmark"></use></svg></button>
      </span>`;
    $("dgUntag").onclick = () => {
      draft.ticketId = "";
      draft.ticketLabel = "";
      saveDraft();
      renderTagged();
    };
  }

  function renderSaved() {
    const box = $("dgSavedList");
    const count = $("dgSavedCount");
    if (!box) return;
    if (count) count.textContent = reports.length ? `${reports.length} saved` : "";
    if (!reports.length) {
      box.innerHTML = `<p class="ops-empty">No saved reports yet — run a diagnostic and tap Save report.</p>`;
      return;
    }
    box.innerHTML = reports.map((r) => {
      const b = r.before || {};
      const a = r.after || {};
      const parts = (LAYOUTS[r.deviceType] || LAYOUTS.phone).parts;
      let fixed = 0, still = 0, newIssues = 0;
      parts.forEach((p) => {
        const bs = b[p.key] || "untested";
        const as = a[p.key] || "untested";
        if (bs === "fail" && as === "pass") fixed += 1;
        else if (bs === "fail" && as === "fail") still += 1;
        else if (bs === "pass" && as === "fail") newIssues += 1;
      });
      const when = r.created ? new Date(r.created).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
      return `
        <div class="dg-saved-row">
          <div class="dg-saved-main">
            <div class="dg-saved-name">${esc(r.clientName || "Unnamed client")}${r.ticketId ? `<span class="dg-saved-ticket">#${esc(r.ticketId)}</span>` : ""}</div>
            <div class="dg-saved-sub">${esc(r.device || "No device")}${when ? ` · ${esc(when)}` : ""}</div>
          </div>
          <div class="dg-saved-stats">
            <span class="dg-saved-stat is-fixed">${fixed} fixed</span>
            ${still ? `<span class="dg-saved-stat is-still">${still} faulty</span>` : ""}
            ${newIssues ? `<span class="dg-saved-stat is-new">${newIssues} new</span>` : ""}
          </div>
          <div class="dg-saved-actions">
            <button type="button" class="ghost-btn" data-dg-open="${esc(r.id)}">Open</button>
            <button type="button" class="ghost-btn danger-btn" data-dg-delete="${esc(r.id)}" aria-label="Delete report"><svg class="icon"><use href="#i-trash"></use></svg></button>
          </div>
        </div>`;
    }).join("");
  }

  function renderFields() {
    if ($("dgClientName") && $("dgClientName").value !== draft.clientName) $("dgClientName").value = draft.clientName;
    if ($("dgClientContact") && $("dgClientContact").value !== draft.clientContact) $("dgClientContact").value = draft.clientContact;
    if ($("dgDevice") && $("dgDevice").value !== draft.device) $("dgDevice").value = draft.device;
    if ($("dgNotes") && $("dgNotes").value !== draft.notes) $("dgNotes").value = draft.notes;
  }

  function renderStatusLine() {
    const el = $("dgStatusLine");
    if (!el) return;
    const b = tally("before");
    const a = tally("after");
    el.textContent = b.tested || a.tested
      ? `Before ${b.tested}/${b.total} · After ${a.tested}/${a.total}`
      : "";
  }

  // Everything except the free-text inputs, which are left alone so typing
  // never loses focus or caret position.
  function render() {
    renderTypeSwitch();
    renderStage();
    renderMap();
    renderProgress();
    renderPartList();
    renderCompare();
    renderTagged();
    renderStatusLine();
  }

  // ---- Interactions --------------------------------------------------------

  function cyclePart(key) {
    const current = stateOf(draft.stage, key);
    const next = STATES[(STATES.indexOf(current) + 1) % STATES.length];
    if (!draft[draft.stage]) draft[draft.stage] = {};
    if (next === "untested") delete draft[draft.stage][key];
    else draft[draft.stage][key] = next;
    saveDraft();
    render();
  }

  function setStage(stage) {
    draft.stage = stage === "after" ? "after" : "before";
    saveDraft();
    render();
  }

  function setDeviceType(type) {
    if (!LAYOUTS[type] || draft.deviceType === type) return;
    draft.deviceType = type;
    saveDraft();
    render();
  }

  // ---- Ticket tagging ------------------------------------------------------

  function knownTickets() {
    const list = window.RPC_INTAKE_TICKETS;
    return Array.isArray(list) ? list : [];
  }

  function renderCombo(query) {
    const box = $("dgComboList");
    if (!box) return;
    const q = String(query || "").trim().toLowerCase();
    if (!q) {
      box.hidden = true;
      box.innerHTML = "";
      comboOpen = false;
      return;
    }
    const tickets = knownTickets();
    if (!tickets.length) {
      box.hidden = false;
      comboOpen = true;
      box.innerHTML = `<p class="dg-combo-empty">No logged devices loaded on this device yet — open the Repairs tab (and save the team PIN) to pull them in. You can still type the client's details below.</p>`;
      return;
    }
    const matches = tickets.filter((t) =>
      [t.customerName, t.phone, t.email, t.device, t.id, t.issues]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(q))
    ).slice(0, 8);

    box.hidden = false;
    comboOpen = true;
    box.innerHTML = matches.length
      ? matches.map((t) => `
          <button type="button" class="dg-combo-item" data-dg-pick="${esc(t.id)}" role="option">
            <span class="dg-combo-name">${esc(t.customerName || "Unnamed")}</span>
            <span class="dg-combo-meta">${esc(t.device || "—")}${t.phone ? ` · ${esc(t.phone)}` : ""}</span>
            <span class="dg-combo-id">#${esc(t.id || "")}</span>
          </button>`).join("")
      : `<p class="dg-combo-empty">No logged device matches “${esc(query)}”.</p>`;
  }

  function pickTicket(id) {
    const ticket = knownTickets().find((t) => t.id === id);
    if (!ticket) return;
    draft.ticketId = ticket.id || "";
    draft.ticketLabel = ticket.device || "";
    draft.clientName = ticket.customerName || "";
    draft.clientContact = ticket.phone || ticket.email || "";
    draft.device = ticket.device || "";
    draft.deviceType = detectType(ticket.device);
    saveDraft();
    if ($("dgClientSearch")) $("dgClientSearch").value = "";
    renderCombo("");
    renderFields();
    render();
  }

  // ---- Save / load / copy --------------------------------------------------

  function saveReport() {
    const b = tally("before");
    const a = tally("after");
    if (!b.tested && !a.tested) {
      toast("Test at least one part before saving.");
      return;
    }
    const now = new Date().toISOString();
    const record = Object.assign({}, draft, {
      id: draft.id || "DG" + Date.now().toString(36).toUpperCase(),
      created: draft.created || now,
      updated: now,
    });
    delete record.stage;
    const existing = reports.findIndex((r) => r.id === record.id);
    if (existing >= 0) reports[existing] = record;
    else reports.unshift(record);
    reports = reports.slice(0, MAX_REPORTS);
    saveReports();
    draft.id = record.id;
    draft.created = record.created;
    saveDraft();
    renderSaved();
    toast(existing >= 0 ? "Report updated." : "Report saved.");
  }

  function openReport(id) {
    const record = reports.find((r) => r.id === id);
    if (!record) return;
    draft = Object.assign(newDraft(), record, { stage: "before" });
    if (!LAYOUTS[draft.deviceType]) draft.deviceType = "phone";
    saveDraft();
    renderFields();
    render();
    document.getElementById("view-diagnostics")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function deleteReport(id) {
    const record = reports.find((r) => r.id === id);
    if (!record) return;
    if (!window.confirm(`Delete the diagnostic report for ${record.clientName || record.device || "this device"}?`)) return;
    reports = reports.filter((r) => r.id !== id);
    saveReports();
    renderSaved();
  }

  function resetDraft() {
    const b = tally("before");
    const a = tally("after");
    if ((b.tested || a.tested) && !window.confirm("Start a new report? Save the current one first if you still need it.")) return;
    draft = newDraft();
    saveDraft();
    if ($("dgClientSearch")) $("dgClientSearch").value = "";
    renderCombo("");
    renderFields();
    render();
  }

  function buildSummary() {
    const l = layout();
    const c = comparison();
    const lines = [];
    lines.push(`Device Diagnostic${draft.device ? ` — ${draft.device}` : ""}`);
    if (draft.clientName || draft.clientContact) {
      lines.push(`Client: ${draft.clientName || "—"}${draft.clientContact ? ` (${draft.clientContact})` : ""}`);
    }
    if (draft.ticketId) lines.push(`Ticket: #${draft.ticketId}`);
    lines.push(new Date().toLocaleDateString());
    lines.push("");

    ["before", "after"].forEach((stage) => {
      const t = tally(stage);
      if (!t.tested) return;
      lines.push(stage === "before" ? "BEFORE REPAIR" : "AFTER REPAIR");
      l.parts.forEach((p) => {
        const s = stateOf(stage, p.key);
        if (s === "untested") return;
        lines.push(`${s === "pass" ? "[OK]" : s === "fail" ? "[X]" : "[-]"} ${p.label}`);
      });
      lines.push("");
    });

    if (tally("before").tested && tally("after").tested) {
      lines.push(`Fixed (${c.fixed.length}): ${c.fixed.map((p) => p.label).join(", ") || "—"}`);
      lines.push(`Still faulty (${c.stillFaulty.length}): ${c.stillFaulty.map((p) => p.label).join(", ") || "—"}`);
      lines.push(`New issues (${c.newIssues.length}): ${c.newIssues.map((p) => p.label).join(", ") || "—"}`);
      lines.push("");
    }
    if (draft.notes.trim()) {
      lines.push("Notes");
      lines.push(draft.notes.trim());
    }
    return lines.join("\n").trim();
  }

  async function copySummary() {
    const text = buildSummary();
    const btn = $("dgCopy");
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

  // ---- Wiring --------------------------------------------------------------

  function bindOnce() {
    if (bound) return;
    const shell = document.getElementById("view-diagnostics");
    if (!shell) return;
    bound = true;

    shell.addEventListener("click", (event) => {
      const hotspot = event.target.closest("[data-dg-part]");
      if (hotspot) { cyclePart(hotspot.dataset.dgPart); return; }
      const stageBtn = event.target.closest("[data-dg-stage]");
      if (stageBtn) { setStage(stageBtn.dataset.dgStage); return; }
      const typeBtn = event.target.closest("[data-dg-type]");
      if (typeBtn) { setDeviceType(typeBtn.dataset.dgType); return; }
      const pick = event.target.closest("[data-dg-pick]");
      if (pick) { pickTicket(pick.dataset.dgPick); return; }
      const open = event.target.closest("[data-dg-open]");
      if (open) { openReport(open.dataset.dgOpen); return; }
      const del = event.target.closest("[data-dg-delete]");
      if (del) { deleteReport(del.dataset.dgDelete); return; }
      // A click anywhere else closes the ticket picker.
      if (comboOpen && !event.target.closest(".dg-field-search")) renderCombo("");
    });

    // Hotspots are SVG <g> elements, so they need explicit keyboard handling.
    shell.addEventListener("keydown", (event) => {
      const hotspot = event.target.closest("[data-dg-part]");
      if (hotspot && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        cyclePart(hotspot.dataset.dgPart);
      }
    });

    $("dgClientSearch")?.addEventListener("input", (e) => renderCombo(e.target.value));
    $("dgClientSearch")?.addEventListener("focus", (e) => renderCombo(e.target.value));

    $("dgClientName")?.addEventListener("input", (e) => { draft.clientName = e.target.value; saveDraft(); });
    $("dgClientContact")?.addEventListener("input", (e) => { draft.clientContact = e.target.value; saveDraft(); });
    $("dgNotes")?.addEventListener("input", (e) => { draft.notes = e.target.value; saveDraft(); });
    $("dgDevice")?.addEventListener("input", (e) => {
      draft.device = e.target.value;
      saveDraft();
    });
    // Switching the map on every keystroke would fight someone mid-word, so
    // the auto-detect only runs once they've finished typing the model.
    $("dgDevice")?.addEventListener("change", () => {
      const detected = detectType(draft.device);
      if (detected !== draft.deviceType) setDeviceType(detected);
    });

    $("dgSave")?.addEventListener("click", saveReport);
    $("dgCopy")?.addEventListener("click", copySummary);
    $("dgReset")?.addEventListener("click", resetDraft);

    // Keep the picker's source list fresh when Repairs finishes loading.
    window.addEventListener("rpc-tickets", () => {
      const search = $("dgClientSearch");
      if (search && search.value.trim() && comboOpen) renderCombo(search.value);
    });
  }

  function enterDiagnostics() {
    loadStored();
    bindOnce();
    renderFields();
    render();
    renderSaved();
  }

  window.addEventListener("rpc-enter-diagnostics", enterDiagnostics);
})();
