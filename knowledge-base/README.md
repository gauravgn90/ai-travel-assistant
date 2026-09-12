# Knowledge base

15 markdown documents drawn from four distinct public resources, covering the six areas the brief
asks for: attractions and neighbourhoods, local transport, cultural and practical guidance, food and
local experiences, sample itineraries, and indoor/outdoor activity suggestions.

```
knowledge-base/
├── singapore/   fetched from MediaWiki by `npm run kb:fetch` (12 documents)
└── curated/     written for this project, with source attribution (3 documents)
```

## Document format

Plain markdown with a front-matter block. The block is the citation: the retriever carries it
through chunking so every answer can name where a fact came from.

```markdown
---
id: wikivoyage-singapore-chinatown          # unique, stable; chunk ids derive from it
title: "Wikivoyage: Singapore — Chinatown"  # shown in citations
url: https://en.wikivoyage.org/wiki/Singapore/Chinatown
publisher: Wikivoyage
license: CC BY-SA 4.0
retrievedAt: 2026-09-12
topics: [neighbourhood, culture, food, temples, shopping]
---

# Wikivoyage: Singapore — Chinatown

## See
...
```

All six scalar fields are required; ingestion fails loudly and names the file if one is missing.

## Sources and reuse terms

| Documents | Source | Licence | Handling |
| --- | --- | --- | --- |
| 9 | [Wikivoyage](https://en.wikivoyage.org/wiki/Singapore) — main guide plus Chinatown, Little India, Bugis, Riverside, Orchard, Sentosa, North and West, East Coast | CC BY-SA 4.0 | Extracted text committed as fetched; attributed in every citation |
| 3 | [Wikipedia](https://en.wikipedia.org/wiki/Transport_in_Singapore) — Transport in Singapore, Tourism in Singapore, Culture of Singapore | CC BY-SA 4.0 | Same |
| 3 | [Visit Singapore](https://www.visitsingapore.com/) — travel essentials, sample itineraries, things to do | Not openly licensed | **Not reproduced.** Factual summaries written for this project; source URL retained as metadata |

CC BY-SA 4.0 permits redistribution with attribution, which is why the Wikivoyage and Wikipedia
extracts are committed here and why every citation shows the source title, publisher and link.
Visit Singapore's pages carry no such grant, so no text from them appears in this repository — the
three curated documents state the same facts in our own words. `npm run kb:fetch` never writes to
`curated/`.

## Rebuilding

```bash
npm run kb:fetch    # re-download singapore/ from MediaWiki; leaves curated/ alone
npm run kb:ingest   # chunk + embed everything into data/index/
npm run kb:stats    # what ended up in the index
```

The fetch script is in [`scripts/fetch-sources.ts`](../scripts/fetch-sources.ts); its `SOURCES`
array is the list of articles to pull. It uses the MediaWiki `extracts` API, which returns plain
text with `== heading ==` markers — far more reliable to convert to markdown than rendered HTML —
and drops navigation sections ("See also", "References", "External links") that would otherwise win
retrieval slots on keyword overlap while containing no travel content.

## Adding a source

1. Write or fetch a markdown file with the front-matter block above.
2. Put it in `singapore/` (fetched) or `curated/` (hand-written). Nested directories are fine.
3. `npm run kb:ingest`.

No application code changes. Documents are discovered by directory walk and identified by their
`id`, so a duplicate id is caught at ingest rather than corrupting retrieval silently.

## Changing destination

The pipeline is destination-agnostic. Replace the corpus, set `DESTINATION` in `.env.local`, and
re-ingest. Only the `SOURCES` list in the fetch script is Singapore-specific.
