# ChatGPT / MCP integration

Repair Hub exposes a narrow, authenticated Model Context Protocol (MCP) server at `/mcp` (and `/api/mcp` on Vercel). The MCP layer reuses the existing inventory, parts-order, ticket, customer, and pricing service modules; it does not expose SQL or bypass application rules.

## Architecture

ChatGPT → authenticated MCP endpoint → `mcp/tools.js` → existing `lib/` services → Neon/Postgres (or the configured local database).

The endpoint uses Streamable HTTP and bearer authentication. `MCP_AUTH_TOKEN` is separate from the shop PIN. CORS is enabled because ChatGPT-hosted connectors call the public endpoint; the bearer token remains mandatory in production.

## Available tools

Read-only tools: `search_inventory`, `get_inventory_item`, `get_incoming_parts`, `search_orders`, `get_order`, `get_recent_orders`, `get_unreceived_order_items`, `search_supplier_parts`, `get_supplier_cost`, `get_previous_purchase_cost`, `compare_supplier_prices`, `search_repairs`, `get_repair`, `get_previous_repair_quote`, `calculate_suggested_retail_price`, `calculate_margin`, `get_previous_price`, `get_average_price_for_part`, `search_customer`, `get_customer`, and `get_customer_repairs`.

Write tools: `add_inventory_item`, `update_inventory_item`, `mark_part_received`, `add_supplier_order`, `add_parts_order_to_inventory`, `create_repair_quote`, and `update_repair_status`. Destructive delete tools are intentionally not exposed.

All inputs use strict Zod schemas. Results are concise structured JSON. Errors are normalized to `invalid_input`, `unauthorized`, `item_not_found`, `duplicate_item`, `action_not_allowed`, or `database_error`. Write calls are logged without tokens, passwords, or customer secrets.

## Environment variables

Required for a deployed MCP endpoint:

```env
DATABASE_URL=           # Neon/Postgres connection string
MCP_AUTH_TOKEN=         # long random bearer secret
```

The existing `INTAKE_PIN` remains for the web app and is not used as the MCP secret. `MCP_PORT` optionally controls the standalone local server (default `8787`). Never enable `MCP_ALLOW_UNAUTHENTICATED` on a public deployment.

## Local development

Install dependencies and run the app or MCP server:

```bash
npm install
npm run dev       # web app at http://localhost:8123
npm run mcp       # MCP endpoint at http://localhost:8787/mcp
```

For a local MCP smoke test, set `MCP_AUTH_TOKEN=test-token` and send `Authorization: Bearer test-token`. The standalone server uses the configured database; use the app's existing PGlite development setup when testing without production data.

## Connecting ChatGPT

Deploy the Vercel project with `DATABASE_URL` and a high-entropy `MCP_AUTH_TOKEN`. Use the HTTPS URL ending in `/mcp` as the remote MCP server URL in ChatGPT's connector/app configuration and provide the same bearer token when prompted. Confirm that the deployment is HTTPS-only and that the token is stored as a secret, not in source control.

## Adding tools

Add a purpose-specific service call and a strict schema in `mcp/tools.js`. Reuse an existing `lib/` function, return only fields needed for the answer, wrap execution in `runTool`, and call `writeLog` for mutations. Add a focused test for authorization, validation, success, and missing-record behavior before exposing the tool.
