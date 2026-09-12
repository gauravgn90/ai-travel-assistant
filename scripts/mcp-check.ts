/**
 * Connects to every configured MCP server, lists its tools and calls each one
 * with a representative argument set.
 *
 * Neither upstream needs an API key, so this verifies the whole MCP half of the
 * application — transport, tool discovery, argument marshalling, error
 * handling — without spending any LLM quota.
 *
 * Usage: npm run mcp:check
 */
import { getMcpRegistry } from "../src/lib/mcp/client.ts";
import type { ToolInvocation } from "../src/lib/types.ts";

/** Representative calls, including one that must fail, to prove failures degrade cleanly. */
const PROBES: Array<{ tool: string; args: Record<string, unknown>; expect?: "error" }> = [
  { tool: "get_current_weather", args: { location: "Singapore" } },
  { tool: "get_weather_forecast", args: { location: "Singapore", days: 3 } },
  { tool: "convert_currency", args: { amount: 60000, from: "INR", to: "SGD" } },
  { tool: "convert_currency", args: { amount: 200, from: "SGD", to: "INR" } },
  { tool: "list_supported_currencies", args: {} },
  { tool: "convert_currency", args: { amount: 10, from: "INR", to: "ZZZ" }, expect: "error" },
];

function report(invocation: ToolInvocation, expectedError: boolean): boolean {
  const failed = invocation.status === "error";
  const passed = failed === expectedError;
  const label = passed ? "PASS" : "FAIL";
  const note = expectedError ? " (expected to fail)" : "";

  console.log(
    `${label}  ${invocation.name.padEnd(26)} ${String(invocation.durationMs).padStart(5)}ms${note}`,
  );
  console.log(`      ${invocation.result.replace(/\n/g, "\n      ").slice(0, 600)}\n`);

  return passed;
}

const registry = await getMcpRegistry();
const status = registry.status();

console.log("MCP servers");
for (const server of status) {
  console.log(
    `  ${server.connected ? "up  " : "down"}  ${server.serverId.padEnd(18)} ` +
      `${server.toolCount} tools${server.error ? `  (${server.error})` : ""}`,
  );
}

const tools = registry.listToolDefinitions();
console.log(`\nAdvertised tools (${tools.length})`);
for (const tool of tools) {
  console.log(`  ${tool.function.name.padEnd(26)} ${tool.function.description?.slice(0, 88) ?? ""}`);
}

console.log("\nProbes");
let failures = 0;
for (const [index, probe] of PROBES.entries()) {
  const invocation = await registry.call(`probe-${index}`, probe.tool, probe.args);
  if (!report(invocation, probe.expect === "error")) failures += 1;
}

await registry.close();

if (failures > 0) {
  console.error(`${failures}/${PROBES.length} probes failed.`);
  process.exit(1);
}

console.log(`All ${PROBES.length} probes behaved as expected.`);
process.exit(0);
