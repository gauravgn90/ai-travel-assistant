#!/usr/bin/env node
/**
 * MCP server for currency conversion, backed by Frankfurter, which republishes
 * the European Central Bank reference rates. No API key.
 *
 * ECB rates are published once each working day, so a conversion quoted at the
 * weekend is Friday's rate. The tool says so rather than hiding it, because a
 * traveller comparing it against an airport board will otherwise think it wrong.
 *
 * Transport is stdio, so stdout belongs to the protocol and notes go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchJson } from "./fetch-json.ts";

const API = "https://api.frankfurter.dev/v1";

const server = new McpServer({ name: "currency", version: "1.0.0" });

server.registerTool(
  "convert_currency",
  {
    description:
      "Convert an amount between two ISO 4217 currencies at the latest published reference rate. " +
      "Returns the converted amount, the unit rate and the date the rate was published.",
    inputSchema: {
      amount: z.number().describe("Amount to convert, in the source currency."),
      from: z.string().describe('Source currency code, for example "INR".'),
      to: z.string().describe('Target currency code, for example "SGD".'),
    },
  },
  async ({ amount, from, to }) => {
    const source = from.trim().toUpperCase();
    const target = to.trim().toUpperCase();

    const money = (value: number, code: string) =>
      `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;

    if (source === target) {
      return { content: [{ type: "text", text: `${money(amount, source)} is already in ${target}.` }] };
    }

    try {
      const data = await fetchJson<{ date: string; rates: Record<string, number> }>(
        `${API}/latest?base=${source}&symbols=${target}`,
      );
      const rate = data.rates[target];
      if (typeof rate !== "number") throw new Error(`no ${source} to ${target} rate was returned`);

      return {
        content: [
          {
            type: "text",
            text:
              `${money(amount, source)} = ${money(amount * rate, target)} at 1 ${source} = ${rate} ${target} ` +
              `(European Central Bank reference rate published ${data.date}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Could not convert ${source} to ${target}: ${error instanceof Error ? error.message : String(error)}.`,
          },
        ],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write("currency MCP server ready\n");
