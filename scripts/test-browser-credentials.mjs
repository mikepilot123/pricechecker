import assert from "node:assert/strict";

process.env.INTAKE_PIN = "2468";
process.env.BROWSER_CREDENTIAL_SECRET = "test-only-high-entropy-browser-credential-secret";
const { checkPin, createBrowserCredential } = await import("../lib/security.js");

const requestFrom = (ip) => ({ headers: { "x-forwarded-for": ip }, socket: {} });
const credential = createBrowserCredential("2468");

assert.match(credential, /^rpcb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.equal(checkPin(requestFrom("192.0.2.1"), credential), null);
assert.equal(
  checkPin(requestFrom("198.51.100.2"), credential),
  null,
  "credential must not be tied to an IP/Wi-Fi network",
);
assert.equal(checkPin(requestFrom("192.0.2.1"), "2468"), null, "raw PIN must still bootstrap registration");
assert.equal(checkPin(requestFrom("192.0.2.1"), credential + "tampered")?.error, "Invalid PIN");
assert.equal(createBrowserCredential("wrong"), null);

process.env.INTAKE_PIN = "1357";
assert.equal(
  checkPin(requestFrom("192.0.2.1"), credential)?.error,
  "Invalid PIN",
  "rotating the team PIN must revoke old browser credentials",
);

console.log("Browser credential tests passed");
