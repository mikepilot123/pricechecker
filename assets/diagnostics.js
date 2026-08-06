/* ============================================================
   Visual diagnostics — test a device before and after a repair.

   The tool is a *picture*, not a checklist: each testable part is a
   hotspot sitting where it physically lives (charging port on the bottom
   edge, volume keys on the left rail, webcam in the laptop lid), and
   setting it colours it in place.

   Tests are grouped into short sections — Display, Cameras, Audio,
   Connectivity, and so on — and staff step through them one at a time
   rather than facing every test at once. The device map dims the parts
   that aren't in the current section, so it still doubles as a map of
   where you are in the run.

   Everything is recorded twice, once BEFORE the repair to capture what
   came in broken and once AFTER to prove what got fixed. The comparison
   panel calls out anything that regressed, which is the thing you never
   want to hand back to a client unnoticed.

   Client details can be typed free-hand for a walk-in, or the report can
   be tagged to a device already logged in Repairs, in which case the
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
      section: 0,
      before: {},
      after: {},
      notes: "",
      created: "",
    };
  }

  const layout = () => LAYOUTS[draft.deviceType] || LAYOUTS.phone;
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
    draft.section = sectionIndex();

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
    const inSection = new Set(currentGroup().parts);
    const hotspots = l.parts.map((p) => {
      const state = stateOf(draft.stage, p.key);
      const focused = inSection.has(p.key);
      return `
        <g class="dg-hotspot state-${state} ${focused ? "is-focused" : "is-dimmed"}" data-dg-part="${esc(p.key)}"
           transform="translate(${p.x},${p.y})" role="button" tabindex="0"
           aria-label="${esc(p.label)}: ${STATE_LABEL[state]}">
          <title>${esc(p.label)} — ${STATE_LABEL[state]}</title>
          <circle class="dg-dot" r="18"/>
          <use class="dg-dot-icon" href="#${esc(p.icon)}" x="-10" y="-10" width="20" height="20"/>
          ${state === "pass" ? `<circle class="dg-dot-badge" cx="13" cy="-13" r="6"/><path class="dg-dot-tick" d="M10.2 -13.3l1.9 1.9 3.7-3.9"/>` : ""}
          ${state === "fail" ? `<circle class="dg-dot-badge" cx="13" cy="-13" r="6"/><path class="dg-dot-tick" d="M10.8 -15.2l4.4 4.4M15.2 -15.2l-4.4 4.4"/>` : ""}
          ${state === "na" ? `<circle class="dg-dot-badge" cx="13" cy="-13" r="6"/><path class="dg-dot-tick" d="M10.4 -13h5.2"/>` : ""}
        </g>`;
    }).join("");

    box.innerHTML = `
      <svg class="dg-svg" viewBox="${l.viewBox}" role="group" aria-label="Device diagram — parts in the current section are highlighted">
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
      next.disabled = i === last;
      next.classList.toggle("attention", done && i < last);
      next.innerHTML = i === last
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
    renderStepper();
    renderMap();
    renderSectionPanel();
    renderSectionNav();
    renderProgress();
    renderCompare();
    renderTagged();
    renderStatusLine();
  }

  // ---- Interactions --------------------------------------------------------

  function setPartState(key, value) {
    if (!draft[draft.stage]) draft[draft.stage] = {};
    // Tapping the state a part is already in clears it back to untested,
    // so a mis-tap is undone with a second tap on the same button.
    if (stateOf(draft.stage, key) === value) delete draft[draft.stage][key];
    else draft[draft.stage][key] = value;
    saveDraft();
    render();
  }

  function cyclePart(key) {
    const current = stateOf(draft.stage, key);
    const next = STATES[(STATES.indexOf(current) + 1) % STATES.length];
    if (!draft[draft.stage]) draft[draft.stage] = {};
    if (next === "untested") delete draft[draft.stage][key];
    else draft[draft.stage][key] = next;
    saveDraft();
    render();
  }

  // Tapping a part on the map that belongs to another section jumps to that
  // section first, so the map stays a navigation aid as well as an input.
  function handleMapTap(key) {
    if (!currentGroup().parts.includes(key)) {
      const target = groups().findIndex((g) => g.parts.includes(key));
      if (target >= 0) {
        draft.section = target;
        saveDraft();
        render();
        return;
      }
    }
    cyclePart(key);
  }

  function setSection(index) {
    const max = groups().length - 1;
    draft.section = Math.min(Math.max(index, 0), max);
    saveDraft();
    render();
    $("dgStepper")?.querySelector(".dg-step.active")?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }

  function setStage(stage) {
    draft.stage = stage === "after" ? "after" : "before";
    saveDraft();
    render();
  }

  function setDeviceType(type) {
    if (!LAYOUTS[type] || draft.deviceType === type) return;
    draft.deviceType = type;
    draft.section = 0; // the two layouts have different sections
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
    const type = detectType(ticket.device);
    if (type !== draft.deviceType) draft.section = 0;
    draft.deviceType = type;
    saveDraft();
    if ($("dgClientSearch")) $("dgClientSearch").value = "";
    renderCombo("");
    renderFields();
    render();
  }

  // ---- Save / load / reset / copy -----------------------------------------

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
    delete record.section;
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
    draft = Object.assign(newDraft(), record, { stage: "before", section: 0 });
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

  // Clears just the current stage's results, keeping the client details and
  // the other stage — for when a test run needs starting over rather than
  // the whole report.
  function resetStage() {
    const stageLabel = draft.stage === "before" ? "before repair" : "after repair";
    if (!tally(draft.stage).tested) {
      toast(`Nothing recorded in the ${stageLabel} test yet.`);
      return;
    }
    if (!window.confirm(`Clear every result in the ${stageLabel} test? The client details and the other test are kept.`)) return;
    draft[draft.stage] = {};
    draft.section = 0;
    saveDraft();
    render();
    toast(`Cleared the ${stageLabel} test.`);
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
      l.groups.forEach((g) => {
        const tested = g.parts.filter((k) => stateOf(stage, k) !== "untested");
        if (!tested.length) return;
        lines.push(`  ${g.label}`);
        tested.forEach((k) => {
          const s = stateOf(stage, k);
          const p = partByKey(k);
          lines.push(`  ${s === "pass" ? "[OK]" : s === "fail" ? "[X]" : "[-]"} ${p ? p.label : k}`);
        });
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
      const setBtn = event.target.closest("[data-dg-set]");
      if (setBtn) { setPartState(setBtn.dataset.dgSet, setBtn.dataset.dgValue); return; }
      const hotspot = event.target.closest("[data-dg-part]");
      if (hotspot) { handleMapTap(hotspot.dataset.dgPart); return; }
      const step = event.target.closest("[data-dg-section]");
      if (step) { setSection(Number(step.dataset.dgSection)); return; }
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
        handleMapTap(hotspot.dataset.dgPart);
      }
    });

    $("dgPrevSection")?.addEventListener("click", () => setSection(sectionIndex() - 1));
    $("dgNextSection")?.addEventListener("click", () => setSection(sectionIndex() + 1));

    $("dgClientSearch")?.addEventListener("input", (e) => renderCombo(e.target.value));
    $("dgClientSearch")?.addEventListener("focus", (e) => renderCombo(e.target.value));

    $("dgClientName")?.addEventListener("input", (e) => { draft.clientName = e.target.value; saveDraft(); });
    $("dgClientContact")?.addEventListener("input", (e) => { draft.clientContact = e.target.value; saveDraft(); });
    $("dgNotes")?.addEventListener("input", (e) => { draft.notes = e.target.value; saveDraft(); });
    $("dgDevice")?.addEventListener("input", (e) => { draft.device = e.target.value; saveDraft(); });
    // Switching the map on every keystroke would fight someone mid-word, so
    // the auto-detect only runs once they've finished typing the model.
    $("dgDevice")?.addEventListener("change", () => {
      const detected = detectType(draft.device);
      if (detected !== draft.deviceType) setDeviceType(detected);
    });

    $("dgSave")?.addEventListener("click", saveReport);
    $("dgCopy")?.addEventListener("click", copySummary);
    $("dgResetStage")?.addEventListener("click", resetStage);
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
