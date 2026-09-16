#!/usr/bin/env node
/**
 * MCP server for weather, backed by Open-Meteo. No API key, which keeps the
 * assistant runnable from a fresh clone. Geocoding and forecast are separate
 * upstream calls; the geocode result is cached because one session asks about
 * the same place repeatedly.
 *
 * Transport is stdio, so stdout belongs to the protocol and notes go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchJson } from "./fetch-json.ts";

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** WMO present-weather codes, at the granularity a traveller cares about. */
const CONDITIONS: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  61: "light rain", 63: "moderate rain", 65: "heavy rain",
  71: "light snow", 73: "moderate snow", 75: "heavy snow",
  80: "light rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

const WET = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]);

const describe = (code: number) => CONDITIONS[code] ?? `weather code ${code}`;

/** The call the assistant actually needs: whether to plan indoors or outdoors. */
function outlook(code: number, rainChance: number): string {
  if (WET.has(code) || rainChance >= 60) return "wet - plan indoor options or keep outdoor stops short";
  if (rainChance >= 30) return "mixed - carry an umbrella for outdoor stops";
  return "dry - good for outdoor activities";
}

interface Place {
  label: string;
  latitude: number;
  longitude: number;
}

const places = new Map<string, Place>();

async function resolve(location: string): Promise<Place> {
  const key = location.trim().toLowerCase();
  const cached = places.get(key);
  if (cached) return cached;

  const data = await fetchJson<{
    results?: Array<{ name: string; latitude: number; longitude: number; country?: string }>;
  }>(`${GEOCODE}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`);

  const match = data.results?.[0];
  if (!match) throw new Error(`no place called "${location}" was found`);

  const place: Place = {
    label: [match.name, match.country].filter(Boolean).join(", "),
    latitude: match.latitude,
    longitude: match.longitude,
  };

  places.set(key, place);
  return place;
}

function failed(error: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: `Weather lookup failed: ${error instanceof Error ? error.message : String(error)}.` },
    ],
  };
}

const server = new McpServer({ name: "weather", version: "1.0.0" });

server.registerTool(
  "get_current_weather",
  {
    description:
      "Current observed conditions for a place: temperature, feels-like, humidity and wind. " +
      "Use for questions about right now, not about later days.",
    inputSchema: {
      location: z.string().describe('City name, for example "Singapore".'),
    },
  },
  async ({ location }) => {
    try {
      const place = await resolve(location);
      const data = await fetchJson<{
        current?: {
          time: string; temperature_2m: number; apparent_temperature: number;
          relative_humidity_2m: number; weather_code: number; wind_speed_10m: number;
        };
      }>(
        `${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`,
      );

      const now = data.current;
      if (!now) throw new Error("the service returned no current conditions");

      return {
        content: [
          {
            type: "text",
            text:
              `Current weather in ${place.label} (local time ${now.time}): ${describe(now.weather_code)}, ` +
              `${now.temperature_2m}°C, feels like ${now.apparent_temperature}°C, ` +
              `humidity ${now.relative_humidity_2m}%, wind ${now.wind_speed_10m} km/h.`,
          },
        ],
      };
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "get_weather_forecast",
  {
    description:
      "Day-by-day forecast for up to 7 days: conditions, high and low temperature, chance of rain, " +
      "and whether each day suits indoor or outdoor plans. Use this when planning an itinerary or " +
      "answering about tomorrow or later.",
    inputSchema: {
      location: z.string().describe('City name, for example "Singapore".'),
      days: z.number().describe("Number of days to forecast, starting today. Between 1 and 7."),
    },
  },
  async ({ location, days }) => {
    try {
      const span = Math.min(Math.max(Math.round(days) || 3, 1), 7);
      const place = await resolve(location);
      const data = await fetchJson<{
        timezone: string;
        daily?: {
          time: string[]; weather_code: number[];
          temperature_2m_max: number[]; temperature_2m_min: number[];
          precipitation_probability_max: number[];
        };
      }>(
        `${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
          `&timezone=auto&forecast_days=${span}`,
      );

      const daily = data.daily;
      if (!daily) throw new Error("the service returned no forecast");

      const lines = daily.time.map((date, i) => {
        const code = daily.weather_code[i] ?? 0;
        const rain = daily.precipitation_probability_max[i] ?? 0;
        return (
          `- ${date}: ${describe(code)}, ${daily.temperature_2m_min[i]}-${daily.temperature_2m_max[i]}°C, ` +
          `${rain}% chance of rain - ${outlook(code, rain)}`
        );
      });

      return {
        content: [
          { type: "text", text: [`${span}-day forecast for ${place.label}:`, ...lines].join("\n") },
        ],
      };
    } catch (error) {
      return failed(error);
    }
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write("weather MCP server ready\n");
