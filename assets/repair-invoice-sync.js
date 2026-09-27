/* ============================================================
   Repair -> invoice line synchronization.

   Replaces only invoice repair lines belonging to one linked device. Other
   device lines, delivery/accessory charges, notes, payments, and invoice
   metadata are left alone.
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

  const NON_REPAIR_LINE_PATTERN = /\b(fee|fees|courier|delivery|shipping|transport|call[\s-]?out|travel|labou?r|deposit|tax|vat|discount|protector|tempered\s+glass|charger|adapter|cable|power\s*bank|earphones?|headphones?|accessor(?:y|ies)|case)\b/i;

  function bestDeviceMatch(description, devices) {
    const matches = [...new Set((devices || []).map((d) => String(d || "").trim()).filter(Boolean))]
      .filter((device) => startsWithDevice(description, device))
      .sort((a, b) => {
        const tokenDiff = tokens(b).length - tokens(a).length;
        return tokenDiff || b.length - a.length;
      });
    return matches[0] || "";
  }

  function isProtectedNonRepairLine(description) {
    return NON_REPAIR_LINE_PATTERN.test(String(description || ""));
  }

  // Charges/accessories can also begin with the device model ("Pixel 6
  // Tempered Glass"). They belong on the invoice but are not the repair line.
  const NON_REPAIR_LINE = /\b(fee|fees|courier|delivery|shipping|transport|call[\s-]?out|travel|labou?r|deposit|tax|vat|discount|protector|tempered\s+glass|case|charger|adapter|cable|power\s*bank|earphones?|headphones?)\b/i;

  function isNonRepairLine(description) {
    return NON_REPAIR_LINE.test(String(description || ""));
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
      const description = item && item.description;
      const match = bestDeviceMatch(description, devices);
      if (match && targetKeys.has(deviceKey(match)) && !isProtectedNonRepairLine(description)) matchedIndexes.push(index);
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
    replaceRepairItems,
  };
})(typeof window !== "undefined" ? window : globalThis);
