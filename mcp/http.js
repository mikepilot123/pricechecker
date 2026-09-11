import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authorizeMcpRequest } from "./auth.js";
import { createMcpServer } from "./create-server.js";

const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);

export function applyMcpCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-mcp-auth, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

export function isMcpPath(pathname) {
  return MCP_PATHS.has(pathname.replace(/\/$/, "") || "/");
}

export async function handleMcpHttp(req, res) {
  applyMcpCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const auth = authorizeMcpRequest(req);
  if (!auth.ok) {
    res.statusCode = auth.status;
    res.setHeader("WWW-Authenticate", "Bearer");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: auth.error, message: auth.message }));
    return;
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) body = undefined;
    else {
      try {
        body = JSON.parse(trimmed);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "invalid_input", message: "Request body must be JSON" }));
        return;
      }
    }
  }

  const server = createMcpServer({ actor: auth.actor });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
