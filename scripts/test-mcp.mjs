import assert from "node:assert/strict";
import { authorizeMcpRequest } from "../mcp/auth.js";

process.env.MCP_AUTH_TOKEN = "test-mcp-secret";
assert.equal(authorizeMcpRequest({ headers: { authorization: "Bearer test-mcp-secret" } }).ok, true);
assert.equal(authorizeMcpRequest({ headers: { authorization: "Bearer wrong" } }).error, "unauthorized");
assert.equal(authorizeMcpRequest({ headers: {} }).status, 401);
delete process.env.MCP_AUTH_TOKEN;
assert.equal(authorizeMcpRequest({ headers: {} }).status, 401);
console.log("MCP auth tests passed");
