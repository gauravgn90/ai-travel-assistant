#!/usr/bin/env node
/**
 * MCP server exposing weather lookups backed by Open-Meteo.
 *
 * Open-Meteo needs no API key and permits non-commercial use, which keeps the
 * assistant runnable from a fresh clone. Geocoding and forecast are separate
 * upstream calls; the geocode result is memoised because a session asks about
 * the same handful of places over and over.
 *
 * Transport is stdio, so stdout belongs to the protocol — all diagnostics go to
 * stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchJson, UpstreamError } from "./http.ts";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const CURRENT_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
].join(",");

const DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "sunrise",
  "sunset",
].join(",");

/** WMO 4677 present-weather codes, collapsed to the granularity a traveller cares about. */
const WEATHER_CODES = new Map<number, string>([
  [0, "clear sky"],
  [1, "mainly clear"],
  [2, "partly cloudy"],
  [3, "overcast"],
  [45, "fog"],
  [48, "freezing fog"],
  [51, "light drizzle"],
  [53, "moderate drizzle"],
  [55, "dense drizzle"],
  [56, "light freezing drizzle"],
  [57, "dense freezing drizzle"],
  [61, "light rain"],
  [63, "moderate rain"],
  [65, "heavy rain"],
  [66, "light freezing rain"],
  [67, "heavy freezing rain"],
  [71, "light snow"],
  [73, "moderate snow"],
  [75, "heavy snow"],
  [77, "snow grains"],
  [80, "light rain showers"],
  [81, "moderate rain showers"],
  [82, "violent rain showers"],
  [85, "light snow showers"],
  [86, "heavy snow showers"],
  [95, "thunderstorm"],
  [96, "thunderstorm with light hail"],
  [99, "thunderstorm with heavy hail"],
]);

/** Codes at or above this threshold mean outdoor plans need a fallback. */
const WET_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);

interface GeocodeResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
    timezone?: string;
  }>;
}

interface ForecastResponse {
  timezone: string;
  current?: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    precipitation_probability_max: number[];
    sunrise: string[];
    sunset: string[];
  };
}

interface Place {
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

const geocodeCache = new Map<string, Place>();

async function resolvePlace(location: string): Promise<Place> {
  const key = location.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const response = await fetchJson<GeocodeResponse>(url);
  const match = response.results?.[0];

  if (!match) {
    throw new UpstreamError(
      `No place called "${location}" was found. Try a city name, optionally with its country.`,
      404,
    );
  }

  const place: Place = {
    label: [match.name, match.admin1, match.country].filter(Boolean).join(", "),
    latitude: match.latitude,
    longitude: match.longitude,
    timezone: match.timezone ?? "auto",
  };

  geocodeCache.set(key, place);
  return place;
}

function describeCode(code: number): string {
  return WEATHER_CODES.get(code) ?? `weather code ${code}`;
}

function outdoorAdvice(code: number, precipitationProbability: number): string {
  if (WET_CODES.has(code) || precipitationProbability >= 60) {
    return "wet — plan indoor options or keep outdoor stops short";
  }
  if (precipitationProbability >= 30) return "mixed — carry an umbrella for outdoor stops";
  return "dry — good for outdoor activities";
}

const server = new McpServer({
  name: "travel-weather",
  version: "1.0.0",
});

server.registerTool(
  "get_current_weather",
  {
    title: "Current weather",
    description:
      "Current observed conditions for a place: temperature, feels-like, humidity, wind and " +
      "precipitation. Use for questions about right now, not about later days.",
    inputSchema: {
      location: z
        .string()
        .min(2)
        .describe('City name, optionally with country, e.g. "Singapore" or "Penang, Malaysia".'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ location }) => {
    const place = await resolvePlace(location);
    const url =
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=${CURRENT_FIELDS}&timezone=auto`;

    const data = await fetchJson<ForecastResponse>(url);
    const current = data.current;
    if (!current) throw new UpstreamError("Open-Meteo returned no current conditions.");

    const summary =
      `Current weather in ${place.label} (local time ${current.time}): ` +
      `${describeCode(current.weather_code)}, ${current.temperature_2m}°C ` +
      `(feels like ${current.apparent_temperature}°C), humidity ${current.relative_humidity_2m}%, ` +
      `wind ${current.wind_speed_10m} km/h, precipitation ${current.precipitation} mm in the last hour.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        location: place.label,
        observedAt: current.time,
        timezone: data.timezone,
        conditions: describeCode(current.weather_code),
        temperatureC: current.temperature_2m,
        feelsLikeC: current.apparent_temperature,
        humidityPercent: current.relative_humidity_2m,
        windKph: current.wind_speed_10m,
        precipitationMm: current.precipitation,
        source: "Open-Meteo",
      },
    };
  },
);

server.registerTool(
  "get_weather_forecast",
  {
    title: "Weather forecast",
    description:
      "Day-by-day forecast for up to 7 days: conditions, high/low temperature, rainfall, chance " +
      "of rain, and an indoor/outdoor suitability call for each day. Use this when planning an " +
      "itinerary or answering questions about tomorrow or later.",
    inputSchema: {
      location: z
        .string()
        .min(2)
        .describe('City name, optionally with country, e.g. "Singapore".'),
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(3)
        .describe("Number of days to forecast, starting today."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ location, days }) => {
    const place = await resolvePlace(location);
    const url =
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&daily=${DAILY_FIELDS}&timezone=auto&forecast_days=${days}`;

    const data = await fetchJson<ForecastResponse>(url);
    const daily = data.daily;
    if (!daily) throw new UpstreamError("Open-Meteo returned no daily forecast.");

    const forecast = daily.time.map((date, i) => {
      const code = daily.weather_code[i] ?? 0;
      const rainChance = daily.precipitation_probability_max[i] ?? 0;
      return {
        date,
        conditions: describeCode(code),
        highC: daily.temperature_2m_max[i] ?? null,
        lowC: daily.temperature_2m_min[i] ?? null,
        precipitationMm: daily.precipitation_sum[i] ?? 0,
        rainChancePercent: rainChance,
        outlook: outdoorAdvice(code, rainChance),
        sunrise: daily.sunrise[i] ?? null,
        sunset: daily.sunset[i] ?? null,
      };
    });

    const summary = [
      `${days}-day forecast for ${place.label} (timezone ${data.timezone}):`,
      ...forecast.map(
        (day) =>
          `- ${day.date}: ${day.conditions}, ${day.lowC}–${day.highC}°C, ` +
          `${day.rainChancePercent}% chance of rain (${day.precipitationMm} mm) — ${day.outlook}`,
      ),
    ].join("\n");

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        location: place.label,
        timezone: data.timezone,
        days: forecast,
        source: "Open-Meteo",
      },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("travel-weather MCP server ready on stdio\n");
