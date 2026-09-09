import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
const { db } = await import("./testing/neon-pglite.mjs");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
const { ensureSchema } = await import("../lib/db.js");
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addBankTransaction, updateBankTransaction, deleteBankTransaction, listBankTransactions, bankAccountSummary } = await import("../lib/bank-transactions.js");

const deposit = await addBankTransaction({ kind: "deposit", amount: 1500, occurredAt: new Date().toISOString(), category: "Opening balance", reference: "OPEN" });
const withdrawal = await addBankTransaction({ kind: "withdrawal", amount: 225.5, occurredAt: new Date().toISOString(), category: "Inventory" });
assert.equal((await bankAccountSummary()).balance, 1274.5);
assert.equal((await listBankTransactions()).length, 2);

const edited = await updateBankTransaction({ id: withdrawal.id, amount: 200, notes: "Corrected" });
assert.equal(edited.notes, "Corrected");
assert.equal((await bankAccountSummary()).balance, 1300);

await assert.rejects(addBankTransaction({ kind: "transfer", amount: 10 }), /deposit or withdrawal/);
await assert.rejects(addBankTransaction({ kind: "deposit", amount: 0 }), /greater than zero/);
await deleteBankTransaction({ id: deposit.id });
assert.equal((await bankAccountSummary()).balance, -200);
assert.equal((await listBankTransactions()).length, 1);

console.log("PASS — bank transaction ledger scenarios");
await db.close();
