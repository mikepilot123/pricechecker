import { createServer } from "node:http";
import { handleMcpHttp, isMcpPath } from "./http.js";

const port = Number(process.env.MCP_PORT || process.env.PORT || 8787);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Repair Hub MCP server");
    return;
  }

  if (url.pathname.startsWith("/.well-known/")) {
    res.writeHead(404).end("Not Found");
    return;
  }

  if (isMcpPath(url.pathname) && ["GET", "POST", "DELETE", "OPTIONS"].includes(req.method || "")) {
    try {
      await handleMcpHttp(req, res);
    } catch (error) {
      console.error("MCP error:", error && error.message ? error.message : error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "database_error", message: "Internal server error" }));
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Repair Hub MCP server listening on http://localhost:${port}/mcp`);
});
