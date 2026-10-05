// Google Pixel repair prices, transcribed from the shop's Pixel price table.
//
// These live here rather than in the published Google Sheet because the Pixel
// tab was never wired into assets/app.js's TABS list, so nothing in it ever
// reached the app. Rather than add a fourth CSV tab, Pixel is the first brand
// to live entirely in the price catalog tables (see lib/prices.js) — the same
// store that now backs the in-app price editor.
//
// Seeded idempotently by ensureSchema() (lib/db.js) and by
// migrations/015_create_price_catalog.sql, both with ON CONFLICT DO NOTHING:
// once a price is edited in the app, or a model deleted, the seed never
// overwrites or resurrects it.
export const PIXEL_BRAND = "Pixel";

export const PIXEL_SEED = [
  { name: "Pixel 10 Pro XL", entries: { "Original Screen replacement": "1800" } },
  { name: "Pixel 9 pro xl", entries: { "Screen replacement": "1500" } },
  { name: "Pixel 9", entries: { "Screen replacement": "1300" } },
  { name: "Pixel 8", entries: { "Screen replacement": "1250", Battery: "700" } },
  { name: "Pixel 7 pro", entries: { "Screen replacement": "1100", Battery: "600" } },
  {
    name: "Pixel 7 A",
    entries: { "Original Screen replacement": "1700", "Screen replacement": "1100", Battery: "650" },
  },
  { name: "Pixel 7", entries: { "Screen replacement": "900", Battery: "600" } },
  { name: "Pixel 6 pro", entries: { "Screen replacement": "950", Battery: "600" } },
  { name: "Pixel 6 A", entries: { "Screen replacement": "1050" } },
  { name: "Pixel 6", entries: { "Screen replacement": "1050", Battery: "600" } },
  { name: "Pixel 5 A", entries: { "Screen replacement": "1050" } },
  { name: "Pixel 4a", entries: { "Screen replacement": "850", Battery: "500" } },
  { name: "Pixel 3A", entries: { "Screen replacement": "675" } },
  { name: "Pixel 3", entries: { "Screen replacement": "750", Battery: "500" } },
];

// Samsung Galaxy A-series screen prices (TTD), transcribed from the shop's
// A-series screen price list. Names follow the Samsung sheet tab's "Samsung
// A15" form so that, where the sheet already lists a model, these rows land on
// the same card (see priceModelKey in lib/prices.js) instead of a duplicate.
//
// The price list groups models that share a price ("A11 / A12 / A13"); each is
// its own model here so a search for any one of them finds it. "4G / 5G"
// pairs that share a part stay a single model; the A22 and A32, whose 4G and
// 5G versions are priced apart, are split.
//
// Repair types follow the Pixel seed: a bare price is "Screen replacement",
// and the list's quality grades become "OLED", "Incell" and "Original".
export const SAMSUNG_BRAND = "Samsung";

const SCREEN = "Screen replacement";
const OLED = "OLED Screen replacement";
const INCELL = "Incell Screen replacement";
const ORIGINAL = "Original Screen replacement";

