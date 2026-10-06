/* ============================================================
   Device permissions — what this browser may see, and the owner's
   Settings → Devices panel for choosing that per device.

   The server decides (lib/devices.js, api/intake.js's deviceAccess); this
   file hides the matching parts of the app by putting a "hide-<section>"
   class on <html> that style.css keys off. The last answer is cached so the
   inline script in index.html's <head> can apply it before first paint.
   ============================================================ */
(function () {
  "use strict";

  const INTAKE_URL = "https://pricechecker-cyan.vercel.app/api/intake";
  const LS_PIN = "rpc_intake_pin";
  // Read by the inline script in index.html's <head> too — keep them in step.
  const CACHE_KEY = "rpc_device_access";
  const SECTIONS = [
    { key: "invoiceFigures", label: "Invoice figures", help: "Outstanding, overdue and paid-this-month totals. The invoice list itself stays visible." },
    { key: "dashboard", label: "Dashboard", help: "Business overview and KPIs." },
    { key: "targets", label: "Targets", help: "Sales targets and progress." },
    { key: "accounting", label: "Accounting", help: "Bank account and expenses." },
  ];
  const ALL_KEYS = SECTIONS.map((s) => s.key);
  // Views a hidden section takes with it. "expenses" is the old name for the
  // Accounting → Expenses panel, still stored as some devices' last view.
  const VIEW_SECTION = { dashboard: "dashboard", targets: "targets", account: "accounting", expenses: "accounting" };
  const REFRESH_MIN_MS = 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const credential = () => { try { return localStorage.getItem(LS_PIN) || ""; } catch (_) { return ""; } };
  // Ties the cached answer to the credential it was given for, so signing in
  // again (a new device as far as the server knows) never reuses it.
  const credentialTag = (value) => String(value || "").slice(-16);

  let hidden = currentClasses();
  let lastRefresh = 0;
  let ownerPin = ""; // memory only: re-entered whenever the page reloads
  let ownerPinSource = null; // "" none yet · "app" set in Settings · "server" OWNER_PIN; null = not known yet
  let devices = [];
  let thisDeviceId = "";

  function currentClasses() {
    return ALL_KEYS.filter((key) => document.documentElement.classList.contains("hide-" + key));
  }

  function apply(list) {
    hidden = ALL_KEYS.filter((key) => list.includes(key));
    ALL_KEYS.forEach((key) => document.documentElement.classList.toggle("hide-" + key, hidden.includes(key)));
    // Leave a view that has just been hidden rather than keep showing it.
    let current = "";
    try { current = localStorage.getItem("rpc_last_view") || ""; } catch (_) {}
    const visible = current && $(current === "expenses" ? "view-account" : "view-" + current);
    if (blocksView(current) && visible && !visible.hidden && typeof window.RPC_SHOW_VIEW === "function") {
      window.RPC_SHOW_VIEW("prices");
    }
  }

  function blocksView(view) {
    const section = VIEW_SECTION[view];
    return !!section && hidden.includes(section);
  }

  async function post(payload) {
    const res = await fetch(INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ pin: credential() }, payload)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Rejected");
    return data;
  }

  async function refresh({ force = false } = {}) {
    const cred = credential();
    if (!cred) return;
    if (!force && Date.now() - lastRefresh < REFRESH_MIN_MS) return;
    lastRefresh = Date.now();
    try {
      const data = await post({ action: "deviceAccess" });
      const list = Array.isArray(data.hidden) ? data.hidden : [];
      thisDeviceId = data.deviceId || "";
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ k: credentialTag(cred), hidden: list })); } catch (_) {}
      apply(list);
      ownerPinSource = data.ownerPin || "";
      renderPanel();
    } catch (_) {
      // Keep whatever is applied: the cached answer, or — for a signed-in
      // device that has never had one — everything hidden until it does.
    }
  }

  // Called after this browser signs in with the team PIN: it's a new device
  // to the server, so drop the old answer and ask again.
  function signedIn() {
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    apply(ALL_KEYS);
    return refresh({ force: true });
  }

  window.RPC_DEVICE_ACCESS = {
    blocksView,
    isHidden: (section) => hidden.includes(section),
    refresh,
    signedIn,
  };

  // An owner's change shows up the next time the app is opened or brought
  // back to the front, without the device needing a reload.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  refresh({ force: true });

  // ---- Settings → Devices -------------------------------------------------
  // Which of the panel's states shows: create an owner PIN (permissions
  // off), unlock with it, or the device list once unlocked.
  function renderPanel() {
    if (!$("devicesCreate")) return;
    const known = ownerPinSource !== null;
    $("devicesCreate").hidden = !known || ownerPinSource !== "";
    $("devicesUnlock").hidden = !known || ownerPinSource === "" || !!ownerPin;
    $("devicesLock").hidden = !ownerPin;
    $("devicesListHelp").hidden = !ownerPin;
    $("devicesChangePinToggle").hidden = ownerPinSource !== "app";
    if (!ownerPin) $("devicesChangePin").hidden = true;
    renderDevices();
  }

  function showError(message) {
    const el = $("devicesError");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  function relativeTime(iso) {
    if (!iso) return "never";
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return mins + " min ago";
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    return new Date(iso).toLocaleDateString();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderDevices() {
    const list = $("devicesList");
    if (!list) return;
    list.hidden = !ownerPin;
    if (!ownerPin) { list.innerHTML = ""; return; }
    if (!devices.length) {
      list.innerHTML = '<p class="settings-help">No devices have signed in yet.</p>';
      return;
    }
    list.innerHTML = devices.map((device) => {
      const isThis = device.id === thisDeviceId;
      const toggles = SECTIONS.map((section) => `
        <label class="reclaim-toggle device-toggle">
          <input type="checkbox" data-device-id="${escapeHtml(device.id)}" data-section="${section.key}" ${device.hidden.includes(section.key) ? "" : "checked"} />
          <span><strong>${section.label}</strong><small>${section.help}</small></span>
        </label>`).join("");
      const restricted = device.hidden.length;
      // Master switch: on = every section shown, off = every section hidden.
      // "Partly" shows as the dash state, set after the markup is in place.
      const allOn = restricted === 0;
      const partly = restricted > 0 && restricted < SECTIONS.length;
      return `
        <article class="device-card" data-device-card="${escapeHtml(device.id)}">
          <div class="device-card-head">
            <input class="text-input device-name" type="text" maxlength="60" value="${escapeHtml(device.name)}"
                   data-device-name="${escapeHtml(device.id)}" aria-label="Device name" />
            ${isThis ? '<span class="device-badge">This device</span>' : ""}
          </div>
          <p class="settings-help device-meta">
            Last opened ${escapeHtml(relativeTime(device.lastSeenAt))} · signed in ${escapeHtml(relativeTime(device.createdAt))}
            · <strong>${restricted ? (restricted === SECTIONS.length ? "Restricted" : "Partly restricted") : "Full access"}</strong>
          </p>
          <label class="device-master" title="Show or hide all four sections on this device">
            <input type="checkbox" class="device-master-input" data-device-all="${escapeHtml(device.id)}" ${allOn ? "checked" : ""} ${partly ? 'data-partly="1"' : ""} />
            <span class="device-master-track" aria-hidden="true"></span>
            <span class="device-master-text"><strong>Show everything on this device</strong><small>${allOn ? "All four sections are on." : partly ? "Some sections are on. Switch on to show all four." : "All four sections are hidden."}</small></span>
          </label>
          <p class="field-label device-can-see">Can see</p>
          <div class="alert-prefs device-toggles">${toggles}</div>
        </article>`;
    }).join("");
    // A switch with some sections on and some off reads as "partly".
    list.querySelectorAll("input[data-partly]").forEach((input) => { input.indeterminate = true; });
  }

  async function loadDevices() {
    const data = await post({ action: "listDevices", ownerPin });
    devices = data.devices || [];
    if (data.deviceId) thisDeviceId = data.deviceId;
    renderDevices();
  }

  async function saveDevice(id, changes) {
    showError("");
    try {
      const data = await post(Object.assign({ action: "updateDevice", ownerPin, id }, changes));
      devices = devices.map((d) => (d.id === id ? data.device : d));
      renderDevices();
      if (id === thisDeviceId) refresh({ force: true });
      window.RPC_TOAST?.("Saved.", { tone: "info", duration: 1500 });
    } catch (err) {
      showError("Couldn't save: " + err.message);
      renderDevices(); // put the checkbox back the way the server has it
    }
  }

  function bindDevicesPanel() {
    const unlockBtn = $("devicesUnlockBtn");
    if (!unlockBtn || unlockBtn.dataset.bound) return;
    unlockBtn.dataset.bound = "1";

    const unlock = async () => {
      const input = $("devicesOwnerPin");
      const pin = String(input.value || "").trim();
      if (!pin) { showError("Enter the owner PIN."); return; }
      showError("");
      unlockBtn.disabled = true;
      ownerPin = pin;
      try {
        await loadDevices();
        input.value = "";
      } catch (err) {
        ownerPin = "";
        showError(err.message);
      } finally {
        unlockBtn.disabled = false;
        renderPanel();
      }
    };

    // Reads a new PIN and its confirmation; null (with the error shown) if
    // they don't make a usable pair.
    const readNewPin = (fieldId, confirmId) => {
      const pin = String($(fieldId).value || "").trim();
      if (pin.length < 4) { showError("The owner PIN needs at least 4 digits."); return null; }
      if (pin !== String($(confirmId).value || "").trim()) { showError("The two PINs don't match."); return null; }
      return pin;
    };

    $("devicesCreateBtn").addEventListener("click", async () => {
      showError("");
      const pin = readNewPin("devicesNewPin", "devicesNewPinConfirm");
      if (!pin) return;
      const btn = $("devicesCreateBtn");
      btn.disabled = true;
      try {
        const data = await post({ action: "setOwnerPin", newOwnerPin: pin });
        ownerPinSource = data.ownerPin || "app";
        ownerPin = pin;
        $("devicesNewPin").value = "";
        $("devicesNewPinConfirm").value = "";
        await loadDevices();
        window.RPC_TOAST?.("Owner PIN created. Device permissions are on.", { tone: "info", duration: 3500 });
      } catch (err) {
        showError(err.message);
        refresh({ force: true }); // someone may have created one first
      } finally {
        btn.disabled = false;
        renderPanel();
      }
    });

    $("devicesRestrictOthersBtn").addEventListener("click", async () => {
      showError("");
      if (!window.confirm("Hide invoice figures, Dashboard, Targets and Accounting on every device except this one? You can allow them again one by one.")) return;
      const btn = $("devicesRestrictOthersBtn");
      btn.disabled = true;
      try {
        const data = await post({ action: "restrictOtherDevices", ownerPin });
        devices = data.devices || [];
        if (data.deviceId) thisDeviceId = data.deviceId;
        renderDevices();
        window.RPC_TOAST?.(
          `Restricted ${data.restricted} device${data.restricted === 1 ? "" : "s"}. Any device not listed yet is restricted as soon as it opens the app.`,
          { tone: "info", duration: 5000 }
        );
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    $("devicesChangePinToggle").addEventListener("click", () => {
      $("devicesChangePin").hidden = !$("devicesChangePin").hidden;
      showError("");
    });
    $("devicesChangeBtn").addEventListener("click", async () => {
      showError("");
      const pin = readNewPin("devicesChangeNew", "devicesChangeConfirm");
      if (!pin) return;
      const btn = $("devicesChangeBtn");
      btn.disabled = true;
      try {
        await post({ action: "setOwnerPin", ownerPin, newOwnerPin: pin });
        ownerPin = pin;
        $("devicesChangeNew").value = "";
        $("devicesChangeConfirm").value = "";
        $("devicesChangePin").hidden = true;
        window.RPC_TOAST?.("Owner PIN changed.", { tone: "info", duration: 2500 });
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
      }
    });
    unlockBtn.addEventListener("click", unlock);
    $("devicesOwnerPin").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });

    $("devicesLockBtn").addEventListener("click", () => {
      ownerPin = "";
      devices = [];
      showError("");
      renderPanel();
    });
    $("devicesRefreshBtn").addEventListener("click", () => loadDevices().catch((err) => showError(err.message)));

    $("devicesList").addEventListener("change", (e) => {
      const master = e.target.closest("input[data-device-all]");
      if (master) {
        // Switching on shows all four sections; switching off hides them all.
        saveDevice(master.dataset.deviceAll, { hidden: master.checked ? [] : ALL_KEYS });
        return;
      }
      const box = e.target.closest("input[type=checkbox][data-section]");
      if (box) {
        const id = box.dataset.deviceId;
        const device = devices.find((d) => d.id === id);
        if (!device) return;
        const next = new Set(device.hidden);
        if (box.checked) next.delete(box.dataset.section);
        else next.add(box.dataset.section);
        saveDevice(id, { hidden: [...next] });
        return;
      }
      const name = e.target.closest("input[data-device-name]");
      if (name) saveDevice(name.dataset.deviceName, { name: name.value });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindDevicesPanel();
    renderPanel();
  });
  if (document.readyState !== "loading") bindDevicesPanel();
})();
