import { readFileSync } from "node:fs";
import path from "node:path";
import { paths, projectRoot } from "@/lib/config/paths";
import { createLogger } from "@/lib/logger";

const log = createLogger("mcp:registry");

export interface McpServerDefinition {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The two servers shipped with this repository. They are plain TypeScript run
 * by the current Node binary — Node 24 strips the types itself, so there is no
 * build step between editing a tool and calling it.
 */
function bundledServers(): McpServerDefinition[] {
  const serverFile = (name: string) => path.join(paths.mcpServers, "src", `${name}.ts`);
  return [
    { id: "travel-weather", command: process.execPath, args: [serverFile("weather")] },
    { id: "travel-currency", command: process.execPath, args: [serverFile("currency")] },
  ];
}

interface McpConfigFile {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/**
 * Resolves the servers to connect to.
 *
 * An optional `mcp.config.json` in the repository root overrides the bundled
 * pair, using the same `mcpServers` shape that Claude Desktop and the other MCP
 * hosts use. That means any third-party MCP server can be dropped in without
 * touching application code.
 */
export function mcpServerDefinitions(): McpServerDefinition[] {
  const configPath = path.join(projectRoot, "mcp.config.json");

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return bundledServers();
  }

  try {
    const config = JSON.parse(raw) as McpConfigFile;
    const entries = Object.entries(config.mcpServers ?? {});
    if (entries.length === 0) {
      log.warn(`${configPath} declares no servers; falling back to the bundled pair.`);
      return bundledServers();
    }

    return entries.map(([id, server]) => ({
      id,
      command: server.command,
      args: server.args ?? [],
      env: server.env,
    }));
  } catch (error) {
    log.error(`Could not parse ${configPath}; falling back to the bundled pair.`, error);
    return bundledServers();
  }
}
