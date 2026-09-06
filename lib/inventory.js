import { createSign } from "node:crypto";

export const INVENTORY_SHEET_ID =
  process.env.INVENTORY_SHEET_ID || "1CtKYaNkcrlU1-76NvIQUK31V0OAEhwNZHkzWZOUDZVA";
export const INVENTORY_SHEET_GID = process.env.INVENTORY_SHEET_GID || "85811363";

const PUBLIC_CSV_URL =
  `https://docs.google.com/spreadsheets/d/${INVENTORY_SHEET_ID}/export?format=csv&gid=${INVENTORY_SHEET_GID}`;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let accessTokenCache = null;
let sheetTitleCache = null;

export async function listInventory() {
  const res = await fetch(PUBLIC_CSV_URL + "&_=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Inventory sheet returned HTTP ${res.status}`);
  const rows = parseCSV(await res.text());
  return parseInventoryRows(rows);
}

export async function adjustInventoryItem(itemKey, delta, { reason = "" } = {}) {
  if (!itemKey || !delta) return null;
  if (!Number.isInteger(delta)) throw new Error("Inventory adjustment must be a whole number");

  const inventory = await listInventory();
  const item = inventory.items.find((candidate) => candidate.key === itemKey);
  if (!item) throw new Error("Inventory item not found: " + itemKey);
  if (!item.quantityCell) throw new Error("Inventory item cannot be updated: " + item.label);

  const nextQuantity = item.quantity + delta;
  if (nextQuantity < 0) throw new Error(`${item.label} is out of stock`);

  await writeInventoryQuantity(item.quantityCell, nextQuantity);
  return {
    key: item.key,
    label: item.label,
    section: item.section,
    previousQuantity: item.quantity,
    quantity: nextQuantity,
    delta,
    reason,
  };
}

export async function consumeInventoryItem(itemKey, ticketId) {
  return adjustInventoryItem(itemKey, -1, { reason: ticketId ? `Ticket ${ticketId}` : "Ticket logged" });
}

export async function restockInventoryItem(itemKey, ticketId) {
  return adjustInventoryItem(itemKey, 1, { reason: ticketId ? `Ticket ${ticketId} deleted` : "Ticket deleted" });
}

// Adds a brand-new row to an existing section rather than just adjusting an
// existing row's quantity. Inserts right after that section's last item (so
// the sheet's visual grouping by section is preserved) and only fills the
// columns that section's own header row defines — sections without a
// quality/type column (e.g. TOOLS) never get one added.
export async function addInventoryItem({ section, item, quality, quantity }) {
  const sectionName = String(section || "").trim().toUpperCase();
  const name = String(item || "").trim();
  const qty = Number(quantity);
  if (!sectionName) throw new Error("Section is required");
  if (!name) throw new Error("Item name is required");
  if (!Number.isInteger(qty) || qty < 0) throw new Error("Starting quantity must be a whole number, 0 or more");

  const inventory = await listInventory();
  const fields = (inventory.sectionFields || []).find((entry) => entry.section === sectionName);
  if (!fields) throw new Error("Unknown inventory section: " + sectionName);

  const trimmedQuality = String(quality || "").trim();
  if (trimmedQuality && !fields.qualityCol) {
    throw new Error(`${sectionName} doesn't have a quality/type column`);
  }

  const duplicate = inventory.items.find((candidate) =>
    candidate.section === sectionName &&
    candidate.item.toLowerCase() === name.toLowerCase() &&
    (candidate.quality || "").toLowerCase() === trimmedQuality.toLowerCase()
  );
  if (duplicate) throw new Error(`${name}${trimmedQuality ? " · " + trimmedQuality : ""} already exists in ${sectionName} — adjust its quantity instead`);

  const insertRowNumber = fields.lastRowNumber + 1;
  const token = await googleAccessToken();
  const title = await inventorySheetTitle(token);

  await insertSheetRow(token, insertRowNumber);

  const writes = [
    { col: fields.nameCol, value: name },
    { col: fields.quantityCol, value: qty },
  ];
  if (fields.qualityCol && trimmedQuality) writes.push({ col: fields.qualityCol, value: trimmedQuality });
  await writeInventoryRow(token, title, insertRowNumber, writes);

  return listInventory();
}

export function inventoryLabelFromKey(itemKey) {
  if (!itemKey) return "";
  const parts = itemKey.split("|").map(decodeKeyPart);
  const section = parts[0] || "";
  const item = parts[1] || "";
  const quality = parts[2] || "";
  return [item, quality, section].filter(Boolean).join(" · ");
}

function parseInventoryRows(rows) {
  const items = [];
  let section = "";
  let headers = [];
  // One entry per section, keyed by name — lets addInventoryItem() find
  // which columns to write into and which row a new item belongs after,
  // without re-parsing the sheet from scratch.
  const sectionFields = new Map();

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const cells = row.map((cell) => String(cell || "").trim());
    const first = cells[0] || "";
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) return;

    if (nonEmpty.length === 1 && /^[A-Z][A-Z\s/&-]+$/.test(first)) {
      section = first.toUpperCase();
      headers = [];
      return;
    }

    if (section && looksLikeHeader(cells)) {
      headers = cells.map(normalizeHeader);
      const quantityCol = findHeader(headers, ["quantity", "qty"]);
      const deviceCol = findHeader(headers, ["device", "item", "name"]);
      const qualityCol = findHeader(headers, ["quality", "type"]);
      if (quantityCol >= 0 && deviceCol >= 0) {
        sectionFields.set(section, {
          section,
          headerRowNumber: rowNumber,
          lastRowNumber: rowNumber,
          nameCol: deviceCol + 1,
          qualityCol: qualityCol >= 0 ? qualityCol + 1 : null,
          quantityCol: quantityCol + 1,
        });
      }
      return;
    }

    if (!section || !headers.length) return;

    const quantityCol = findHeader(headers, ["quantity", "qty"]);
    if (quantityCol < 0) return;

    const rawQuantity = cells[quantityCol] || "";
    if (!/^-?\d+$/.test(rawQuantity)) return;

    const deviceCol = findHeader(headers, ["device", "item", "name"]);
    const fallbackNameCol = cells.findIndex((cell, col) => col !== quantityCol && cell);
    const nameCol = deviceCol >= 0 ? deviceCol : (fallbackNameCol >= 0 ? fallbackNameCol : 0);
    const name = cells[nameCol] || "";
    if (!name) return;

    const qualityCol = findHeader(headers, ["quality", "type"]);
    const noteCol = firstTextCol(cells, [nameCol, qualityCol, quantityCol]);
    const quality = qualityCol >= 0 ? cells[qualityCol] || "" : "";
    const quantity = Number(rawQuantity);
    const note = noteCol >= 0 ? cells[noteCol] || "" : "";
    const key = inventoryKey(section, name, quality);
    const label = [name, quality].filter(Boolean).join(" · ");

    items.push({
      key,
      section,
      item: name,
      device: section === "TOOLS" ? "" : name,
      quality,
      quantity,
      note,
      label,
      rowNumber,
      quantityCell: `${columnName(quantityCol + 1)}${rowNumber}`,
      status: quantity <= 0 ? "out" : quantity <= 1 ? "low" : "ok",
    });

    const fields = sectionFields.get(section);
    if (fields) fields.lastRowNumber = rowNumber;
  });

  return {
    updatedAt: new Date().toISOString(),
    sections: [...new Set(items.map((item) => item.section))],
    sectionFields: [...sectionFields.values()],
    items,
  };
}

