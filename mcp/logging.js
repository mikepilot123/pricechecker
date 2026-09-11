export function logMcp(event) {
  const line = {
    ts: new Date().toISOString(),
    source: "mcp",
    tool: event.tool || "",
    actor: event.actor || "mcp-connector",
    recordId: event.recordId || null,
    write: Boolean(event.write),
    ok: event.ok !== false,
    error: event.error || null,
  };
  console.log(JSON.stringify(line));
}
