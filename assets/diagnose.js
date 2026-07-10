/* ============================================================
   Diagnose — device testing checklist for the shop floor.
   Fully client-side: staff run through hardware/functional tests,
   mark each Pass / Fail / N/A, and copy a report into notes or
   WhatsApp. In-progress state is kept in localStorage so switching
   tabs (or a refresh) doesn't lose the diagnosis.
   ============================================================ */

(function () {
  const LS_STATE = "rpc_diagnose_state";

  const TEST_GROUPS = [
    { group: "Power & Charging", items: ["Powers on", "Charging port", "Battery health", "Wireless charging"] },
    { group: "Display", items: ["Display / no dead pixels", "Touchscreen response", "Brightness / auto-brightness"] },
    { group: "Audio", items: ["Earpiece speaker", "Loudspeaker", "Microphone", "Headphone jack"] },
    { group: "Cameras", items: ["Front camera", "Rear camera", "Flash / torch"] },
    { group: "Connectivity", items: ["Wi-Fi", "Bluetooth", "Cellular / SIM", "GPS"] },
    { group: "Buttons & Sensors", items: ["Power button", "Volume buttons", "Mute / rotation switch", "Fingerprint / Face ID", "Vibration motor", "Proximity sensor"] },
  ];

  const STATES = [
    { key: "pass", label: "Pass" },
    { key: "fail", label: "Fail" },
    { key: "na", label: "N/A" },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  let state = { device: "", results: {}, notes: "" };
  let bound = false;
  let rendered = false;

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = {
          device: typeof parsed.device === "string" ? parsed.device : "",
          results: parsed.results && typeof parsed.results === "object" ? parsed.results : {},
          notes: typeof parsed.notes === "string" ? parsed.notes : "",
        };
      }
    } catch (_) { /* ignore malformed state */ }
  }

  function saveState() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(state)); }
    catch (_) { /* storage full or unavailable — non-fatal */ }
  }

  function allTests() {
    return TEST_GROUPS.flatMap((g) => g.items.map((item) => ({ group: g.group, item, id: `${slug(g.group)}--${slug(item)}` })));
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

  function renderSummary() {
    const c = counts();
    const done = c.total - c.untested;
    const pct = c.total ? Math.round((done / c.total) * 100) : 0;
    const bar = $("diagnoseSummary");
    if (!bar) return;
    bar.innerHTML = `
      <div class="diagnose-summary-counts">
        <span class="diagnose-tally is-pass"><strong>${c.pass}</strong> Pass</span>
        <span class="diagnose-tally is-fail"><strong>${c.fail}</strong> Fail</span>
        <span class="diagnose-tally is-na"><strong>${c.na}</strong> N/A</span>
        <span class="diagnose-tally is-untested"><strong>${c.untested}</strong> Untested</span>
      </div>
      <div class="diagnose-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Diagnostic progress">
        <div class="diagnose-progress-fill" style="width:${pct}%"></div>
        <span class="diagnose-progress-label">${done} of ${c.total} tested</span>
      </div>`;
  }

  function renderChecklist() {
    const box = $("diagnoseChecklist");
    if (!box) return;
    box.innerHTML = TEST_GROUPS.map((g) => `
      <section class="diagnose-group">
        <h3 class="diagnose-group-title">${esc(g.group)}</h3>
        <div class="diagnose-test-list">
          ${g.items.map((item) => {
            const id = `${slug(g.group)}--${slug(item)}`;
            const current = state.results[id] || "";
            return `
              <div class="diagnose-test${current ? " is-set" : ""} state-${current || "untested"}">
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
      </section>`).join("");
  }

  function render() {
    renderChecklist();
    renderSummary();
    const deviceInput = $("diagnoseDevice");
    if (deviceInput && deviceInput.value !== state.device) deviceInput.value = state.device;
    const notesInput = $("diagnoseNotes");
    if (notesInput && notesInput.value !== state.notes) notesInput.value = state.notes;
  }

  function setResult(id, value) {
    if (state.results[id] === value) {
      delete state.results[id]; // tapping the active state again clears it
    } else {
      state.results[id] = value;
    }
    saveState();
    render();
  }

  function buildReport() {
    const c = counts();
    const tests = allTests();
    const lines = [];
    const heading = state.device ? `Device Diagnostic — ${state.device}` : "Device Diagnostic";
    lines.push(heading);
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

  function resetAll() {
    if (!window.confirm("Clear this diagnosis and start over?")) return;
    state = { device: "", results: {}, notes: "" };
    saveState();
    render();
    $("diagnoseDevice")?.focus();
  }

  function bindOnce() {
    if (bound) return;
    bound = true;

    $("diagnoseChecklist")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-diagnose-test]");
      if (!btn) return;
      setResult(btn.dataset.diagnoseTest, btn.dataset.diagnoseState);
    });

    $("diagnoseDevice")?.addEventListener("input", (event) => {
      state.device = event.target.value;
      saveState();
    });

    $("diagnoseNotes")?.addEventListener("input", (event) => {
      state.notes = event.target.value;
      saveState();
    });

    $("diagnoseCopy")?.addEventListener("click", copyReport);
    $("diagnoseReset")?.addEventListener("click", resetAll);
  }

  function enterDiagnose() {
    loadState();
    bindOnce();
    if (!rendered) rendered = true;
    render();
  }

  window.addEventListener("rpc-enter-diagnose", enterDiagnose);
})();
