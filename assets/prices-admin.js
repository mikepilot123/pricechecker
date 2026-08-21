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
  // Spreadsheet-style rows/columns added here but not yet saved.
  let pending = [];
  let manualColumns = [];
  let selected = new Set();
  let brandFilter = ALL_BRANDS;
  let saving = false;
  let draftSeq = 1;

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
    const extras = pending.filter((p) => !p.name || !liveNames.has(p.name.toLowerCase()));
    return live.concat(extras);
  }

  function valueFor(model, type) {
    if (model.draftId) {
      const entry = model.prices.find((p) => p.type === type);
      return entry ? String(entry.value) : "";
    }
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

  // Brand edits ride the same per-model dirty bag as price cells, under a
  // key ("__brand") that can never collide with a real repair-type column
  // name — save() below splits it back out before building the payload.
  function brandValueFor(model) {
    const edit = dirty.get(model.name);
    if (edit && Object.prototype.hasOwnProperty.call(edit, "__brand")) return edit.__brand;
    return model.brand || "";
  }

  function setBrand(name, value) {
    const edit = dirty.get(name) || {};
    edit.__brand = value;
    dirty.set(name, edit);
    renderSaveBar();
  }

  function draftById(id) {
    return pending.find((row) => row.draftId === id);
  }

  function setDraftValue(id, type, value) {
    const draft = draftById(id);
    if (!draft) return;
    const idx = draft.prices.findIndex((p) => p.type === type);
    if (idx >= 0) draft.prices[idx].value = value;
    else draft.prices.push({ type, value });
    renderSaveBar();
  }

  function updateDraftField(id, field, value) {
    const draft = draftById(id);
    if (!draft) return;
    draft[field] = value.trim();
    renderSaveBar();
  }

  function visibleModels() {
    const q = ($("priceAdminSearch")?.value || "").trim().toLowerCase();
    return allModels().filter((m) => {
      if (m.draftId) return true;
      if (brandFilter !== ALL_BRANDS && m.brand !== brandFilter) return false;
      if (q && !m.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  /** Repair-type columns for the models on screen, in first-seen order. */
  function columnsFor(models) {
    const seen = [];
    const add = (type) => {
      const clean = String(type || "").trim();
      if (clean && !seen.some((c) => c.toLowerCase() === clean.toLowerCase())) seen.push(clean);
    };
    for (const model of models) {
      for (const price of model.prices) {
        add(price.type);
      }
      const edit = dirty.get(model.name);
      if (edit) {
        for (const type of Object.keys(edit)) {
          add(type);
        }
      }
    }
    manualColumns.forEach(add);
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
    // Columns come from every model, not just the ones the search/brand
    // filter is currently showing — otherwise filtering down to a model
    // that has no "Battery" price yet (say) makes the Battery column vanish
    // entirely, with no way to add one for it.
    const columns = columnsFor(allModels());
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
          <th class="price-admin-brand-col">Brand</th>
          ${columns.map((c) => `<th>${esc(c)}</th>`).join("")}
          <th class="price-admin-actions-col" aria-label="Actions"></th>
        </tr>
      </thead>`;

    const rows = models
      .map((model) => {
        const draft = !!model.draftId;
        const cells = columns
          .map((type) => {
            const value = valueFor(model, type);
            const isDirty = draft || (dirty.get(model.name) && Object.prototype.hasOwnProperty.call(dirty.get(model.name), type));
            return `<td><input class="price-admin-cell${isDirty ? " dirty" : ""}" type="text" inputmode="decimal"
              value="${esc(value)}" data-model="${esc(model.name)}" data-draft-id="${esc(model.draftId || "")}" data-type="${esc(type)}"
              aria-label="${esc((model.name || "New model") + " — " + type)}" /></td>`;
          })
          .join("");
        const rowLabel = model.name || "New model";
        return `<tr data-model="${esc(model.name)}" data-draft-id="${esc(model.draftId || "")}" class="${draft ? "price-admin-draft-row" : ""}">
          <td class="price-admin-check-col">${draft ? "" : `<input type="checkbox" class="price-admin-select" data-model="${esc(model.name)}" ${selected.has(model.name) ? "checked" : ""} aria-label="Select ${esc(model.name)}" />`}</td>
          <td class="price-admin-model-col">
            ${draft
              ? `<input class="price-admin-text-cell price-admin-model-input" type="text" value="${esc(model.name)}" data-draft-id="${esc(model.draftId)}" data-draft-field="name" placeholder="Model name" aria-label="New model name" />`
              : `<span class="price-admin-model-name">${esc(model.name)}</span>`}
          </td>
          <td class="price-admin-brand-col">
            ${draft
              ? `<input class="price-admin-text-cell" type="text" value="${esc(model.brand || "")}" data-draft-id="${esc(model.draftId)}" data-draft-field="brand" placeholder="Brand" aria-label="New model brand" />`
              : `<input class="price-admin-text-cell price-admin-brand-cell${dirty.get(model.name)?.__brand != null ? " dirty" : ""}" type="text"
                  value="${esc(brandValueFor(model))}" data-model="${esc(model.name)}" data-brand-field placeholder="Brand"
                  aria-label="Brand for ${esc(model.name)}" />`}
          </td>
          ${cells}
          <td class="price-admin-actions-col">
            <button type="button" class="icon-btn ghost-btn danger-btn price-admin-delete" ${draft ? `data-draft-id="${esc(model.draftId)}"` : `data-model="${esc(model.name)}"`} aria-label="Delete ${esc(rowLabel)}"><svg class="icon"><use href="#i-trash"></use></svg></button>
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
        if (input.dataset.draftId) setDraftValue(input.dataset.draftId, input.dataset.type, input.value.trim());
        else setValue(input.dataset.model, input.dataset.type, input.value.trim());
      });
      input.addEventListener("keydown", handleCellKeydown);
    });
    grid.querySelectorAll("[data-draft-field]").forEach((input) => {
      input.addEventListener("input", () => {
        input.classList.add("dirty");
        updateDraftField(input.dataset.draftId, input.dataset.draftField, input.value);
      });
      input.addEventListener("keydown", handleCellKeydown);
    });
    grid.querySelectorAll("[data-brand-field]").forEach((input) => {
      input.addEventListener("input", () => {
        input.classList.add("dirty");
        setBrand(input.dataset.model, input.value.trim());
      });
      input.addEventListener("keydown", handleCellKeydown);
    });
    grid.querySelectorAll(".price-admin-select").forEach((box) => {
      box.addEventListener("change", () => {
        if (box.checked) selected.add(box.dataset.model);
        else selected.delete(box.dataset.model);
        renderBulkBar(columnsFor(visibleModels()));
      });
    });
    $("priceAdminSelectAll")?.addEventListener("change", (e) => {
      const names = visibleModels().filter((m) => !m.draftId).map((m) => m.name);
      if (e.target.checked) names.forEach((n) => selected.add(n));
      else names.forEach((n) => selected.delete(n));
      render();
    });
    grid.querySelectorAll(".price-admin-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.draftId) deleteDraft(btn.dataset.draftId);
        else deleteModel(btn.dataset.model);
      });
    });
  }

  function handleCellKeydown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const cell = event.target.closest("td");
    const row = event.target.closest("tr");
    if (!cell || !row) return;
    const rowIndex = [...row.parentElement.children].indexOf(row);
    const cellIndex = [...row.children].indexOf(cell);
    const nextRow = row.parentElement.children[rowIndex + 1];
    const next = nextRow?.children[cellIndex]?.querySelector("input");
    if (next) {
      next.focus();
      next.select?.();
    }
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
    const cells = unsavedCount();
    bar.hidden = cells === 0;
    $("priceAdminDirtyCount").textContent =
      `${cells} unsaved change${cells === 1 ? "" : "s"}`;
  }

  function unsavedCount() {
    let cells = 0;
    for (const edit of dirty.values()) cells += Object.keys(edit).length;
    cells += pending.filter((row) =>
      row.name || row.brand || row.prices.some((price) => String(price.value || "").trim())
    ).length;
    return cells;
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
    if (saving || !unsavedCount()) return;
    if (!storedPin()) return showError("Enter the team PIN in Settings first.");
    const btn = $("priceAdminSave");
    saving = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    showError("");

    const byName = new Map(allModels().map((m) => [m.name, m]));
    const payload = [...dirty.entries()].map(([name, entries]) => {
      const { __brand, ...prices } = entries;
      return {
        name,
        brand: __brand != null ? __brand : byName.get(name)?.brand || "",
        entries: Object.entries(prices).map(([type, value]) => ({ type, value })),
      };
    });
    const liveNames = new Set((Array.isArray(window.RPC_PRICE_MODELS) ? window.RPC_PRICE_MODELS : []).map((m) => m.name.toLowerCase()));
    const draftNames = new Set();
    for (const row of pending) {
      const name = String(row.name || "").trim();
      const brand = String(row.brand || "").trim();
      const entries = row.prices
        .map((entry) => ({ type: String(entry.type || "").trim(), value: String(entry.value || "").trim() }))
        .filter((entry) => entry.type && entry.value);
      const hasAnyValue = !!brand || entries.length > 0;
      if (!name && hasAnyValue) {
        showError("New rows need a model name before saving.");
        saving = false;
        btn.disabled = false;
        btn.textContent = "Save changes";
        return;
      }
      if (!name) continue;
      const key = name.toLowerCase();
      if (liveNames.has(key) || draftNames.has(key)) {
        showError(`${name} is already in the list.`);
        saving = false;
        btn.disabled = false;
        btn.textContent = "Save changes";
        return;
      }
      draftNames.add(key);
      payload.push({ name, brand, entries });
    }

    try {
      const res = await window.RPC_SAVE_PRICES(payload);
      if (!res.ok) throw new Error(res.error || "Rejected");
      dirty = new Map();
      pending = [];
      manualColumns = [];
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

  function deleteDraft(id) {
    showError("");
    pending = pending.filter((row) => row.draftId !== id);
    render();
    renderSaveBar();
  }

  function addRow() {
    showError("");
    const draftId = "draft-" + (draftSeq++);
    pending.unshift({
      draftId,
      name: "",
      brand: brandFilter !== ALL_BRANDS ? brandFilter : "",
      prices: [],
      fromSheet: false,
      edited: true,
    });
    render();
    grid.querySelector(`[data-draft-id="${draftId}"][data-draft-field="name"]`)?.focus();
  }

  function addColumn() {
    const raw = prompt("Repair column name");
    const name = String(raw || "").trim().replace(/\s+/g, " ");
    if (!name) return;
    const exists = columnsFor(allModels()).some((c) => c.toLowerCase() === name.toLowerCase());
    if (exists) return showError(`${name} is already a column.`);
    showError("");
    manualColumns.push(name);
    render();
    const firstCell = [...grid.querySelectorAll(".price-admin-cell")].find((input) => input.dataset.type === name);
    firstCell?.focus();
  }

  // ---- Wiring ---------------------------------------------------------------
  $("priceAdminSearch")?.addEventListener("input", render);
  $("priceAdminBrand")?.addEventListener("change", (e) => {
    brandFilter = e.target.value;
    render();
  });
  $("priceAdminAddRowBtn")?.addEventListener("click", addRow);
  $("priceAdminAddColumn")?.addEventListener("click", addColumn);
  $("priceAdminBulkApply")?.addEventListener("click", applyBulk);
  $("priceAdminSave")?.addEventListener("click", save);
  $("priceAdminDiscard")?.addEventListener("click", () => {
    dirty = new Map();
    pending = [];
    manualColumns = [];
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
