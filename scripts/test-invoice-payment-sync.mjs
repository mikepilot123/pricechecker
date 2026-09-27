import assert from "node:assert/strict";
import { paymentNumber, sumTicketAmountPaid } from "../lib/invoice-payment-sync.js";

// The real bug: the invoice may already be stale. Reconciliation must derive
// Payment Made from the repairs themselves, not from the stale invoice value.
assert.equal(sumTicketAmountPaid([{ id: "A", amountPaid: "600" }]), 600);
assert.equal(600 - sumTicketAmountPaid([{ id: "A", amountPaid: "600" }]), 0);

assert.equal(sumTicketAmountPaid([{ id: "A", amountPaid: "200" }]), 200);
assert.equal(600 - sumTicketAmountPaid([{ id: "A", amountPaid: "200" }]), 400);

// Shared invoice: preserve the other device's payment by summing every linked
// repair from source-of-truth ticket records.
assert.equal(sumTicketAmountPaid([
  { id: "A", amountPaid: "250" },
  { id: "B", amountPaid: "200" },
]), 450);

// Empty/unset amounts count as zero.
assert.equal(paymentNumber(""), 0);
assert.equal(sumTicketAmountPaid([{ amountPaid: "" }, { amountPaid: null }]), 0);

console.log("invoice payment reconciliation tests passed");
