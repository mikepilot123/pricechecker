/* ============================================================
   Repair -> invoice line synchronization.

   Replaces only invoice repair lines belonging to one linked device and can
   adjust that ticket's contribution to Payment Made. Other device lines,
   delivery/accessory charges, notes, and invoice metadata are left alone.
   ============================================================ */
(function (root) {
  "use strict";

  function tokens(value) {
    return String(value || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  }

  function deviceKey(value) {
    return tokens(value).join(" ");
  }

  function startsWithDevice(description, device) {
    const desc = tokens(description);
    const dev = tokens(device);
    if (!dev.length || desc.length < dev.length) return false;
    return dev.every((part, index) => desc[index] === part);
  }

  function bestDeviceMatch(description, devices) {
    const matches = [...new Set((devices || []).map((d) => String(d || "").trim()).filter(Boolean))]
      .filter((device) => startsWithDevice(description, device))
      .sort((a, b) => {
        const tokenDiff = tokens(b).length - tokens(a).length;
        return tokenDiff || b.length - a.length;
      });
    return matches[0] || "";
  }

  // Charges/accessories can also begin with the device model ("Pixel 6
  // Tempered Glass"). They belong on the invoice but are not the repair line.
  const NON_REPAIR_LINE = /\b(fee|fees|courier|delivery|shipping|transport|call[\s-]?out|travel|labou?r|deposit|tax|vat|discount|protector|tempered\s+glass|case|charger|adapter|cable|power\s*bank|earphones?|headphones?)\b/i;

  function isNonRepairLine(description) {
    return NON_REPAIR_LINE.test(String(description || ""));
  }

  function moneyNumber(value) {
    const amount = Number(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
  }

  // Adjust only the edited repair's contribution to an invoice payment.
  // This preserves payments belonging to other devices on a shared invoice.
  function paymentMadeAfterTicketEdit(invoicePaymentMade, beforeAmountPaid, afterAmountPaid) {
    const current = moneyNumber(invoicePaymentMade);
    const before = moneyNumber(beforeAmountPaid);
    const after = moneyNumber(afterAmountPaid);
    return Math.round((current - before + after) * 100) / 100;
  }

  function replaceRepairItems({
    items,
    targetDevices,
    knownDevices,
    replacementItems,
  } = {}) {
    const source = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
    const replacements = Array.isArray(replacementItems)
      ? replacementItems.map((item) => ({ ...item }))
      : [];
    const targetKeys = new Set((targetDevices || []).map(deviceKey).filter(Boolean));
    const devices = [...new Set([...(knownDevices || []), ...(targetDevices || [])]
      .map((d) => String(d || "").trim()).filter(Boolean))];

    if (!targetKeys.size || !replacements.length) {
      return { changed: false, items: source, matchedIndexes: [] };
    }

    const matchedIndexes = [];
    source.forEach((item, index) => {
      if (isNonRepairLine(item && item.description)) return;
      const match = bestDeviceMatch(item && item.description, devices);
      if (match && targetKeys.has(deviceKey(match))) matchedIndexes.push(index);
    });

    if (!matchedIndexes.length) {
      return { changed: false, items: source, matchedIndexes: [] };
    }

    // Keep the existing invoice detail/notes on the first replacement line.
    const preservedDetail = matchedIndexes
      .map((index) => String(source[index]?.detail || "").trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .join("\n");
    if (preservedDetail && !String(replacements[0]?.detail || "").trim()) {
      replacements[0].detail = preservedDetail;
    }

    const first = matchedIndexes[0];
    const matched = new Set(matchedIndexes);
    const next = [];
    source.forEach((item, index) => {
      if (index === first) next.push(...replacements);
      if (!matched.has(index)) next.push(item);
    });

    return { changed: true, items: next, matchedIndexes };
  }

  root.RPC_REPAIR_INVOICE_SYNC = {
    tokens,
    deviceKey,
    startsWithDevice,
    bestDeviceMatch,
    isNonRepairLine,
    paymentMadeAfterTicketEdit,
    replaceRepairItems,
  };
})(typeof window !== "undefined" ? window : globalThis);
