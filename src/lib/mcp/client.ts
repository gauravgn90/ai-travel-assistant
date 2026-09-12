import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import { getEnv } from "@/lib/config/env";
import { projectRoot } from "@/lib/config/paths";
import { createLogger } from "@/lib/logger";
import { mcpServerDefinitions, type McpServerDefinition } from "@/lib/mcp/registry";
import type { ToolInvocation } from "@/lib/types";

const log = createLogger("mcp:client");

const CLIENT_INFO = { name: "ai-travel-assistant", version: "1.0.0" } as const;

interface RemoteTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  serverId: string;
  /** Name as the server knows it, before any collision prefix. */
  remoteName: string;
}

interface Connection {
  definition: McpServerDefinition;
  client: Client;
  tools: RemoteTool[];
}

interface McpCallResultContent {
  type: string;
  text?: string;
}

interface McpCallResult {
  content?: McpCallResultContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpSessionStatus {
  serverId: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Owns the stdio connections to the MCP servers and adapts their tools into the
 * shape `BaseChatModel.bindTools` accepts.
 *
 * Connections are made once per process and reused, because spawning a server
 * per request would add hundreds of milliseconds to every turn. A server that
 * fails to start is recorded and skipped rather than failing the request — the
 * assistant is still useful with one tool family missing, and the prompt tells
 * the model to say what it could not check.
 */
export class McpToolRegistry {
  private connections = new Map<string, Connection>();
  private failures = new Map<string, string>();
  private ready: Promise<void> | null = null;

  async init(): Promise<void> {
    this.ready ??= this.connectAll();
    return this.ready;
  }

  private async connectAll(): Promise<void> {
    const definitions = mcpServerDefinitions();

    await Promise.all(
      definitions.map(async (definition) => {
        try {
          const connection = await this.connect(definition);
          this.connections.set(definition.id, connection);
          this.failures.delete(definition.id);
          log.info(
            `Connected to ${definition.id} (${connection.tools.length} tools: ` +
              `${connection.tools.map((tool) => tool.remoteName).join(", ")})`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.failures.set(definition.id, message);
          log.error(`Could not start MCP server "${definition.id}": ${message}`);
        }
      }),
    );
  }

  private async connect(definition: McpServerDefinition): Promise<Connection> {
    const transport = new StdioClientTransport({
      command: definition.command,
      args: definition.args,
      cwd: projectRoot,
      env: { ...inheritedEnv(), ...definition.env },
      stderr: "pipe",
    });

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    await client.connect(transport);

    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.debug(`[${definition.id}] ${text}`);
    });

    const { tools } = await client.listTools();
    const remoteTools: RemoteTool[] = tools.map((tool) => ({
      name: tool.name,
      remoteName: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
      serverId: definition.id,
    }));

    return { definition, client, tools: remoteTools };
  }

  /**
   * Tool definitions for the model. Two servers may legitimately advertise the
   * same tool name, so a collision is disambiguated by prefixing the server id;
   * the mapping back to the remote name is kept on the RemoteTool.
   */
  listToolDefinitions(): ToolDefinition[] {
    const seen = new Map<string, number>();
    const definitions: ToolDefinition[] = [];

    for (const tool of this.allTools()) {
      const occurrences = (seen.get(tool.remoteName) ?? 0) + 1;
      seen.set(tool.remoteName, occurrences);

      tool.name =
        occurrences > 1 ? `${tool.serverId.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool.remoteName}` : tool.remoteName;

      definitions.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }

    return definitions;
  }

  status(): McpSessionStatus[] {
    const statuses: McpSessionStatus[] = [];

    for (const [serverId, connection] of this.connections) {
      statuses.push({ serverId, connected: true, toolCount: connection.tools.length });
    }
    for (const [serverId, error] of this.failures) {
      statuses.push({ serverId, connected: false, toolCount: 0, error });
    }

    return statuses.sort((a, b) => a.serverId.localeCompare(b.serverId));
  }

  hasTools(): boolean {
    return this.allTools().length > 0;
  }

  /**
   * Invokes a tool and always resolves. A thrown upstream error, a protocol
   * error or a timeout all come back as a failed ToolInvocation, which the
   * agent hands to the model as a tool result so it can explain the gap instead
   * of inventing a number.
   */
  async call(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolInvocation> {
    const started = performance.now();
    const tool = this.allTools().find((candidate) => candidate.name === name);

    if (!tool) {
      const available = this.allTools().map((candidate) => candidate.name).join(", ") || "none";
      return {
        id,
        name,
        server: "unknown",
        args,
        status: "error",
        result: `No MCP tool named "${name}" is connected. Available tools: ${available}.`,
        durationMs: 0,
        error: "unknown_tool",
      };
    }

    const connection = this.connections.get(tool.serverId);
    if (!connection) {
      return {
        id,
        name,
        server: tool.serverId,
        args,
        status: "error",
        result: `The "${tool.serverId}" MCP server is not connected, so this information is unavailable.`,
        durationMs: 0,
        error: "server_unavailable",
      };
    }

    try {
      const raw = (await connection.client.callTool(
        { name: tool.remoteName, arguments: args },
        undefined,
        { timeout: getEnv().MCP_TOOL_TIMEOUT_MS },
      )) as McpCallResult;

      const text = (raw.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();

      const durationMs = Math.round(performance.now() - started);

      if (raw.isError) {
        return {
          id,
          name,
          server: tool.serverId,
          args,
          status: "error",
          result: text || "The tool reported an error but returned no detail.",
          durationMs,
          error: "tool_error",
        };
      }

      return {
        id,
        name,
        server: tool.serverId,
        args,
        status: "success",
        result: text || JSON.stringify(raw.structuredContent ?? {}),
        structured: raw.structuredContent,
        durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Tool "${name}" failed: ${message}`);

      return {
        id,
        name,
        server: tool.serverId,
        args,
        status: "error",
        result:
          `The ${tool.serverId} tool could not be reached (${message}). ` +
          `Treat this information as unavailable.`,
        durationMs: Math.round(performance.now() - started),
        error: "transport_error",
      };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.client.close()));
    this.connections.clear();
    this.ready = null;
  }

  private allTools(): RemoteTool[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }
}

/**
 * Next.js replaces module instances on every hot reload in development; without
 * a global handle each edit would leak a pair of child processes.
 */
const globalForMcp = globalThis as typeof globalThis & { __mcpRegistry?: McpToolRegistry };

export async function getMcpRegistry(): Promise<McpToolRegistry> {
  const registry = (globalForMcp.__mcpRegistry ??= new McpToolRegistry());
  await registry.init();
  return registry;
}

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;
}
