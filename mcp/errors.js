export function mapError(err) {
  const message = String((err && err.message) || err || "Unknown error");
  const lower = message.toLowerCase();
  if (lower.includes("not found")) return { error: "item_not_found", message };
  if (lower.includes("already exists") || lower.includes("duplicate")) return { error: "duplicate_item", message };
  if (lower.includes("required") || lower.includes("must be") || lower.includes("invalid") || lower.includes("unknown")) {
    return { error: "invalid_input", message };
  }
  if (lower.includes("can't") || lower.includes("cannot") || lower.includes("not allowed") || lower.includes("out of stock")) {
    return { error: "action_not_allowed", message };
  }
  return { error: "database_error", message: "The shop database could not complete that request" };
}

export function ok(data, text) {
  const payload = { ok: true, ...data };
  return {
    content: [{ type: "text", text: text || JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function fail(error, message) {
  const payload = { ok: false, error, message };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export async function runTool(name, fn) {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapError(err);
    return fail(mapped.error, mapped.message);
  }
}
