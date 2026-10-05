// Seeded price line-ups (lib/price-seed.js): ensureSchema() loads every model
// and price, the catalog API returns them, the mirroring migration matches the
// seed, and re-seeding never undoes an in-app edit or a deletion.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const { PRICE_SEEDS, SAMSUNG_A_SEED } = await import("../lib/price-seed.js");
const { listPriceModels, savePriceModels, deletePriceModel, priceModelKey } = await import("../lib/prices.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();

const pricesOf = (models, name) => {
  const model = models.find((m) => m.key === priceModelKey(name));
  return model && Object.fromEntries(model.entries.map((e) => [e.type, e.value]));
};

// ensureSchema alone (no later migrations) seeds every line-up in full.
let models = await listPriceModels();
for (const seed of PRICE_SEEDS) {
  for (const model of seed.models) {
    const row = models.find((m) => m.key === priceModelKey(model.name));
    assert.ok(row, model.name + " should be seeded");
    assert.equal(row.brand, seed.brand);
    assert.deepEqual(pricesOf(models, model.name), model.entries);
  }
}
assert.deepEqual(pricesOf(models, "Samsung A15"), { "OLED Screen replacement": "500", "Original Screen replacement": "650" });
assert.deepEqual(pricesOf(models, "Samsung A12"), { "Screen replacement": "450" });
assert.deepEqual(pricesOf(models, "Pixel 8"), { "Screen replacement": "1250", Battery: "700" });
// Each brand's models stay together, Pixel first, in list order.
const samsungOrder = models.filter((m) => m.brand === "Samsung").map((m) => m.name);
assert.deepEqual(samsungOrder, SAMSUNG_A_SEED.map((m) => m.name));

// The migration mirrors the seed exactly.
const migration = readFileSync(new URL("043_seed_samsung_a_series_prices.sql", migrations), "utf8");
for (const model of SAMSUNG_A_SEED) {
  const id = "PM:" + priceModelKey(model.name);
  for (const [type, value] of Object.entries(model.entries)) {
    assert.ok(migration.includes(`('${id}', '${type}', '${value}')`), `${model.name} ${type} missing from migration`);
  }
}
assert.equal((migration.match(/^  \('PM:/gm) || []).length, SAMSUNG_A_SEED.length + SAMSUNG_A_SEED.reduce((n, m) => n + Object.keys(m.entries).length, 0));

// An in-app edit and a deletion both survive re-running the seed migrations.
await savePriceModels({ models: [{ name: "Samsung A15", brand: "Samsung", entries: [{ type: "OLED Screen replacement", value: "525" }] }] });
await deletePriceModel({ name: "Samsung A02" });
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
models = await listPriceModels();
assert.equal(pricesOf(models, "Samsung A15")["OLED Screen replacement"], "525");
assert.equal(models.find((m) => m.key === "samsung a02").deleted, true);

console.log("price seed tests passed");
