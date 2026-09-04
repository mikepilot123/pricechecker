// Module resolve hook: swap the Neon driver for the PGlite stand-in, so the
// code under test is the shipping code, unmodified.
const STANDIN = new URL("./neon-pglite.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@neondatabase/serverless") return nextResolve(STANDIN, context);
  return nextResolve(specifier, context);
}
