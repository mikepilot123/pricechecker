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
  { name: "Pixel 6", entries: { "Screen replacement": "1050" } },
  { name: "Pixel 5 A", entries: { "Screen replacement": "1050" } },
  { name: "Pixel 4a", entries: { "Screen replacement": "850", Battery: "500" } },
  { name: "Pixel 3A", entries: { "Screen replacement": "675" } },
  { name: "Pixel 3", entries: { "Screen replacement": "750", Battery: "500" } },
];
