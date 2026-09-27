/* ============================================================
   Repair type inference from the live repair-price catalog.

   Classic-script friendly on purpose: the browser reads the helper from
   window.RPC_REPAIR_TYPE_INFERENCE, while Node tests can import this file and
   read the same API from globalThis.
   ============================================================ */
(function (root) {
  "use strict";

  const REPAIR_TYPE_RULES = [
    { issue: "Battery Issue", pattern: /battery/i },
    { issue: "Charging Port", pattern: /charg(?:e|ing)\s*port|charging\s*connector|usb[-\s]?c\s*port/i },
    { issue: "Screen Cracked / Broken", pattern: /screen|lcd|display|front\s*glass/i },
    { issue: "Water Damage", pattern: /water|liquid/i },
    { issue: "Speaker / Mic Issue", pattern: /speaker|microphone|\bmic\b|earpiece|ear\s*speaker/i },
    { issue: "Back Glass Cracked", pattern: /back\s*glass|rear\s*glass/i },
    { issue: "Camera Issue", pattern: /camera/i },
    { issue: "Software Issue", pattern: /software|firmware|\bos\b/i },
  ];

  function normalizeModelName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\b(?:google|apple|samsung|motorola|oneplus|xiaomi)\b/g, " ")
      .replace(/[^a-z0-9]+/g, "");
  }

  function priceNumber(value) {
    if (value == null || String(value).trim() === "") return null;
    const amount = Number(String(value).replace(/[^0-9.]/g, ""));
    return Number.isFinite(amount) ? amount : null;
  }

  function issueForRepairType(type) {
    const text = String(type || "").trim();
    if (!text) return "";
    const match = REPAIR_TYPE_RULES.find((rule) => rule.pattern.test(text));
    return match ? match.issue : "";
  }

  function findPriceModel(device, models) {
    const key = normalizeModelName(device);
    if (!key) return null;
    const list = Array.isArray(models) ? models : [];
    return list.find((model) => normalizeModelName(model && model.name) === key) || null;
  }

  function isDiagnosticOnly(issues) {
    const parts = String(issues || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length === 1 && /^diagnostic needed$/i.test(parts[0]);
  }

  function inferRepairType({ device, price, models, tolerance = 0.01 } = {}) {
    const amount = priceNumber(price);
    const model = findPriceModel(device, models);
    if (amount == null || !model) {
      return { status: "none", amount, model: model || null, candidates: [] };
    }

    const candidates = (Array.isArray(model.prices) ? model.prices : [])
      .map((entry) => {
        const type = String((entry && entry.type) || "").trim();
        const value = priceNumber(entry && entry.value);
        return {
          type,
          value,
          issue: issueForRepairType(type),
        };
      })
      .filter((entry) =>
        entry.type &&
        entry.issue &&
        entry.value != null &&
        Math.abs(entry.value - amount) <= tolerance
      );

    if (!candidates.length) {
      return { status: "none", amount, model, candidates: [] };
    }

    const distinctIssues = [...new Set(candidates.map((candidate) => candidate.issue))];
    if (distinctIssues.length === 1) {
      return {
        status: "unique",
        amount,
        model,
        candidate: candidates[0],
        candidates,
      };
    }

    return {
      status: "ambiguous",
      amount,
      model,
      candidates,
    };
  }

  root.RPC_REPAIR_TYPE_INFERENCE = {
    normalizeModelName,
    priceNumber,
    issueForRepairType,
    findPriceModel,
    isDiagnosticOnly,
    inferRepairType,
  };
})(typeof window !== "undefined" ? window : globalThis);
