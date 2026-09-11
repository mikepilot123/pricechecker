import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

export function createMcpServer({ actor = "mcp-connector" } = {}) {
  const server = new McpServer({
    name: "repair-hub",
    version: "1.0.0",
    instructions: "Repair Hub shop tools for inventory, supplier orders, repair tickets, catalog prices, and customers. Prefer specific tools. Never request raw SQL. Phone numbers are masked. Do not invent stock or prices; call a tool.",
  });
  registerTools(server, { actor });
  return server;
}
