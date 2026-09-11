import { handleMcpHttp } from "../mcp/http.js";

export default async function handler(req, res) {
  try {
    await handleMcpHttp(req, res);
  } catch (error) {
    console.error("MCP error:", error && error.message ? error.message : error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "database_error", message: "Internal server error" });
    }
  }
}
