import assert from "node:assert/strict";

await import("../assets/repair-invoice-sync.js");
const sync = globalThis.RPC_REPAIR_INVOICE_SYNC;
assert.ok(sync);

const base = [
  { description: "Pixel 6 Diagnostic", detail: "Customer reports random shutdowns", qty: 1, rate: 150 },
  { description: "Delivery Fee", detail: "", qty: 1, rate: 50 },
  { description: "Tempered Glass", detail: "", qty: 1, rate: 80 },
];

const one = sync.replaceRepairItems({
  items: base,
  targetDevices: ["Pixel 6"],
  knownDevices: ["Pixel 6"],
  replacementItems: [{ description: "Pixel 6 Battery Replacement", detail: "", qty: 1, rate: 600 }],
});
assert.equal(one.changed, true);
assert.deepEqual(one.items, [
  { description: "Pixel 6 Battery Replacement", detail: "Customer reports random shutdowns", qty: 1, rate: 600 },
  base[1],
  base[2],
]);

const multi = sync.replaceRepairItems({
  items: [
    { description: "Pixel 6 Diagnostic", detail: "", qty: 1, rate: 150 },
    { description: "Pixel 6 Pro Screen Replacement", detail: "", qty: 1, rate: 950 },
    { description: "Delivery Fee", detail: "", qty: 1, rate: 50 },
  ],
  targetDevices: ["Pixel 6"],
  knownDevices: ["Pixel 6", "Pixel 6 Pro"],
  replacementItems: [{ description: "Pixel 6 Battery Replacement", detail: "", qty: 1, rate: 600 }],
});
assert.equal(multi.changed, true);
assert.equal(multi.items[0].description, "Pixel 6 Battery Replacement");
assert.equal(multi.items[1].description, "Pixel 6 Pro Screen Replacement");
assert.equal(multi.items[2].description, "Delivery Fee");

const deviceAccessory = sync.replaceRepairItems({
  items: [
    { description: "Pixel 6 Diagnostic", detail: "", qty: 1, rate: 150 },
    { description: "Pixel 6 Tempered Glass", detail: "", qty: 1, rate: 80 },
    { description: "Pixel 6 Delivery Fee", detail: "", qty: 1, rate: 50 },
  ],
  targetDevices: ["Pixel 6"],
  knownDevices: ["Pixel 6"],
  replacementItems: [{ description: "Pixel 6 Battery Replacement", detail: "", qty: 1, rate: 600 }],
});
assert.deepEqual(deviceAccessory.items, [
  { description: "Pixel 6 Battery Replacement", detail: "", qty: 1, rate: 600 },
  { description: "Pixel 6 Tempered Glass", detail: "", qty: 1, rate: 80 },
  { description: "Pixel 6 Delivery Fee", detail: "", qty: 1, rate: 50 },
]);

const collapse = sync.replaceRepairItems({
  items: [
    { description: "Pixel 6 Screen Replacement", detail: "Keep this note", qty: 1, rate: 1050 },
    { description: "Pixel 6 Battery Replacement", detail: "", qty: 1, rate: 600 },
    { description: "Courier", detail: "", qty: 1, rate: 60 },
  ],
  targetDevices: ["Pixel 6"],
  knownDevices: ["Pixel 6"],
  replacementItems: [{ description: "Pixel 6 Charging Port", detail: "", qty: 1, rate: 700 }],
});
assert.deepEqual(collapse.items, [
  { description: "Pixel 6 Charging Port", detail: "Keep this note", qty: 1, rate: 700 },
  { description: "Courier", detail: "", qty: 1, rate: 60 },
]);

const none = sync.replaceRepairItems({
  items: [{ description: "iPhone 13 Screen Replacement", detail: "", qty: 1, rate: 1200 }],
  targetDevices: ["Pixel 6"],
  knownDevices: ["Pixel 6", "iPhone 13"],
  replacementItems: [{ description: "Pixel 6 Battery Replacement", detail: "", qty: 1, rate: 600 }],
});
assert.equal(none.changed, false);
assert.equal(none.items[0].description, "iPhone 13 Screen Replacement");

// Regression: a TT$600 invoice starts unpaid, then Check In records a payment.
// The invoice must mirror Payment Made so its derived Balance Due is correct.
const fullPayment = sync.linkedTicketPaymentTotal([{ id: "A", amountPaid: 600 }]);
assert.equal(fullPayment, 600);
assert.equal(600 - fullPayment, 0);

// Partial payment: TT$200 paid against the same TT$600 repair leaves TT$400.
const partialPayment = sync.linkedTicketPaymentTotal([{ id: "A", amountPaid: 200 }]);
assert.equal(partialPayment, 200);
assert.equal(600 - partialPayment, 400);

// Shared invoice: rebuild from both repair cards instead of trusting a stale
// invoice total. TT$250 + TT$200 = TT$450.
const sharedPayment = sync.linkedTicketPaymentTotal([
  { id: "A", amountPaid: 250 },
  { id: "B", amountPaid: 200 },
]);
assert.equal(sharedPayment, 450);

console.log("repair invoice sync tests passed");
