/**
 * Rebuilds the fetched half of the knowledge base from MediaWiki.
 *
 * Wikivoyage and Wikipedia are used because both publish under CC BY-SA 4.0,
 * which permits redistribution with attribution — so the extracted markdown can
 * be committed to this repository and the corpus is reproducible from a clean
 * clone. The `extracts` API returns plain text with wiki heading markers, which
 * converts to markdown far more reliably than parsing rendered HTML.
 *
 * Documents under knowledge-base/curated/ are hand-written and are never
 * touched by this script.
 *
 * Usage: npm run kb:fetch
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../src/lib/config/paths.ts";
import { serialiseFrontmatter } from "../src/lib/rag/documents.ts";
import type { SourceDocument } from "../src/lib/types.ts";

interface SourceSpec {
  id: string;
  site: "en.wikivoyage.org" | "en.wikipedia.org";
  title: string;
  displayTitle: string;
  publisher: string;
  topics: string[];
}

const SOURCES: SourceSpec[] = [
  {
    id: "wikivoyage-singapore",
    site: "en.wikivoyage.org",
    title: "Singapore",
    displayTitle: "Wikivoyage: Singapore Travel Guide",
    publisher: "Wikivoyage",
    topics: ["overview", "districts", "attractions", "transport", "food", "itineraries", "practical"],
  },
  {
    id: "wikivoyage-singapore-chinatown",
    site: "en.wikivoyage.org",
    title: "Singapore/Chinatown",
    displayTitle: "Wikivoyage: Singapore — Chinatown",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "culture", "food", "temples", "shopping"],
  },
  {
    id: "wikivoyage-singapore-little-india",
    site: "en.wikivoyage.org",
    title: "Singapore/Little India",
    displayTitle: "Wikivoyage: Singapore — Little India",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "culture", "food", "temples", "markets"],
  },
  {
    id: "wikivoyage-singapore-bugis",
    site: "en.wikivoyage.org",
    title: "Singapore/Bugis",
    displayTitle: "Wikivoyage: Singapore — Bugis and Kampong Glam",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "culture", "food", "shopping", "mosques"],
  },
  {
    id: "wikivoyage-singapore-riverside",
    site: "en.wikivoyage.org",
    title: "Singapore/Riverside",
    displayTitle: "Wikivoyage: Singapore — Riverside and Marina Bay",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "attractions", "museums", "nightlife", "marina-bay"],
  },
  {
    id: "wikivoyage-singapore-orchard",
    site: "en.wikivoyage.org",
    title: "Singapore/Orchard",
    displayTitle: "Wikivoyage: Singapore — Orchard Road",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "shopping", "indoor", "hotels"],
  },
  {
    id: "wikivoyage-singapore-sentosa",
    site: "en.wikivoyage.org",
    title: "Singapore/Sentosa and Harbourfront",
    displayTitle: "Wikivoyage: Singapore — Sentosa and HarbourFront",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "family", "theme-parks", "beaches", "attractions"],
  },
  {
    id: "wikivoyage-singapore-north-west",
    site: "en.wikivoyage.org",
    title: "Singapore/North and West",
    displayTitle: "Wikivoyage: Singapore — North and West",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "nature", "zoo", "family", "outdoors"],
  },
  {
    id: "wikivoyage-singapore-east-coast",
    site: "en.wikivoyage.org",
    title: "Singapore/East Coast",
    displayTitle: "Wikivoyage: Singapore — East Coast",
    publisher: "Wikivoyage",
    topics: ["neighbourhood", "food", "beaches", "outdoors", "changi"],
  },
  {
    id: "wikipedia-transport-in-singapore",
    site: "en.wikipedia.org",
    title: "Transport in Singapore",
    displayTitle: "Wikipedia: Transport in Singapore",
    publisher: "Wikipedia",
    topics: ["transport", "mrt", "buses", "taxis", "practical"],
  },
  {
    id: "wikipedia-tourism-in-singapore",
    site: "en.wikipedia.org",
    title: "Tourism in Singapore",
    displayTitle: "Wikipedia: Tourism in Singapore",
    publisher: "Wikipedia",
    topics: ["attractions", "tourism", "overview", "events"],
  },
  {
    id: "wikipedia-culture-of-singapore",
    site: "en.wikipedia.org",
    title: "Culture of Singapore",
    displayTitle: "Wikipedia: Culture of Singapore",
    publisher: "Wikipedia",
    topics: ["culture", "festivals", "etiquette", "language", "food"],
  },
];

/**
 * Sections that are navigation scaffolding rather than travel content. Dropping
 * them before chunking keeps reference lists and "see also" stubs from winning
 * retrieval slots on keyword overlap alone.
 */
