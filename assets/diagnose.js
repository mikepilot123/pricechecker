/* ============================================================
   Diagnose — step-by-step device testing wizard.
   Staff walk through one section of hardware checks at a time
   (power, display, audio…), marking each Pass / Fail / N/A, then
   land on a review step with the full tally and a copyable report.
   Fully client-side; in-progress state (including the current step)
   is kept in localStorage so switching tabs or refreshing resumes
   the sequence where it left off.
   ============================================================ */

(function () {
  const LS_STATE = "rpc_diagnose_state";

  const TEST_GROUPS = [
    { group: "Power & Charging", hint: "Start with the basics — does it turn on and take charge?", items: ["Powers on", "Charging port", "Battery health", "Wireless charging"] },
    { group: "Display", hint: "Look over the panel and touch response.", items: ["Display / no dead pixels", "Touchscreen response", "Brightness / auto-brightness"] },
    { group: "Audio", hint: "Play a sound and record a short clip.", items: ["Earpiece speaker", "Loudspeaker", "Microphone", "Headphone jack"] },
    { group: "Cameras", hint: "Open the camera app and try both lenses.", items: ["Front camera", "Rear camera", "Flash / torch"] },
    { group: "Connectivity", hint: "Check radios — join Wi-Fi, pair Bluetooth, test signal.", items: ["Wi-Fi", "Bluetooth", "Cellular / SIM", "GPS"] },
    { group: "Buttons & Sensors", hint: "Press every button and test the sensors.", items: ["Power button", "Volume buttons", "Mute / rotation switch", "Fingerprint / Face ID", "Vibration motor", "Proximity sensor"] },
  ];
  const REVIEW_STEP = TEST_GROUPS.length + 1; // steps: 0 = start, 1..N = groups, N+1 = review

  const STATES = [
    { key: "pass", label: "Pass" },
    { key: "fail", label: "Fail" },
    { key: "na", label: "N/A" },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const testId = (group, item) => `${slug(group)}--${slug(item)}`;

  let state = { device: "", results: {}, notes: "", step: 0 };
  let bound = false;

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = {
          device: typeof parsed.device === "string" ? parsed.device : "",
          results: parsed.results && typeof parsed.results === "object" ? parsed.results : {},
          notes: typeof parsed.notes === "string" ? parsed.notes : "",
          step: Number.isInteger(parsed.step) ? Math.min(Math.max(parsed.step, 0), REVIEW_STEP) : 0,
        };
        // Older saves (pre-wizard) had no step — drop them onto the first
        // section if they contain work, otherwise the start screen.
        if (!Number.isInteger(parsed.step)) {
          state.step = Object.keys(state.results).length || state.device ? 1 : 0;
        }
      }
    } catch (_) { /* ignore malformed state */ }
  }

  function saveState() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(state)); }
    catch (_) { /* storage full or unavailable — non-fatal */ }
  }

  function allTests() {
    return TEST_GROUPS.flatMap((g) => g.items.map((item) => ({ group: g.group, item, id: testId(g.group, item) })));
  }

  function counts() {
    const tests = allTests();
    const tally = { pass: 0, fail: 0, na: 0, untested: 0, total: tests.length };
    tests.forEach((t) => {
      const s = state.results[t.id];
      if (s === "pass" || s === "fail" || s === "na") tally[s] += 1;
      else tally.untested += 1;
    });
    return tally;
  }

  function groupStats(index) {
    const g = TEST_GROUPS[index];
    const stats = { done: 0, fail: 0, total: g.items.length };
    g.items.forEach((item) => {
      const s = state.results[testId(g.group, item)];
      if (s) stats.done += 1;
      if (s === "fail") stats.fail += 1;
    });
    return stats;
  }

  const hasProgress = () => state.device.trim() !== "" || Object.keys(state.results).length > 0 || state.notes.trim() !== "";

  // ---- Step HTML -----------------------------------------------------------

  function segmentBarHtml() {
    return `
      <div class="diagnose-seg-bar" role="tablist" aria-label="Diagnostic sections">
        ${TEST_GROUPS.map((g, i) => {
          const stats = groupStats(i);
          const step = i + 1;
          const cls = [
            "diagnose-seg",
            state.step === step ? "is-current" : "",
            stats.done === stats.total ? "is-complete" : "",
            stats.fail ? "has-fail" : "",
          ].filter(Boolean).join(" ");
          return `<button type="button" class="${cls}" data-diagnose-goto="${step}" role="tab"
            aria-selected="${state.step === step ? "true" : "false"}"
            title="${esc(g.group)} — ${stats.done} of ${stats.total} tested"
            aria-label="${esc(g.group)}, ${stats.done} of ${stats.total} tested"></button>`;
        }).join("")}
      </div>`;
  }

  function startContentHtml() {
    const c = counts();
    const resumable = hasProgress();
    const resumeLabel = TEST_GROUPS[Math.min(Math.max(state.step, 1), TEST_GROUPS.length) - 1].group;
    return `
        <div class="diagnose-start-icon" aria-hidden="true"><svg class="icon"><use href="#i-diagnose"></use></svg></div>
        <div class="form-step-heading">
          <p class="form-section-label">Device diagnostics</p>
          <h4>Test a device, section by section</h4>
          <p>${TEST_GROUPS.length} short sections · ${c.total} checks · a copyable report at the end.</p>
        </div>
        <label class="field-label" for="diagnoseDevice">Device</label>
        <input id="diagnoseDevice" class="text-input" type="text" autocomplete="off" placeholder="e.g. iPhone 11, Macbook A1466" value="${esc(state.device)}" aria-label="Device being tested" />
        ${resumable ? `
          <p class="diagnose-resume-note">A diagnosis is in progress${state.device ? ` for <strong>${esc(state.device)}</strong>` : ""} — ${c.total - c.untested} of ${c.total} checks recorded.</p>
          <div class="form-actions diagnose-start-actions">
            <button type="button" id="diagnoseFreshBtn" class="ghost-btn">Start over</button>
            <button type="button" id="diagnoseResumeBtn" class="primary-btn">Resume at ${esc(resumeLabel)}<svg class="icon"><use href="#i-chevron-right"></use></svg></button>
          </div>` : `
          <div class="form-actions diagnose-start-actions">
            <button type="button" id="diagnoseStartBtn" class="primary-btn">Start diagnostic<svg class="icon"><use href="#i-chevron-right"></use></svg></button>
          </div>`}`;
  }

  // Inner content only — the .form-step wrapper is created once per step
  // transition and reused for in-place updates (see renderInto/refreshContent),
  // so the CSS entrance animation (tied to the wrapper being freshly inserted)
  // only plays when moving between steps, not on every Pass/Fail/N/A tap.
  function stepContentHtml(step) {
    const index = step - 1;
    const g = TEST_GROUPS[index];
    const stats = groupStats(index);
    const complete = stats.done === stats.total;
    return `
        ${segmentBarHtml()}
        <div class="diagnose-step-meta">
          <p class="form-section-label">Section ${step} of ${TEST_GROUPS.length}${state.device ? ` · ${esc(state.device)}` : ""}</p>
          <span class="diagnose-step-count${complete ? " is-complete" : ""}">${stats.done}/${stats.total} tested</span>
        </div>
        <div class="form-step-heading">
          <h4>${esc(g.group)}</h4>
          <p>${esc(g.hint)}</p>
        </div>
        <div class="diagnose-test-list">
          ${g.items.map((item) => {
            const id = testId(g.group, item);
            const current = state.results[id] || "";
            return `
              <div class="diagnose-test state-${current || "untested"}">
                <span class="diagnose-test-label">${esc(item)}</span>
                <div class="diagnose-test-actions" role="group" aria-label="${esc(item)} result">
                  ${STATES.map((st) => `
                    <button type="button" class="diagnose-state-btn state-${st.key}${current === st.key ? " active" : ""}"
                      data-diagnose-test="${id}" data-diagnose-state="${st.key}"
                      aria-pressed="${current === st.key ? "true" : "false"}">${st.label}</button>`).join("")}
                </div>
              </div>`;
          }).join("")}
        </div>
        <div class="form-actions diagnose-step-actions">
          <button type="button" id="diagnoseBack" class="ghost-btn"><svg class="icon"><use href="#i-chevron-left"></use></svg>Back</button>
          <button type="button" id="diagnoseNext" class="primary-btn${complete ? " attention" : ""}">
            ${step === TEST_GROUPS.length ? "Review results" : `Next: ${esc(TEST_GROUPS[step].group)}`}<svg class="icon"><use href="#i-chevron-right"></use></svg>
          </button>
        </div>`;
  }

  function reviewContentHtml() {
    const c = counts();
    const done = c.total - c.untested;
    const pct = c.total ? Math.round((done / c.total) * 100) : 0;
    return `
        ${segmentBarHtml()}
        <div class="form-step-heading">
          <p class="form-section-label">Review${state.device ? ` · ${esc(state.device)}` : ""}</p>
          <h4>Diagnostic summary</h4>
          <p>${c.fail ? `${c.fail} check${c.fail === 1 ? "" : "s"} failed — worth quoting for repair.` : c.untested ? "Some checks are still untested — jump back to any section above." : "Everything tested. Copy the report below."}</p>
        </div>
        <div class="diagnose-summary">
          <div class="diagnose-summary-counts">
            <span class="diagnose-tally is-pass"><strong>${c.pass}</strong> Pass</span>
            <span class="diagnose-tally is-fail"><strong>${c.fail}</strong> Fail</span>
            <span class="diagnose-tally is-na"><strong>${c.na}</strong> N/A</span>
            <span class="diagnose-tally is-untested"><strong>${c.untested}</strong> Untested</span>
          </div>
          <div class="diagnose-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Diagnostic progress">
            <div class="diagnose-progress-fill" style="width:${pct}%"></div>
            <span class="diagnose-progress-label">${done} of ${c.total} tested</span>
          </div>
        </div>
        <div class="diagnose-review-groups">
          ${TEST_GROUPS.map((g, i) => {
            const stats = groupStats(i);
            return `
              <div class="diagnose-review-row">
                <span class="diagnose-review-name">${esc(g.group)}</span>
                <span class="diagnose-review-stats">
                  ${stats.fail ? `<span class="diagnose-review-fail">${stats.fail} fail</span>` : ""}
                  <span class="diagnose-review-tested${stats.done === stats.total ? " is-complete" : ""}">${stats.done}/${stats.total}</span>
                </span>
                <button type="button" class="diagnose-review-edit" data-diagnose-goto="${i + 1}">Edit</button>
              </div>`;
          }).join("")}
        </div>
        <label class="field-label" for="diagnoseNotes">Notes</label>
        <textarea id="diagnoseNotes" class="text-input" rows="3" placeholder="Anything else worth recording — faults, part numbers, customer requests…" aria-label="Diagnostic notes">${esc(state.notes)}</textarea>
        <div class="form-actions diagnose-step-actions">
          <button type="button" id="diagnoseBack" class="ghost-btn"><svg class="icon"><use href="#i-chevron-left"></use></svg>Back</button>
          <button type="button" id="diagnoseReset" class="ghost-btn danger-btn"><svg class="icon"><use href="#i-refresh"></use></svg>Start new</button>
          <button type="button" id="diagnoseCopy" class="primary-btn"><svg class="icon"><use href="#i-clipboard"></use></svg>Copy report</button>
        </div>`;
  }

  function stepWrapperClass(step) {
    if (step === 0) return "diagnose-start";
    if (step === REVIEW_STEP) return "diagnose-review";
    return "diagnose-step";
  }

  function contentHtmlFor(step) {
    if (step === 0) return startContentHtml();
    if (step === REVIEW_STEP) return reviewContentHtml();
    return stepContentHtml(step);
  }

  // Full render: replaces the whole wizard box, creating a fresh .form-step
  // wrapper so the step transition plays its entrance animation.
  function render() {
    const box = $("diagnoseWizard");
    if (!box) return;
    box.innerHTML = `<div class="form-step ${stepWrapperClass(state.step)}">${contentHtmlFor(state.step)}</div>`;
  }

  // In-place update: reuses the existing .form-step wrapper if it matches
  // the current step, so no entrance animation replays. Falls back to a
  // full render if the wrapper is missing or stale (shouldn't normally happen).
  function refreshContent() {
    const box = $("diagnoseWizard");
    const wrapper = box?.querySelector(":scope > .form-step");
    if (!wrapper || !wrapper.classList.contains(stepWrapperClass(state.step))) {
      render();
      return;
    }
    wrapper.innerHTML = contentHtmlFor(state.step);
  }

  function goTo(step) {
    state.step = Math.min(Math.max(step, 0), REVIEW_STEP);
    saveState();
    render();
    $("diagnoseWizard")?.scrollIntoView({ block: "nearest" });
  }

  function setResult(id, value) {
    if (state.results[id] === value) {
      delete state.results[id]; // tapping the active state again clears it
    } else {
      state.results[id] = value;
    }
    saveState();
    refreshContent();
  }

  // ---- Report --------------------------------------------------------------

  function buildReport() {
    const c = counts();
    const tests = allTests();
    const lines = [];
    lines.push(state.device ? `Device Diagnostic — ${state.device}` : "Device Diagnostic");
    lines.push(new Date().toLocaleDateString());
    lines.push("");

    const section = (title, matchState, mark) => {
      const rows = tests.filter((t) => (state.results[t.id] || "untested") === matchState);
      if (!rows.length) return;
      lines.push(`${title} (${rows.length})`);
      rows.forEach((t) => lines.push(`${mark} ${t.item}`));
      lines.push("");
    };

    section("PASSED", "pass", "[P]");
    section("FAILED", "fail", "[F]");
    section("NOT APPLICABLE", "na", "[-]");
    section("UNTESTED", "untested", "[ ]");

    if (state.notes.trim()) {
      lines.push("NOTES");
      lines.push(state.notes.trim());
      lines.push("");
    }

    lines.push(`Summary: ${c.pass} passed, ${c.fail} failed, ${c.na} n/a, ${c.untested} untested.`);
    return lines.join("\n").trim();
  }

  async function copyReport() {
    const report = buildReport();
    const btn = $("diagnoseCopy");
    const original = btn ? btn.innerHTML : "";
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(report);
      } else {
        const ta = document.createElement("textarea");
        ta.value = report;
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

  function resetAll(confirmFirst) {
    if (confirmFirst && !window.confirm("Clear this diagnosis and start over?")) return;
    state = { device: "", results: {}, notes: "", step: 0 };
    saveState();
    render();
    $("diagnoseDevice")?.focus();
  }

  // ---- Events --------------------------------------------------------------

  function bindOnce() {
    if (bound) return;
    bound = true;
    const box = $("diagnoseWizard");
    if (!box) return;

    box.addEventListener("click", (event) => {
      const stateBtn = event.target.closest("[data-diagnose-test]");
      if (stateBtn) { setResult(stateBtn.dataset.diagnoseTest, stateBtn.dataset.diagnoseState); return; }
      const gotoBtn = event.target.closest("[data-diagnose-goto]");
      if (gotoBtn) { goTo(Number(gotoBtn.dataset.diagnoseGoto)); return; }
      if (event.target.closest("#diagnoseStartBtn") || event.target.closest("#diagnoseResumeBtn")) {
        goTo(Math.min(Math.max(state.step, 1), TEST_GROUPS.length));
        return;
      }
      if (event.target.closest("#diagnoseFreshBtn")) { resetAll(true); return; }
      if (event.target.closest("#diagnoseBack")) { goTo(state.step - 1); return; }
      if (event.target.closest("#diagnoseNext")) { goTo(state.step + 1); return; }
      if (event.target.closest("#diagnoseCopy")) { copyReport(); return; }
      if (event.target.closest("#diagnoseReset")) { resetAll(true); }
    });

    // Text fields save without re-rendering, so typing never loses focus.
    box.addEventListener("input", (event) => {
      if (event.target.id === "diagnoseDevice") { state.device = event.target.value; saveState(); }
      if (event.target.id === "diagnoseNotes") { state.notes = event.target.value; saveState(); }
    });

    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.id === "diagnoseDevice") {
        event.preventDefault();
        goTo(Math.min(Math.max(state.step, 1), TEST_GROUPS.length));
      }
    });
  }

  function enterDiagnose() {
    loadState();
    bindOnce();
    render();
  }

  window.addEventListener("rpc-enter-diagnose", enterDiagnose);
})();