function looksLikeHeader(cells) {
  const normalized = cells.map(normalizeHeader);
  return normalized.includes("quantity") || normalized.includes("qty");
}

function findHeader(headers, names) {
  return headers.findIndex((header) => names.includes(header));
}

function firstTextCol(cells, excluded) {
  return cells.findIndex((cell, col) => cell && !excluded.includes(col) && !/^-?\d+$/.test(cell));
}

function normalizeHeader(text) {
  return String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function inventoryKey(section, item, quality) {
  return [section, item, quality].map(encodeKeyPart).join("|");
}

function encodeKeyPart(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function decodeKeyPart(value) {
  return String(value || "").trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function columnName(index) {
  let n = index;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

async function writeInventoryQuantity(cell, quantity) {
  const token = await googleAccessToken();
  const title = await inventorySheetTitle(token);
  const range = `'${title.replace(/'/g, "''")}'!${cell}`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}/values/${encodeURIComponent(range)}` +
    "?valueInputOption=USER_ENTERED";
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ range, majorDimension: "ROWS", values: [[quantity]] }),
  });
  if (!res.ok) throw new Error(`Couldn't update inventory sheet: ${await res.text()}`);
}

// Inserts one blank row at rowNumber (1-indexed), shifting that row and
// everything below it down by one — this is what keeps a new item grouped
// under the right section instead of landing at the bottom of the sheet.
async function insertSheetRow(token, rowNumber) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{
        insertDimension: {
          range: { sheetId: Number(INVENTORY_SHEET_GID), dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
          inheritFromBefore: true,
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`Couldn't insert an inventory row: ${await res.text()}`);
}

// Writes several non-contiguous cells on one row in a single call — the
// name/quality/quantity columns aren't guaranteed to be adjacent, since
// each section's header row is free to lay them out differently.
async function writeInventoryRow(token, title, rowNumber, writes) {
  const sheetTitle = title.replace(/'/g, "''");
  const data = writes.map(({ col, value }) => ({
    range: `'${sheetTitle}'!${columnName(col)}${rowNumber}`,
    majorDimension: "ROWS",
    values: [[value]],
  }));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (!res.ok) throw new Error(`Couldn't write the new inventory row: ${await res.text()}`);
}

async function inventorySheetTitle(token) {
  if (sheetTitleCache) return sheetTitleCache;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}` +
    "?fields=sheets.properties(sheetId,title)";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Couldn't read inventory sheet metadata: ${await res.text()}`);
  const data = await res.json();
  const sheet = (data.sheets || []).find((entry) => String(entry.properties.sheetId) === String(INVENTORY_SHEET_GID));
  if (!sheet) throw new Error("Inventory sheet tab not found: " + INVENTORY_SHEET_GID);
  sheetTitleCache = sheet.properties.title;
  return sheetTitleCache;
}

async function googleAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60000) {
    return accessTokenCache.token;
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("Google Sheets write access is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const privateKey = rawKey.replace(/\\n/g, "\n");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(privateKey).toString("base64url");

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Couldn't authorize Google Sheets write access: ${JSON.stringify(data)}`);

  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3000) * 1000,
  };
  return accessTokenCache.token;
}

function base64url(text) {
  return Buffer.from(text).toString("base64url");
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") {
      cur += ch;
    }
  }
  row.push(cur);
  rows.push(row);
  return rows;
}
