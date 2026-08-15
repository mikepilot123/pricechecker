/* ============================================================
   Settings → Repair prices
   A spreadsheet-style bulk editor for the price list, so staff never
   need to open the Google Sheet to change a price.

   Data flow: assets/app.js owns the price data — it merges the sheet CSV
   with the app's own catalog (api/prices.js) and publishes the result as
   window.RPC_PRICE_MODELS. This file only renders that list and writes
   changes back through window.RPC_SAVE_PRICES / RPC_DELETE_PRICE_MODEL.

   Columns are the union of the repair types present in the *filtered*
   models, so picking a brand narrows the grid to that brand's own repairs
   instead of showing every column in the shop with mostly blank cells.
   ============================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const grid = $("priceAdminGrid");
  if (!grid) return;

  const INTAKE_PIN_KEY = "rpc_intake_pin";
  const ALL_BRANDS = "__all__";

  // name -> { type -> value }. Only cells the user actually changed, so a
  // save sends a handful of rows even after scrolling the whole catalog.
  let dirty = new Map();
  // Models added here but not yet saved, plus brand-new columns.
  let pending = [];
  let selected = new Set();
  let brandFilter = ALL_BRANDS;
  let saving = false;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const storedPin = () => {
    try { return localStorage.getItem(INTAKE_PIN_KEY) || ""; } catch (_) { return ""; }
  };

  /** The catalog as app.js merged it, plus any rows added but not yet saved. */
  function allModels() {
    const live = Array.isArray(window.RPC_PRICE_MODELS) ? window.RPC_PRICE_MODELS : [];
    const liveNames = new Set(live.map((m) => m.name.toLowerCase()));
    const extras = pending.filter((p) => !liveNames.has(p.name.toLowerCase()));
    return live.concat(extras);
  }

  function valueFor(model, type) {
    const edit = dirty.get(model.name);
    if (edit && Object.prototype.hasOwnProperty.call(edit, type)) return edit[type];
    const entry = model.prices.find((p) => p.type === type);
    return entry ? String(entry.value) : "";
  }

  function setValue(name, type, value) {
    const edit = dirty.get(name) || {};
    edit[type] = value;
    dirty.set(name, edit);
    renderSaveBar();
  }

  function visibleModels() {
    const q = ($("priceAdminSearch")?.value || "").trim().toLowerCase();
    return allModels().filter((m) => {
      if (brandFilter !== ALL_BRANDS && m.brand !== brandFilter) return false;
      if (q && !m.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  /** Repair-type columns for the models on screen, in first-seen order. */
  function columnsFor(models) {
    const seen = [];
    for (const model of models) {
      for (const price of model.prices) {
        if (!seen.includes(price.type)) seen.push(price.type);
      }
      const edit = dirty.get(model.name);
      if (edit) {
        for (const type of Object.keys(edit)) {
          if (!seen.includes(type)) seen.push(type);
        }
      }
    }
    return seen;
  }

  function renderBrandFilter() {
    const select = $("priceAdminBrand");
    if (!select) return;
    const brands = [...new Set(allModels().map((m) => m.brand).filter(Boolean))].sort();
    if (!brands.includes(brandFilter)) brandFilter = ALL_BRANDS;
    select.innerHTML =
      `<option value="${ALL_BRANDS}">All brands</option>` +
      brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
    select.value = brandFilter;
  }

  function render() {
    renderBrandFilter();
    const models = visibleModels();
    const columns = columnsFor(models);
    const total = allModels().length;

    const countEl = $("priceAdminCount");
    if (countEl) {
      countEl.textContent = total
        ? `Showing ${models.length} of ${total} model${total === 1 ? "" : "s"}`
        : "";
    }

    if (!total) {
      grid.innerHTML = `<tbody><tr><td class="price-admin-empty">Prices are still loading — open the Prices tab once, then come back.</td></tr></tbody>`;
      renderBulkBar(columns);
      renderSaveBar();
      return;
    }
    if (!models.length) {
      grid.innerHTML = `<tbody><tr><td class="price-admin-empty">No models match this search.</td></tr></tbody>`;
      renderBulkBar(columns);
      renderSaveBar();
      return;
    }

    const head = `
      <thead>
        <tr>
          <th class="price-admin-check-col"><input type="checkbox" id="priceAdminSelectAll" aria-label="Select all shown" /></th>
          <th class="price-admin-model-col">Model</th>
          ${columns.map((c) => `<th>${esc(c)}</th>`).join("")}
          <th class="price-admin-actions-col" aria-label="Actions"></th>
        </tr>
      </thead>`;

    const rows = models
      .map((model) => {
        const cells = columns
          .map((type) => {
            const value = valueFor(model, type);
            const isDirty = dirty.get(model.name) && Object.prototype.hasOwnProperty.call(dirty.get(model.name), type);
            return `<td><input class="price-admin-cell${isDirty ? " dirty" : ""}" type="text" inputmode="decimal"
              value="${esc(value)}" data-model="${esc(model.name)}" data-type="${esc(type)}"
              aria-label="${esc(model.name)} — ${esc(type)}" /></td>`;
          })
          .join("");
        return `<tr data-model="${esc(model.name)}">
          <td class="price-admin-check-col"><input type="checkbox" class="price-admin-select" data-model="${esc(model.name)}" ${selected.has(model.name) ? "checked" : ""} aria-label="Select ${esc(model.name)}" /></td>
          <td class="price-admin-model-col">
            <span class="price-admin-model-name">${esc(model.name)}</span>
            <span class="price-admin-brand">${esc(model.brand || "—")}</span>
          </td>
          ${cells}
          <td class="price-admin-actions-col">
            <button type="button" class="icon-btn ghost-btn danger-btn price-admin-delete" data-model="${esc(model.name)}" aria-label="Delete ${esc(model.name)}"><svg class="icon"><use href="#i-trash"></use></svg></button>
          </td>
        </tr>`;
      })
      .join("");

    grid.innerHTML = head + `<tbody>${rows}</tbody>`;
    bindGrid();
    renderBulkBar(columns);
    renderSaveBar();
  }

  function bindGrid() {
    grid.querySelectorAll(".price-admin-cell").forEach((input) => {
      input.addEventListener("input", () => {
        input.classList.add("dirty");
        setValue(input.dataset.model, input.dataset.type, input.value.trim());
      });
    });
    grid.querySelectorAll(".price-admin-select").forEach((box) => {
      box.addEventListener("change", () => {
        if (box.checked) selected.add(box.dataset.model);
        else selected.delete(box.dataset.model);
        renderBulkBar(columnsFor(visibleModels()));
      });
    });
    $("priceAdminSelectAll")?.addEventListener("change", (e) => {
      const names = visibleModels().map((m) => m.name);
      if (e.target.checked) names.forEach((n) => selected.add(n));
      else names.forEach((n) => selected.delete(n));
      render();
    });
    grid.querySelectorAll(".price-admin-delete").forEach((btn) => {
      btn.addEventListener("click", () => deleteModel(btn.dataset.model));
    });
  }

  function renderBulkBar(columns) {
    const bar = $("priceAdminBulk");
    if (!bar) return;
    bar.hidden = selected.size === 0;
    if (!selected.size) return;
    $("priceAdminSelectedCount").textContent =
      `${selected.size} selected`;
    const select = $("priceAdminBulkColumn");
    const previous = select.value;
    select.innerHTML = columns.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    if (columns.includes(previous)) select.value = previous;
  }

  function renderSaveBar() {
    const bar = $("priceAdminSaveBar");
    if (!bar) return;
    let cells = 0;
    for (const edit of dirty.values()) cells += Object.keys(edit).length;
    bar.hidden = cells === 0;
    $("priceAdminDirtyCount").textContent =
      `${cells} unsaved change${cells === 1 ? "" : "s"}`;
  }

  function showError(message) {
    const err = $("priceAdminError");
    if (!err) return;
    err.hidden = !message;
    if (message) err.textContent = message;
  }

  // ---- Bulk adjust ----------------------------------------------------------
  // The Shopify-style part: pick a column, pick an operation, apply it to every
  // selected row at once. Rows with no existing price are skipped for the
  // relative modes — there's nothing to increase by 10% of.
  function applyBulk() {
    const column = $("priceAdminBulkColumn")?.value;
    const mode = $("priceAdminBulkMode")?.value;
    const raw = ($("priceAdminBulkValue")?.value || "").trim();
    const amount = parseFloat(raw.replace(/[^0-9.]/g, ""));
    if (!column) return showError("Pick a column to adjust.");
    if (isNaN(amount)) return showError("Enter a number to apply.");
    showError("");

    const byName = new Map(allModels().map((m) => [m.name, m]));
    let changed = 0;
    for (const name of selected) {
      const model = byName.get(name);
      if (!model) continue;
      const current = parseFloat(String(valueFor(model, column)).replace(/[^0-9.]/g, ""));
      let next;
      if (mode === "set") {
        next = amount;
      } else {
        if (isNaN(current)) continue;
        if (mode === "increase-amount") next = current + amount;
        else if (mode === "decrease-amount") next = current - amount;
        else if (mode === "increase-percent") next = current * (1 + amount / 100);
        else if (mode === "decrease-percent") next = current * (1 - amount / 100);
        else next = current;
      }
      next = Math.max(0, Math.round(next * 100) / 100);
      setValue(name, column, String(next));
      changed += 1;
    }
    if (!changed) return showError("Nothing to adjust — the selected rows have no price in that column yet.");
    render();
  }

  // ---- Saving ---------------------------------------------------------------
  async function save() {
    if (saving || !dirty.size) return;
    if (!storedPin()) return showError("Enter the team PIN in Settings first.");
    const btn = $("priceAdminSave");
    saving = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    showError("");

    const byName = new Map(allModels().map((m) => [m.name, m]));
    const payload = [...dirty.entries()].map(([name, entries]) => ({
      name,
      brand: byName.get(name)?.brand || "",
      entries: Object.entries(entries).map(([type, value]) => ({ type, value })),
    }));

    try {
      const res = await window.RPC_SAVE_PRICES(payload);
      if (!res.ok) throw new Error(res.error || "Rejected");
      dirty = new Map();
      pending = [];
      selected = new Set();
      await window.RPC_RELOAD_PRICES();
      render();
    } catch (err) {
      showError("Couldn't save: " + err.message);
    } finally {
      saving = false;
      btn.disabled = false;
      btn.textContent = "Save changes";
    }
  }

  async function deleteModel(name) {
    if (!storedPin()) return showError("Enter the team PIN in Settings first.");
    if (!confirm(`Remove ${name} from the price list?`)) return;
    showError("");
    try {
      const res = await window.RPC_DELETE_PRICE_MODEL(name);
      if (!res.ok) throw new Error(res.error || "Rejected");
      dirty.delete(name);
      pending = pending.filter((p) => p.name !== name);
      selected.delete(name);
      await window.RPC_RELOAD_PRICES();
      render();
    } catch (err) {
      showError("Couldn't delete: " + err.message);
    }
  }

  function addModel() {
    const nameInput = $("priceAdminNewName");
    const brandInput = $("priceAdminNewBrand");
    const name = (nameInput.value || "").trim();
    const brand = (brandInput.value || "").trim();
    if (!name) return showError("Enter a model name.");
    if (allModels().some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      return showError(`${name} is already in the list.`);
    }
    showError("");
    // Held locally until Save, same as any other edit — a model with no prices
    // yet would otherwise be written to the catalog on every keystroke.
    pending.push({ name, brand, prices: [], fromSheet: false, edited: true });
    dirty.set(name, dirty.get(name) || {});
    nameInput.value = "";
    brandInput.value = "";
    if (brand) brandFilter = brand;
    render();
    renderSaveBar();
  }

  // ---- Wiring ---------------------------------------------------------------
  $("priceAdminSearch")?.addEventListener("input", render);
  $("priceAdminBrand")?.addEventListener("change", (e) => {
    brandFilter = e.target.value;
    render();
  });
  $("priceAdminAddToggle")?.addEventListener("click", () => {
    const row = $("priceAdminAddRow");
    row.hidden = !row.hidden;
    if (!row.hidden) $("priceAdminNewName").focus();
  });
  $("priceAdminAdd")?.addEventListener("click", addModel);
  $("priceAdminNewBrand")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addModel(); }
  });
  $("priceAdminNewName")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addModel(); }
  });
  $("priceAdminBulkApply")?.addEventListener("click", applyBulk);
  $("priceAdminSave")?.addEventListener("click", save);
  $("priceAdminDiscard")?.addEventListener("click", () => {
    dirty = new Map();
    pending = [];
    showError("");
    render();
  });

  // app.js publishes this after every sync; re-render so the grid tracks the
  // live list without the user reopening Settings.
  window.addEventListener("rpc-price-models", () => {
    if (!dirty.size) render();
    else renderBrandFilter();
  });

  render();
})();
