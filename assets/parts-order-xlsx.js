/* Browser-only Excel importer for Parts Orders. Reads the workbook on the
   device with native ZIP decompression; no upload or AI extraction is used. */
(function () {
  const decoder = new TextDecoder("utf-8");
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_XML_BYTES = 24 * 1024 * 1024;

  function xmlText(value) {
    return String(value || "").replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
      if (entity[0] === "#") {
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()] || match;
    });
  }

  function attribute(tag, name) {
    const match = tag.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
    return match ? xmlText(match[2]) : "";
  }

  function tags(xml, name) {
    return [...xml.matchAll(new RegExp("<(?:[A-Za-z0-9_]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?" + name + "\\s*>", "gi"))];
  }

  function textRuns(xml) {
    return tags(xml, "t").map((match) => xmlText(match[1])).join("");
  }

  function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("This is not a valid .xlsx workbook.");
    const count = view.getUint16(end + 10, true);
    const start = view.getUint32(end + 16, true);
    if (count > 2000 || start >= bytes.length) throw new Error("The workbook is too large or invalid.");
    const entries = new Map();
    let offset = start;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("The workbook ZIP directory is invalid.");
      const method = view.getUint16(offset + 10, true);
      const size = view.getUint32(offset + 20, true);
      const expandedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > bytes.length || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("The workbook ZIP entry is invalid.");
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (dataStart + size > bytes.length || expandedSize > MAX_XML_BYTES) throw new Error("The workbook contains an oversized or invalid sheet.");
      entries.set(name, { method, compressed: bytes.subarray(dataStart, dataStart + size), expandedSize });
      offset = next;
    }
    return entries;
  }

  async function zipXml(entries, path) {
    const entry = entries.get(path);
    if (!entry) return "";
    if (entry.method === 0) return decoder.decode(entry.compressed);
    if (entry.method !== 8 || typeof DecompressionStream !== "function") {
      throw new Error("This browser cannot read the compression in this workbook.");
    }
    const stream = new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const output = await new Response(stream).arrayBuffer();
    if (output.byteLength > MAX_XML_BYTES || output.byteLength !== entry.expandedSize) throw new Error("The workbook contains an oversized or invalid sheet.");
    return decoder.decode(output);
  }

  function worksheetPaths(entries, workbook, relationships) {
    const targets = new Map();
    for (const match of relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
      targets.set(attribute(match[0], "Id"), attribute(match[0], "Target"));
    }
    const paths = [];
    for (const match of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/gi)) {
      const target = targets.get(attribute(match[0], "r:id"));
      if (!target) continue;
      const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
      if (entries.has(path)) paths.push(path);
    }
    if (!paths.length) paths.push(...[...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort());
    return paths;
  }

  function sheetRows(xml, sharedStrings) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row\s*>/gi)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c\s*>/gi)) {
        const tag = cellMatch[0].slice(0, cellMatch[0].indexOf(">") + 1);
        const ref = attribute(tag, "r");
        const letters = ref.match(/^[A-Z]+/i)?.[0] || "";
        let column = 0;
        for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
        if (!column || column > 256) continue;
        const type = attribute(tag, "t");
        const raw = tags(cellMatch[1], "v")[0]?.[1] || "";
        cells[column - 1] = type === "s" ? (sharedStrings[Number(raw)] || "")
          : type === "inlineStr" ? textRuns(cellMatch[1]) : xmlText(raw);
      }
      if (cells.some((cell) => String(cell ?? "").trim())) {
        rows.push({ number: Number(attribute(rowMatch[0].slice(0, rowMatch[0].indexOf(">") + 1), "r")) || rows.length + 1, cells });
      }
    }
    return rows;
  }

  function normalize(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function column(headers, aliases) { return headers.findIndex((header) => aliases.map(normalize).includes(normalize(header))); }
  function numeric(value, fallback) {
    const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function partsFromRows(rows) {
    if (rows.length < 2) return null;
    const headerIndex = rows.slice(0, 25).findIndex((row) => column(row.cells, ["part", "item", "description", "product", "part description", "item description"]) >= 0);
    if (headerIndex < 0 || headerIndex >= rows.length - 1) return null;
    const headers = rows[headerIndex].cells;
    const partColumn = column(headers, ["part", "item", "description", "product", "part description", "item description"]);
    const quantityColumn = column(headers, ["quantity", "qty", "count"]);
    const costColumn = column(headers, ["unit cost", "unit price", "unit_cost", "price", "cost"]);
    const vendorColumn = column(headers, ["vendor", "supplier"]);
    const shipmentColumn = column(headers, ["shipment name", "shipment", "order name", "batch name"]);
    const parts = [];
    let vendor = "", shipmentName = "";
    for (const row of rows.slice(headerIndex + 1)) {
      const cells = row.cells;
      const part = String(cells[partColumn] || "").trim();
      if (!part) throw new Error(`Row ${row.number} is missing a part description.`);
      const quantity = quantityColumn >= 0 ? numeric(cells[quantityColumn], 1) : 1;
      const cost = costColumn >= 0 ? numeric(cells[costColumn], 0) : 0;
      parts.push({ part, quantity: Math.max(1, Math.round(quantity || 1)), unitCost: Math.max(0, Math.round((cost || 0) * 100) / 100) });
      if (!vendor && vendorColumn >= 0) vendor = String(cells[vendorColumn] || "").trim();
      if (!shipmentName && shipmentColumn >= 0) shipmentName = String(cells[shipmentColumn] || "").trim();
    }
    return { vendor, shipmentName, parts };
  }

  async function parsePartsOrderXlsx(buffer) {
    const bytes = new Uint8Array(buffer);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Choose an .xlsx file smaller than 8MB.");
    const entries = readZip(bytes);
    const workbook = await zipXml(entries, "xl/workbook.xml");
    const relationships = await zipXml(entries, "xl/_rels/workbook.xml.rels");
    if (!workbook) throw new Error("The file is not an Excel .xlsx workbook.");
    const sharedXml = await zipXml(entries, "xl/sharedStrings.xml");
    const sharedStrings = tags(sharedXml, "si").map((match) => textRuns(match[1]));
    for (const path of worksheetPaths(entries, workbook, relationships)) {
      const result = partsFromRows(sheetRows(await zipXml(entries, path), sharedStrings));
      if (result) return result;
    }
    const error = new Error('No sheet has a "part" column with at least one item. "item" or "description" also works.');
    error.code = "NO_PART_COLUMN";
    throw error;
  }

  window.RPC_PARSE_PARTS_ORDER_XLSX = parsePartsOrderXlsx;
})();
