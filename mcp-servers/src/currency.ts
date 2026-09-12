#!/usr/bin/env node
/**
 * MCP server exposing currency conversion backed by Frankfurter, which
 * republishes the European Central Bank reference rates. No API key, and the
 * rate date comes back with every response so the assistant can say how fresh
 * the number is.
 *
 * ECB rates are published once per working day, so a conversion quoted on a
 * weekend is Friday's rate. That is stated in the tool output rather than
 * hidden, because a traveller comparing it against an airport board will
 * otherwise think the tool is wrong.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchJson, UpstreamError } from "./http.ts";

const API_BASE = "https://api.frankfurter.dev/v1";
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

interface LatestResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

let currencyCache: { fetchedAt: number; currencies: Record<string, string> } | null = null;
const CURRENCY_TTL_MS = 24 * 60 * 60 * 1000;

async function supportedCurrencies(): Promise<Record<string, string>> {
  if (currencyCache && Date.now() - currencyCache.fetchedAt < CURRENCY_TTL_MS) {
    return currencyCache.currencies;
  }

  const currencies = await fetchJson<Record<string, string>>(`${API_BASE}/currencies`);
  currencyCache = { fetchedAt: Date.now(), currencies };
  return currencies;
}

function normaliseCode(value: string, field: string): string {
  const code = value.trim().toUpperCase();
  if (!CURRENCY_CODE.test(code)) {
    throw new UpstreamError(`"${value}" is not a three-letter ISO 4217 code (${field}).`, 400);
  }
  return code;
}

function formatAmount(amount: number, code: string): string {
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${code}`;
}

const server = new McpServer({
  name: "travel-currency",
  version: "1.0.0",
});

server.registerTool(
  "convert_currency",
  {
    title: "Convert currency",
    description:
      "Convert an amount between two ISO 4217 currencies at the latest published reference rate. " +
      "Returns the converted amount, the unit rate, and the date the rate was published.",
    inputSchema: {
      amount: z.number().positive().describe("Amount to convert, in the source currency."),
      from: z.string().length(3).describe('Source currency code, e.g. "INR".'),
      to: z.string().length(3).describe('Target currency code, e.g. "SGD".'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ amount, from, to }) => {
    const source = normaliseCode(from, "from");
    const target = normaliseCode(to, "to");

    if (source === target) {
      return {
        content: [
          { type: "text", text: `${formatAmount(amount, source)} is already in ${target}.` },
        ],
        structuredContent: {
          amount,
          from: source,
          to: target,
          converted: amount,
          rate: 1,
          rateDate: new Date().toISOString().slice(0, 10),
          source: "Frankfurter (ECB reference rates)",
        },
      };
    }

    const currencies = await supportedCurrencies();
    for (const code of [source, target]) {
      if (!(code in currencies)) {
        const available = Object.keys(currencies).join(", ");
        throw new UpstreamError(
          `${code} is not covered by the ECB reference rates. Supported codes: ${available}.`,
          400,
        );
      }
    }

    const url = `${API_BASE}/latest?base=${source}&symbols=${target}`;
    const data = await fetchJson<LatestResponse>(url);

    const rate = data.rates[target];
    if (typeof rate !== "number") {
      throw new UpstreamError(`No ${source}→${target} rate was returned.`);
    }

    const converted = amount * rate;
    const summary =
      `${formatAmount(amount, source)} = ${formatAmount(converted, target)} ` +
      `at 1 ${source} = ${rate} ${target} (ECB reference rate published ${data.date}).`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        amount,
        from: source,
        to: target,
        converted: Number(converted.toFixed(2)),
        rate,
        rateDate: data.date,
        fromName: currencies[source],
        toName: currencies[target],
        source: "Frankfurter (ECB reference rates)",
      },
    };
  },
);

server.registerTool(
  "list_supported_currencies",
  {
    title: "List supported currencies",
    description:
      "List the ISO 4217 currency codes this service can convert between, with their full names. " +
      "Use when a requested currency is rejected, to suggest a valid alternative.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const currencies = await supportedCurrencies();
    const entries = Object.entries(currencies);

    return {
      content: [
        {
          type: "text",
          text: `${entries.length} supported currencies: ${entries
            .map(([code, name]) => `${code} (${name})`)
            .join(", ")}.`,
        },
      ],
      structuredContent: { count: entries.length, currencies },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("travel-currency MCP server ready on stdio\n");
