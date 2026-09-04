// Local development server: the whole app, running on this machine, against a
// throwaway Postgres.
//
//   npm run dev      ->  http://localhost:8123
//
// There was previously no way to run this project locally at all — the static
// site talks to a deployed Vercel function, so testing a change meant pushing
// it. This wires the same api/*.js handlers to PGlite (Postgres compiled to
// WASM, created fresh in memory on every boot) so there are no credentials to
// hold and nothing that can touch real shop data.
//
// Two small pieces of glue:
//   * @neondatabase/serverless is aliased to the PGlite stand-in, exactly as
//     scripts/test-card-payments.mjs does it, so the handlers are unmodified.
//   * assets/*.js is served with the hardcoded production origin stripped, so
//     every /api/* call the page makes hits this server instead of production.
//     Nothing on disk changes.
import { createServer } from "node:http";
import { register, registerHooks } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
    },
  });
} else {
  register("./testing/hooks.mjs", import.meta.url);
}

const PORT = Number(process.env.PORT || 8123);
const PIN = process.env.INTAKE_PIN || "0000";
process.env.INTAKE_PIN = PIN;
process.env.DATABASE_URL ||= "pglite://memory";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every module hardcodes this origin (intake, prices, inventory, leads, …).
// Stripping the origin turns them all into same-origin calls to this server.
const PRODUCTION_ORIGIN = "https://pricechecker-cyan.vercel.app";

const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");

// Same ordering as the test suite: migrations/ isn't self-contained, so 001
// runs, then ensureSchema() creates the tables only it knows about, then the
// remaining (idempotent) migrations top everything up.
const migrationsDir = path.join(root, "migrations");
const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
await db.exec(await readFile(path.join(migrationsDir, migrations[0]), "utf8"));
await ensureSchema();
for (const file of migrations.slice(1)) {
  await db.exec(await readFile(path.join(migrationsDir, file), "utf8"));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/** Minimal stand-in for the Vercel response object the handlers expect. */
function vercelResponse(res) {
  const shim = {
    statusCode: 200,
    setHeader: (k, v) => { res.setHeader(k, v); return shim; },
    status(code) { shim.statusCode = code; return shim; },
    json(body) {
      res.writeHead(shim.statusCode, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return shim;
    },
    send(body) {
      res.writeHead(shim.statusCode);
      res.end(body);
      return shim;
    },
    end(body) { res.writeHead(shim.statusCode); res.end(body); return shim; },
  };
  return shim;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const handlers = new Map();
async function apiHandler(name) {
  if (!handlers.has(name)) {
    const mod = await import(path.join(root, "api", name + ".js"));
    handlers.set(name, mod.default);
  }
  return handlers.get(name);
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/\/$/, "");
      let handler;
      try {
        handler = await apiHandler(name);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "No such API route: " + name }));
      }
      req.query = Object.fromEntries(url.searchParams);
      req.body = req.method === "GET" ? undefined : await readBody(req);
      return handler(req, vercelResponse(res));
    }

    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    let body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    if (ext === ".js") {
      // Point the app at this server rather than production.
      body = Buffer.from(body.toString("utf8").split(PRODUCTION_ORIGIN).join(""));
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err && err.stack ? err.stack : err));
  }
}).listen(PORT, () => {
  console.log(`Dev server on http://localhost:${PORT}  (team PIN: ${PIN}, fresh in-memory database)`);
});