export const SAMSUNG_A_SEED = [
  { name: "Samsung A01 Core", entries: { [SCREEN]: "350" } },
  { name: "Samsung A02", entries: { [SCREEN]: "350" } },
  { name: "Samsung A02s", entries: { [SCREEN]: "350" } },
  { name: "Samsung A03", entries: { [SCREEN]: "350" } },
  { name: "Samsung A03s", entries: { [SCREEN]: "350" } },
  { name: "Samsung A03 Core", entries: { [SCREEN]: "350" } },
  { name: "Samsung A04", entries: { [SCREEN]: "400" } },
  { name: "Samsung A04e", entries: { [SCREEN]: "400" } },
  { name: "Samsung A04s", entries: { [SCREEN]: "400" } },
  { name: "Samsung A05", entries: { [SCREEN]: "450" } },
  { name: "Samsung A05s", entries: { [SCREEN]: "450" } },
  { name: "Samsung A06", entries: { [SCREEN]: "450" } },
  { name: "Samsung A10s", entries: { [SCREEN]: "400" } },
  { name: "Samsung A11", entries: { [SCREEN]: "450" } },
  { name: "Samsung A12", entries: { [SCREEN]: "450" } },
  { name: "Samsung A13", entries: { [SCREEN]: "450" } },
  { name: "Samsung A14", entries: { [SCREEN]: "450" } },
  { name: "Samsung A15", entries: { [OLED]: "500", [ORIGINAL]: "650" } },
  { name: "Samsung A16", entries: { [SCREEN]: "750" } },
  { name: "Samsung A17", entries: { [INCELL]: "500", [ORIGINAL]: "800" } },
  { name: "Samsung A20", entries: { [SCREEN]: "450" } },
  { name: "Samsung A20s", entries: { [SCREEN]: "400" } },
  { name: "Samsung A21s", entries: { [SCREEN]: "450" } },
  { name: "Samsung A22 4G", entries: { [ORIGINAL]: "550" } },
  { name: "Samsung A22 5G", entries: { [SCREEN]: "450" } },
  { name: "Samsung A23", entries: { [SCREEN]: "500" } },
  { name: "Samsung A24", entries: { [ORIGINAL]: "800" } },
  { name: "Samsung A25", entries: { [ORIGINAL]: "800" } },
  { name: "Samsung A26", entries: { [ORIGINAL]: "800" } },
  { name: "Samsung A30", entries: { [OLED]: "450" } },
  { name: "Samsung A30s", entries: { [OLED]: "450" } },
  { name: "Samsung A31", entries: { [OLED]: "550", [ORIGINAL]: "800" } },
  { name: "Samsung A32 4G", entries: { [OLED]: "550", [ORIGINAL]: "850" } },
  { name: "Samsung A32 5G", entries: { [SCREEN]: "500" } },
  { name: "Samsung A33", entries: { [OLED]: "550" } },
  { name: "Samsung A34", entries: { [ORIGINAL]: "950" } },
  { name: "Samsung A35", entries: { [ORIGINAL]: "950" } },
  { name: "Samsung A36", entries: { [ORIGINAL]: "1000" } },
  { name: "Samsung A41", entries: { [ORIGINAL]: "750" } },
  { name: "Samsung A50", entries: { [OLED]: "450" } },
  { name: "Samsung A51", entries: { [OLED]: "500", [ORIGINAL]: "850" } },
  { name: "Samsung A52", entries: { [OLED]: "650", [ORIGINAL]: "950" } },
  { name: "Samsung A52s", entries: { [ORIGINAL]: "950" } },
  { name: "Samsung A53", entries: { [OLED]: "650", [ORIGINAL]: "950" } },
  { name: "Samsung A54", entries: { [ORIGINAL]: "950" } },
  { name: "Samsung A55", entries: { [ORIGINAL]: "1000" } },
  { name: "Samsung A56", entries: { [ORIGINAL]: "1050" } },
  { name: "Samsung A70", entries: { [ORIGINAL]: "1000" } },
  { name: "Samsung A71", entries: { [OLED]: "650", [ORIGINAL]: "1000" } },
  { name: "Samsung A71 5G", entries: { [ORIGINAL]: "950" } },
  { name: "Samsung A72", entries: { [ORIGINAL]: "900" } },
  { name: "Samsung A73 5G", entries: { [ORIGINAL]: "950" } },
];

// Every seeded line-up, applied in this order by ensureSchema(). sortBase
// keeps each brand's models together in the catalog's sort order.
export const PRICE_SEEDS = [
  { brand: PIXEL_BRAND, models: PIXEL_SEED, sortBase: 0 },
  { brand: SAMSUNG_BRAND, models: SAMSUNG_A_SEED, sortBase: 100 },
];
