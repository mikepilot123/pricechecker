// A drop-in stand-in for @neondatabase/serverless, backed by PGlite (Postgres
// compiled to WASM). scripts/testing/hooks.mjs aliases the real package to this
// one, so tests exercise lib/*.js EXACTLY as deployed — same ensureSchema, same
// queries, same array/numeric serialization — against a real Postgres engine,
// with no database to provision and nothing stubbed out.
import { PGlite } from "@electric-sql/pglite";

export const db = await PGlite.create();

// Mirrors the driver's prepareValue(): arrays become a Postgres array literal.
function prepare(value) {
  if (Array.isArray(value)) return "{" + value.map((v) => '"' + String(v).replace(/"/g, '\\"') + '"').join(",") + "}";
  if (value instanceof Date) return value.toISOString();
  return value;
}

function build(strings, params) {
  const text = strings.reduce((acc, part, i) => acc + part + (i < params.length ? "$" + (i + 1) : ""), "");
  return { text, params: params.map(prepare) };
}

// Lazy thenable, like NeonQueryPromise: it carries its text/params so
// sql.transaction() can collect queries without executing them, and only runs
// when awaited.
function query(strings, ...params) {
  const q = build(strings, params);
  return {
    ...q,
    then: (resolve, reject) => db.query(q.text, q.params).then((r) => r.rows).then(resolve, reject),
  };
}

query.transaction = async function transaction(queries) {
  await db.query("BEGIN");
  try {
    const results = [];
    for (const q of queries) results.push((await db.query(q.text, q.params)).rows);
    await db.query("COMMIT");
    return results;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
};

export function neon() {
  return query;
}