const DROPPED_SECTIONS = new Set([
  "see also",
  "references",
  "further reading",
  "external links",
  "notes",
  "citations",
  "bibliography",
  "gallery",
  "go next",
  "nearby",
]);

const USER_AGENT =
  "ai-travel-assistant/1.0 (knowledge-base builder; https://github.com/; contact via repository)";

interface ExtractResponse {
  query?: {
    pages?: Record<string, { title: string; extract?: string; missing?: string }>;
  };
}

async function fetchExtract(spec: SourceSpec): Promise<string> {
  const url = new URL(`https://${spec.site}/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "1");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", spec.title);

  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`${spec.site} returned HTTP ${response.status} for "${spec.title}"`);
  }

  const payload = (await response.json()) as ExtractResponse;
  const page = Object.values(payload.query?.pages ?? {})[0];

  if (!page || page.missing !== undefined || !page.extract) {
    throw new Error(`"${spec.title}" does not exist on ${spec.site}`);
  }

  return page.extract;
}

/**
 * Converts MediaWiki plain-text extracts to markdown.
 *
 * The extract format uses `== Heading ==` at depth 2 for top-level sections, so
 * levels are shifted up by one to leave `#` for the document title.
 */
export function wikitextToMarkdown(extract: string, documentTitle: string): string {
  const lines = extract.split(/\r?\n/);
  const output: string[] = [`# ${documentTitle}`, ""];

  let skipDepth: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = /^(={2,6})\s*(.+?)\s*\1$/.exec(line);

    if (heading) {
      const depth = heading[1]!.length;
      const text = heading[2]!.trim();

      // A dropped section swallows everything until a heading at the same or a
      // shallower depth.
      if (skipDepth !== null && depth <= skipDepth) skipDepth = null;
      if (DROPPED_SECTIONS.has(text.toLowerCase())) {
        skipDepth = depth;
        continue;
      }
      if (skipDepth !== null) continue;

      output.push("", `${"#".repeat(Math.min(depth, 6))} ${text}`, "");
      continue;
    }

    if (skipDepth !== null) continue;
    output.push(line);
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim()
    .concat("\n");
}

async function main(): Promise<void> {
  const outputDir = path.join(paths.knowledgeBase, "singapore");
  await mkdir(outputDir, { recursive: true });

  const retrievedAt = new Date().toISOString().slice(0, 10);
  let failures = 0;

  for (const spec of SOURCES) {
    try {
      const extract = await fetchExtract(spec);
      const body = wikitextToMarkdown(extract, spec.displayTitle);

      const metadata: SourceDocument = {
        id: spec.id,
        title: spec.displayTitle,
        url: `https://${spec.site}/wiki/${encodeURI(spec.title.replace(/ /g, "_"))}`,
        publisher: spec.publisher,
        license: "CC BY-SA 4.0",
        retrievedAt,
        topics: spec.topics,
      };

      const file = path.join(outputDir, `${spec.id}.md`);
      await writeFile(file, serialiseFrontmatter(metadata, body), "utf8");

      const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
      console.log(`  ok    ${spec.id.padEnd(38)} ${kb.padStart(7)} KB`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL  ${spec.id.padEnd(38)} ${error instanceof Error ? error.message : error}`);
    }

    // MediaWiki asks API clients to serialise requests rather than burst them.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(`\nWrote ${SOURCES.length - failures}/${SOURCES.length} documents to ${outputDir}`);
  if (failures > 0) {
    console.error("Some sources failed. Re-run to retry; existing files were left untouched.");
    process.exitCode = 1;
  }
}

await main();
