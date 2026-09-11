import crypto from "node:crypto";

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function headerValue(req, name) {
  const headers = req.headers || {};
  const direct = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0] || "";
  return String(direct || "");
}

export function extractBearerToken(req) {
  const authorization = headerValue(req, "authorization");
  const match = /^Bearer\s+(\S+)/i.exec(authorization);
  if (match) return match[1];
  return String(headerValue(req, "x-mcp-auth") || "").trim();
}

export function mcpAuthConfigured() {
  return Boolean(String(process.env.MCP_AUTH_TOKEN || "").trim());
}

/**
 * Server-to-server gate for ChatGPT/MCP. Separate from the shop PIN so a
 * short numeric PIN is never the connector secret.
 */
export function authorizeMcpRequest(req) {
  const expected = String(process.env.MCP_AUTH_TOKEN || "").trim();
  if (!expected) {
    if (process.env.MCP_ALLOW_UNAUTHENTICATED === "1") {
      return { ok: true, actor: "unauthenticated-local" };
    }
    return { ok: false, status: 401, error: "unauthorized", message: "MCP_AUTH_TOKEN is not configured" };
  }
  const provided = extractBearerToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "unauthorized", message: "Invalid or missing MCP bearer token" };
  }
  return { ok: true, actor: "mcp-connector" };
}
