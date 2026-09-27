import assert from "node:assert/strict";

await import("../assets/repair-type-inference.js");

const helper = globalThis.RPC_REPAIR_TYPE_INFERENCE;
assert.ok(helper, "repair-type inference helper should be exposed");

const models = [
  {
    name: "Pixel 6",
    brand: "Pixel",
    prices: [
      { type: "Screen replacement", value: "1050" },
      { type: "Battery", value: "600" },
      { type: "Charging Port", value: "700" },
    ],
  },
  {
    name: "Pixel 6 Pro",
    brand: "Pixel",
    prices: [
      { type: "Battery", value: "650" },
      { type: "Charging Port", value: "800" },
    ],
  },
];

const battery = helper.inferRepairType({
  device: "Google Pixel 6",
  price: "600",
  models,
});
assert.equal(battery.status, "unique");
assert.equal(battery.model.name, "Pixel 6");
assert.equal(battery.candidate.issue, "Battery Issue");
assert.equal(battery.candidate.type, "Battery");

const diagnostic = helper.inferRepairType({
  device: "Google Pixel 6",
  price: "150",
  models,
});
assert.equal(diagnostic.status, "none");

const pro = helper.inferRepairType({
  device: "Google Pixel 6 Pro",
  price: "650",
  models,
});
assert.equal(pro.status, "unique");
assert.equal(pro.model.name, "Pixel 6 Pro");
assert.equal(pro.candidate.issue, "Battery Issue");

const ambiguous = helper.inferRepairType({
  device: "Pixel 6",
  price: "600",
  models: [{
    name: "Pixel 6",
    prices: [
      { type: "Battery", value: "600" },
      { type: "Charging Port", value: "600" },
    ],
  }],
});
assert.equal(ambiguous.status, "ambiguous");
assert.deepEqual(
  [...new Set(ambiguous.candidates.map((candidate) => candidate.issue))].sort(),
  ["Battery Issue", "Charging Port"].sort()
);

const sameIssueVariants = helper.inferRepairType({
  device: "Pixel 6",
  price: 600,
  models: [{
    name: "Pixel 6",
    prices: [
      { type: "Battery", value: "600" },
      { type: "OEM Battery", value: "600" },
    ],
  }],
});
assert.equal(sameIssueVariants.status, "unique");
assert.equal(sameIssueVariants.candidate.issue, "Battery Issue");

assert.equal(helper.isDiagnosticOnly("Diagnostic Needed"), true);
assert.equal(helper.isDiagnosticOnly("Diagnostic Needed, Battery Issue"), false);

console.log("repair-type inference tests passed");
