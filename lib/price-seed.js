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

// Every MacBook Apple has made, so any of them can be picked on Check In,
// Appointments and the Prices tab. Named "<line> <size> <chip> <year>
// (<model number>)", newest first: the model number (A-number) is what's
// printed on the bottom case, so staff can match the machine in hand. One
// A-number often covers several years or chips; where Apple used several
// numbers for one design, they're all listed.
//
// No prices yet — they're added from Settings → Repair prices, and a model
// with no prices shows "Call to confirm" on Prices until then.
//
// The three October 2026 models have no model number here: it wasn't
// confirmed when they were added. Rename them in Settings once known.
export const MACBOOK_BRAND = "MacBook";

const MACBOOKS = [
  // MacBook Pro
  "MacBook Pro 14-inch PROLED XDR M5 Pro/M5 Max 2026",
  "MacBook Pro 16-inch PROLED XDR M5 Pro/M5 Max 2026",
  "MacBook Pro 14-inch M6 2026",
  "MacBook Pro 14-inch M5 Pro 2026 (A3426)",
  "MacBook Pro 14-inch M5 Max 2026 (A3427)",
  "MacBook Pro 16-inch M5 Pro 2026 (A3428)",
  "MacBook Pro 16-inch M5 Max 2026 (A3429)",
  "MacBook Pro 14-inch M5 2025 (A3434)",
  "MacBook Pro 14-inch M4 2024 (A3112)",
  "MacBook Pro 14-inch M4 Pro 2024 (A3401)",
  "MacBook Pro 14-inch M4 Max 2024 (A3185)",
  "MacBook Pro 16-inch M4 Pro 2024 (A3403)",
  "MacBook Pro 16-inch M4 Max 2024 (A3186)",
  "MacBook Pro 14-inch M3 2023 (A2918)",
  "MacBook Pro 14-inch M3 Pro/M3 Max 2023 (A2992)",
  "MacBook Pro 16-inch M3 Pro/M3 Max 2023 (A2991)",
  "MacBook Pro 14-inch M2 Pro/M2 Max 2023 (A2779)",
  "MacBook Pro 16-inch M2 Pro/M2 Max 2023 (A2780)",
  "MacBook Pro 14-inch M1 Pro/M1 Max 2021 (A2442)",
  "MacBook Pro 16-inch M1 Pro/M1 Max 2021 (A2485)",
  "MacBook Pro 13-inch M1 2020 / M2 2022 (A2338)",
  "MacBook Pro 13-inch Intel 2020 four Thunderbolt ports (A2251)",
  "MacBook Pro 13-inch Intel 2020 two Thunderbolt ports (A2289)",
  "MacBook Pro 16-inch Intel 2019 (A2141)",
  "MacBook Pro 13-inch 2019 two Thunderbolt ports (A2159)",
  "MacBook Pro 13-inch 2018-2019 four Thunderbolt ports (A1989)",
  "MacBook Pro 15-inch 2018-2019 (A1990)",
  "MacBook Pro 13-inch 2016-2017 Touch Bar (A1706)",
  "MacBook Pro 13-inch 2016-2017 two Thunderbolt ports (A1708)",
  "MacBook Pro 15-inch 2016-2017 Touch Bar (A1707)",
  "MacBook Pro 13-inch Retina Late 2013-2015 (A1502)",
  "MacBook Pro 13-inch Retina Late 2012-Early 2013 (A1425)",
  "MacBook Pro 15-inch Retina 2012-2015 (A1398)",
  "MacBook Pro 13-inch 2009-2012 (A1278)",
  "MacBook Pro 15-inch unibody 2008-2012 (A1286)",
  "MacBook Pro 17-inch unibody 2009-2011 (A1297)",
  "MacBook Pro 15-inch 2006-2008 (A1150/A1211/A1226/A1260)",
  "MacBook Pro 17-inch 2006-2008 (A1151/A1212/A1229/A1261)",
  // MacBook Air
  "MacBook Air 13-inch M5 2026 (A3449)",
  "MacBook Air 15-inch M5 2026 (A3448)",
  "MacBook Air 13-inch M4 2025 (A3240)",
  "MacBook Air 15-inch M4 2025 (A3241)",
  "MacBook Air 13-inch M3 2024 (A3113)",
  "MacBook Air 15-inch M3 2024 (A3114)",
  "MacBook Air 15-inch M2 2023 (A2941)",
  "MacBook Air 13-inch M2 2022 (A2681)",
  "MacBook Air 13-inch M1 2020 (A2337)",
  "MacBook Air 13-inch Retina Intel 2020 (A2179)",
  "MacBook Air 13-inch Retina 2018-2019 (A1932)",
  "MacBook Air 13-inch 2012-2017 (A1466)",
  "MacBook Air 11-inch 2012-2015 (A1465)",
  "MacBook Air 13-inch 2010-2011 (A1369)",
  "MacBook Air 11-inch 2010-2011 (A1370)",
  "MacBook Air 13-inch 2008-2009 (A1237/A1304)",
  // MacBook
  "MacBook 12-inch Retina 2015-2017 (A1534)",
  "MacBook 13-inch white unibody 2009-2010 (A1342)",
  "MacBook 13-inch aluminium Late 2008 (A1278)",
  "MacBook 13-inch white/black 2006-2009 (A1181)",
];

export const MACBOOK_SEED = MACBOOKS.map((name) => ({ name, entries: {} }));

// Every seeded line-up, applied in this order by ensureSchema(). sortBase
// keeps each brand's models together in the catalog's sort order.
export const PRICE_SEEDS = [
  { brand: PIXEL_BRAND, models: PIXEL_SEED, sortBase: 0 },
  { brand: SAMSUNG_BRAND, models: SAMSUNG_A_SEED, sortBase: 100 },
  { brand: MACBOOK_BRAND, models: MACBOOK_SEED, sortBase: 200 },
];
