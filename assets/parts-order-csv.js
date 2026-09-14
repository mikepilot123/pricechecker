/* Browser-only CSV parser for Parts Orders. Keeping this outside the AI/PDF
   path means a structured order can always be imported without an API key or
   model call. The result is still reviewed before anything is saved. */
(function () {
  function normalizeHeader(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const input = String(text || "").replace(/^\uFEFF/, "");

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    if (quoted) throw new Error("The CSV has an unfinished quoted field.");
    if (field || row.length) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
    }
    return rows.filter((cells) => cells.some((cell) => String(cell).trim()));
  }

  function findColumn(headers, aliases) {
    const normalizedAliases = aliases.map(normalizeHeader);
    return headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
  }

  function numberValue(value, fallback) {
    const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function parsePartsOrderCsv(text) {
    const rows = parseCsvRows(text);
    if (rows.length < 2) throw new Error("The CSV needs a header row and at least one part.");

    const headers = rows[0];
    const partColumn = findColumn(headers, ["part", "item", "description", "product", "part description", "item description"]);
    const quantityColumn = findColumn(headers, ["quantity", "qty", "count"]);
    const unitCostColumn = findColumn(headers, ["unit cost", "unit price", "unit_cost", "price", "cost"]);
    const vendorColumn = findColumn(headers, ["vendor", "supplier"]);
    const shipmentColumn = findColumn(headers, ["shipment name", "shipment", "order name", "batch name"]);

    if (partColumn < 0) {
      throw new Error('Add a "part" column ("item" or "description" also works).');
    }

    const parts = [];
    let vendor = "";
    let shipmentName = "";
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      const part = String(cells[partColumn] || "").trim();
      if (!part) throw new Error(`Row ${i + 1} is missing a part description.`);

      const rawQuantity = quantityColumn >= 0 ? numberValue(cells[quantityColumn], 1) : 1;
      const rawUnitCost = unitCostColumn >= 0 ? numberValue(cells[unitCostColumn], 0) : 0;
      parts.push({
        part,
        quantity: Math.max(1, Math.round(rawQuantity || 1)),
        unitCost: Math.max(0, Math.round((rawUnitCost || 0) * 100) / 100),
      });

      if (!vendor && vendorColumn >= 0) vendor = String(cells[vendorColumn] || "").trim();
      if (!shipmentName && shipmentColumn >= 0) shipmentName = String(cells[shipmentColumn] || "").trim();
    }

    return { vendor, shipmentName, parts };
  }

  window.RPC_PARSE_PARTS_ORDER_CSV = parsePartsOrderCsv;
})();
