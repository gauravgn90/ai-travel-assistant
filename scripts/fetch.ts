/**
 * Refreshes the wiki half of the knowledge base from MediaWiki.
 *
 * Wikivoyage and Wikipedia both expose a plain-text extract of a page through
 * the same API, so one fetch per page is enough - no HTML scraping and no
 * parser to keep in step with a site redesign. Documents under
 * knowledge-base/curated/ are hand-written and are never touched here.
 *
 * Usage: npm run fetch && npm run ingest
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../src/lib/config.ts";

interface Source {
  id: string;
  site: string;
  /** Page title as MediaWiki addresses it. */
  page: string;
  title: string;
  publisher: string;
}

const WIKIVOYAGE = "en.wikivoyage.org";
const WIKIPEDIA = "en.wikipedia.org";

const SOURCES: Source[] = [
  { id: "wikivoyage-singapore", site: WIKIVOYAGE, page: "Singapore", title: "Wikivoyage: Singapore Travel Guide", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-chinatown", site: WIKIVOYAGE, page: "Singapore/Chinatown", title: "Wikivoyage: Singapore - Chinatown", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-little-india", site: WIKIVOYAGE, page: "Singapore/Little India", title: "Wikivoyage: Singapore - Little India", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-bugis", site: WIKIVOYAGE, page: "Singapore/Bugis", title: "Wikivoyage: Singapore - Bugis and Kampong Glam", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-riverside", site: WIKIVOYAGE, page: "Singapore/Riverside", title: "Wikivoyage: Singapore - Riverside and Marina Bay", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-orchard", site: WIKIVOYAGE, page: "Singapore/Orchard", title: "Wikivoyage: Singapore - Orchard Road", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-sentosa", site: WIKIVOYAGE, page: "Singapore/Sentosa and Harbourfront", title: "Wikivoyage: Singapore - Sentosa and Harbourfront", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-north-west", site: WIKIVOYAGE, page: "Singapore/North and West", title: "Wikivoyage: Singapore - North and West", publisher: "Wikivoyage" },
  { id: "wikivoyage-singapore-east-coast", site: WIKIVOYAGE, page: "Singapore/East Coast", title: "Wikivoyage: Singapore - East Coast", publisher: "Wikivoyage" },
  { id: "wikipedia-tourism-in-singapore", site: WIKIPEDIA, page: "Tourism in Singapore", title: "Wikipedia: Tourism in Singapore", publisher: "Wikipedia" },
  { id: "wikipedia-transport-in-singapore", site: WIKIPEDIA, page: "Transport in Singapore", title: "Wikipedia: Transport in Singapore", publisher: "Wikipedia" },
  { id: "wikipedia-culture-of-singapore", site: WIKIPEDIA, page: "Culture of Singapore", title: "Wikipedia: Culture of Singapore", publisher: "Wikipedia" },
];

/** Sections that are navigation scaffolding rather than travel content. Left in,
 *  a reference list wins retrieval slots on keyword overlap and answers nothing. */
const SKIP = new Set([
  "see also", "references", "further reading", "external links", "notes",
  "citations", "bibliography", "gallery", "go next", "nearby",
]);

/** Wikimedia's user-agent policy asks for a descriptive agent that identifies
 *  the tool. Requests without one are rate-limited far more aggressively. */
const USER_AGENT =
  "singapore-travel-assistant/1.0 (knowledge base builder; https://github.com/topics/mcp)";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchExtract(source: Source): Promise<string> {
  const url = new URL(`https://${source.site}/w/api.php`);
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "1",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    titles: source.page,
  }).toString();

  let lastStatus = 0;

  // MediaWiki answers a burst with 429. Backing off and retrying is the
  // difference between refreshing the corpus and refreshing most of it.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(2000 * attempt);

    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 429 || response.status >= 500) {
      lastStatus = response.status;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
      continue;
    }

    if (!response.ok) throw new Error(`${source.site} returned HTTP ${response.status}`);

    const payload = (await response.json()) as {
      query?: { pages?: Record<string, { extract?: string; missing?: string }> };
    };
    const page = Object.values(payload.query?.pages ?? {})[0];

    if (!page || page.missing !== undefined || !page.extract) {
      throw new Error(`"${source.page}" does not exist on ${source.site}`);
    }

    return page.extract;
  }

  throw new Error(`${source.site} kept returning HTTP ${lastStatus} after 4 attempts`);
}

/** MediaWiki extracts use `== Heading ==` at depth 2 for top-level sections, so
 *  levels shift up by one to leave `#` for the document title. */
function toMarkdown(extract: string, title: string): string {
  const out: string[] = [`# ${title}`, ""];
  let skipDepth: number | null = null;

  for (const line of extract.split(/\r?\n/)) {
    const heading = /^(={2,6})\s*(.+?)\s*\1$/.exec(line.trimEnd());

    if (heading) {
      const depth = heading[1]!.length;
      const text = heading[2]!.trim();

      // A skipped section swallows everything up to the next heading at the
      // same or a shallower depth.
      if (skipDepth !== null && depth <= skipDepth) skipDepth = null;
      if (SKIP.has(text.toLowerCase())) {
        skipDepth = depth;
        continue;
      }
      if (skipDepth !== null) continue;

      out.push("", `${"#".repeat(Math.min(depth, 6))} ${text}`, "");
      continue;
    }

    if (skipDepth === null) out.push(line.trimEnd());
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

const directory = path.join(paths.knowledgeBase, "singapore");
await mkdir(directory, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
let failed = 0;

for (const source of SOURCES) {
  try {
    const body = toMarkdown(await fetchExtract(source), source.title);
    const url = `https://${source.site}/wiki/${encodeURI(source.page.replace(/ /g, "_"))}`;

    // The front matter is the citation: it travels with every chunk, which is
    // how an answer can name and link its source.
    const document = [
      "---",
      `id: ${source.id}`,
      `title: "${source.title}"`,
      `url: ${url}`,
      `publisher: ${source.publisher}`,
      `retrievedAt: ${today}`,
      "---",
      "",
      body,
    ].join("\n");

    await writeFile(path.join(directory, `${source.id}.md`), document, "utf8");
    console.log(`  ok    ${source.id.padEnd(36)} ${(Buffer.byteLength(body) / 1024).toFixed(1).padStart(7)} KB`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${source.id.padEnd(36)} ${error instanceof Error ? error.message : error}`);
  }

  // MediaWiki asks API clients to serialise requests rather than burst them.
  await sleep(500);
}

console.log(`\n${SOURCES.length - failed}/${SOURCES.length} documents written to ${directory}`);
if (failed > 0) {
  console.error("Some pages failed. Re-run to retry; the files already on disk were left alone.");
  process.exitCode = 1;
} else {
  console.log("Now run `npm run ingest` to rebuild the index.");
}
