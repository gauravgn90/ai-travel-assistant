import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolCall } from "./types.ts";

/** The two tool servers this project ships. They are TypeScript run by the
 *  current Node binary, which strips the types itself, so there is no build
 *  step between editing a tool and calling it. */
const SERVERS = [
  { id: "weather", file: "weather.ts" },
  { id: "currency", file: "currency.ts" },
];

interface RemoteTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  server: string;
}

export interface McpSession {
  /** Tool definitions in the shape `model.bindTools` accepts. */
  definitions: Array<{ type: "function"; function: RemoteTool }>;
  tools: RemoteTool[];
  /** Servers that failed to start, so the prompt can admit the limitation. */
  missing: string[];
  call(id: string, name: string, args: Record<string, unknown>): Promise<ToolCall>;
}

const clients = new Map<string, Client>();

/**
 * Connects to both servers once per process and reuses the connections;
 * spawning a server per request would add hundreds of milliseconds to a turn.
 * A server that will not start is recorded and skipped rather than failing the
 * request - the assistant is still useful with one tool family missing.
 *
 * Next.js replaces module instances on hot reload, so the promise lives on
 * globalThis; without it every edit in development would leak two child
 * processes.
 */
export function mcp(): Promise<McpSession> {
  const store = globalThis as typeof globalThis & { __mcp?: Promise<McpSession> };
  store.__mcp ??= connect();
  return store.__mcp;
}

async function connect(): Promise<McpSession> {
  const tools: RemoteTool[] = [];
  const missing: string[] = [];

  await Promise.all(
    SERVERS.map(async ({ id, file }) => {
      try {
        const client = new Client({ name: "travel-assistant", version: "1.0.0" });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            // Kept literal so the bundler can trace exactly this folder.
            args: [path.join(process.cwd(), "mcp-servers", file)],
            cwd: process.cwd(),
          }),
        );

        const listed = await client.listTools();
        clients.set(id, client);
        for (const tool of listed.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? tool.name,
            parameters: toolSchema((tool.inputSchema ?? {}) as Record<string, unknown>),
            server: id,
          });
        }
      } catch (error) {
        missing.push(id);
        console.error(`MCP server "${id}" did not start:`, error);
      }
    }),
  );

  return {
    tools,
    missing,
    definitions: tools.map((tool) => ({ type: "function" as const, function: tool })),

    async call(id, name, args): Promise<ToolCall> {
      const tool = tools.find((candidate) => candidate.name === name);
      const client = tool && clients.get(tool.server);

      if (!client) {
        const available = tools.map((candidate) => candidate.name).join(", ") || "none";
        return { id, name, args, ok: false, result: `No tool named "${name}" is connected. Available: ${available}.` };
      }

      try {
        const raw = (await client.callTool({ name, arguments: args }, undefined, {
          timeout: 20_000,
        })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

        const text = (raw.content ?? [])
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text!)
          .join("\n")
          .trim();

        return { id, name, args, ok: !raw.isError, result: text || "The tool returned nothing." };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Reported back to the model as a tool result, so it explains the gap
        // rather than filling it in.
        return { id, name, args, ok: false, result: `The ${name} tool failed (${detail}). Treat this information as unavailable.` };
      }
    },
  };
}

/** Keywords every supported provider accepts.
 *
 *  MCP servers publish JSON Schema derived from Zod. OpenAI, Anthropic and Groq
 *  take that as-is, but Gemini's function declarations are OpenAPI 3.0 schema
 *  objects and reject any keyword outside their own subset with a 400 rather
 *  than ignoring it - `$schema` and `additionalProperties` are the ones that
 *  turn up in practice. Narrowing to Gemini's subset for everyone keeps one
 *  code path instead of a per-provider branch, and costs the others nothing.
 *
 *  Constraints are only ever dropped here, never added: the MCP server still
 *  validates its own arguments, so a value this schema no longer forbids comes
 *  back as a tool error rather than as bad data. */
const ALLOWED = new Set([
  "type", "description", "enum", "items", "properties", "required",
  "minimum", "maximum", "minLength", "maxLength", "nullable", "default",
]);

function toolSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node) || typeof node !== "object" || node === null) {
    return node as Record<string, unknown>;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED.has(key)) continue;
    if (key === "properties" && typeof value === "object" && value !== null) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, toolSchema(sub)]),
      );
    } else if (key === "items") {
      out.items = toolSchema(value);
    } else {
      out[key] = value;
    }
  }

  // Gemini rejects an object schema carrying an empty properties map.
  if (out.properties && Object.keys(out.properties).length === 0) {
    delete out.properties;
    delete out.required;
  }

  return out;
}
