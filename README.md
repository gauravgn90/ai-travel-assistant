# AI Travel Planning Assistant — Singapore

A context-aware travel assistant that answers destination questions from a curated document
knowledge base (RAG) and pulls live weather and currency data through MCP tools, combining both
when a question needs both.

Ask *"Create a three-day Singapore itinerary for next week and adjust it to the weather forecast"*
and the assistant retrieves attractions, indoor alternatives and transport guidance from the
corpus, calls an MCP weather tool for the forecast, and produces a day-by-day plan that says which
part came from the guides, which came from the tool, and which is its own suggestion.

Built with Node.js 24, Next.js 16 (App Router), LangChain, and the official MCP TypeScript SDK.

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Running without any API key](#running-without-any-api-key)
- [Architecture](#architecture)
- [Knowledge base](#knowledge-base)
- [RAG workflow](#rag-workflow)
- [MCP tools](#mcp-tools)
- [Prompt and context strategy](#prompt-and-context-strategy)
- [Configuration](#configuration)
- [Commands](#commands)
- [Project layout](#project-layout)
- [Design decisions](#design-decisions)
- [Limitations](#limitations)

---

## What it does

| Capability | How |
| --- | --- |
| Destination knowledge | Hybrid retrieval over 15 documents / ~505 chunks from Wikivoyage, Wikipedia and curated Singapore Tourism Board summaries |
| Grounded answers | Every destination fact carries an `[S1]`-style marker resolving to a source title and URL |
| Live weather | MCP tool over Open-Meteo — current conditions and a 1–7 day forecast with an indoor/outdoor call per day |
| Currency conversion | MCP tool over Frankfurter (ECB reference rates), with the publication date attached |
| Combined answers | One turn can retrieve, call several tools in parallel, and fuse the results |
| Multi-turn memory | Transcript plus pinned preferences (budget, party, trip length, diet, interests) carried across turns |
| Honest gaps | An absolute-similarity floor detects "the corpus does not cover this"; tool failures are reported, never papered over |
| Provider choice | OpenAI, Anthropic, Groq or Google, selected by one environment variable |

---

## Quick start

Requires **Node.js 24** (`.nvmrc` pins 24.18.0) and one LLM API key.

```bash
git clone <repository-url>
cd ai-travel-assistant
npm install

cp .env.example .env.local
# edit .env.local: set LLM_PROVIDER and the matching API key

npm run kb:fetch     # download the source documents (~2 min, no key needed)
npm run kb:ingest    # chunk + embed into data/index (~1 min with local embeddings)
npm run dev          # http://localhost:3000
```

`kb:fetch` and `kb:ingest` are one-time steps. The fetched documents are committed to the
repository, so `kb:fetch` is only needed to refresh them.

Check the wiring at any time:

```bash
curl -s localhost:3000/api/health | jq
```

It reports each subsystem separately — provider key present, index built, MCP servers connected —
so a half-configured install says which half is missing.

### Terminal client

```bash
npm run ask                                   # interactive, multi-turn
npm run ask -- "What indoor attractions can I visit?"   # one-shot
```

Same orchestrator as the web UI, no browser needed.

---

## Running without any API key

Two of the three subsystems need no credentials at all, which makes it possible to verify most of
the application when LLM quota is exhausted.

```bash
# Retrieval — embeds locally, calls no vendor API
EMBEDDING_PROVIDER=local npm run kb:ingest
npm run kb:search -- "What indoor attractions can I visit?"

# MCP — connects both servers, calls every tool, asserts the failure path
npm run mcp:check

# Index health
npm run kb:stats

# Unit tests
npm test
```

`kb:search` prints the fused rank, the raw cosine and the BM25 contribution for every chunk, so a
retrieval problem can be told apart from a generation problem without spending a token.
`mcp:check` exercises the full client↔server path including a deliberately invalid currency, to
prove failures degrade cleanly.

**Local embeddings.** `EMBEDDING_PROVIDER=local` runs `all-MiniLM-L6-v2` in-process through ONNX
Runtime. No key, no quota; weights (~90 MB) download once and cache. This is the default when
`LLM_PROVIDER` is `anthropic` or `groq`, because neither vendor sells an embedding endpoint.

**Local generation.** `OPENAI_BASE_URL` points the OpenAI-compatible path at any other host, so the
whole assistant runs against Ollama or LM Studio with no code change:

```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama          # any non-empty string
LLM_MODEL=qwen2.5:7b           # must support tool calling
```

---

## Architecture

```
                      ┌──────────────────────────────────────┐
  browser  ──POST──▶  │  /api/chat  (Next.js route handler)  │
       ◀──NDJSON────  │  streams status/retrieval/tool/token │
                      └────────────────┬─────────────────────┘
                                       │
                              ┌────────▼─────────┐
                              │   orchestrator   │  explicit agent loop
                              └───┬────┬─────┬───┘
              ┌───────────────────┘    │     └──────────────────┐
              │                        │                        │
     ┌────────▼────────┐      ┌────────▼────────┐      ┌────────▼────────┐
     │ hybrid retrieval│      │   chat model    │      │  MCP client     │
     │ cosine + BM25   │      │ LangChain       │      │ stdio, 2 servers│
     │   ↓ RRF fusion  │      │ openai/anthropic│      │      ↓          │
     │ JSON vector idx │      │ groq/google     │      │ weather currency│
     └────────┬────────┘      └─────────────────┘      └────────┬────────┘
              │                                                  │
     data/index/singapore.index.json              Open-Meteo · Frankfurter
```

### Request lifecycle

1. **Session** — the turn is attached to a session; prior messages and pinned preferences load.
2. **Retrieve** — the question is embedded and run through both rankers; results are fused by
   reciprocal rank. If the closest chunk's cosine is below the coverage floor, the turn is marked
   as a knowledge gap and the prompt forbids answering destination facts from model memory.
3. **Assemble** — system policy prompt, prior turns, then a context block holding the retrieved
   passages, the numbered source list and the carried preferences.
4. **Loop** — the model is called with the MCP tool definitions bound. If it emits tool calls they
   run *in parallel*, results are appended as tool messages, and the loop continues. The final
   round drops the tools so the model is forced to answer rather than loop to the cap.
5. **Stream** — every stage emits an NDJSON event: `status`, `retrieval`, `tool_call`,
   `tool_result`, `token`, `done`, `error`. The UI renders retrieval and tool activity live.
6. **Record** — the answer is appended to the session; provenance is returned with `done`.

Provenance is collected as the turn runs rather than reconstructed from callbacks afterwards, which
is why the loop is written out instead of delegated to a prebuilt agent executor: knowing exactly
which passages and which tool results fed an answer is the product here, not a debugging aid.

---

## Knowledge base

15 documents from **four distinct resources**, all metadata-tagged with source title, URL,
publisher, licence and retrieval date.

| Resource | Documents | Licence | How obtained |
| --- | --- | --- | --- |
| [Wikivoyage Singapore](https://en.wikivoyage.org/wiki/Singapore) + 8 district guides | 9 | CC BY-SA 4.0 | `npm run kb:fetch` |
| [Wikipedia](https://en.wikipedia.org/wiki/Transport_in_Singapore) — Transport, Tourism, Culture | 3 | CC BY-SA 4.0 | `npm run kb:fetch` |
| [Visit Singapore](https://www.visitsingapore.com/) — travel essentials, itineraries, things to do | 3 | Summarised in our own words | Committed to `knowledge-base/curated/` |

Coverage: major attractions and neighbourhoods, local transport, cultural and practical guidance,
food and local experiences, sample itineraries, and indoor/outdoor activity suggestions — the six
areas the brief asks for.

**On reuse terms.** Wikivoyage and Wikipedia publish under CC BY-SA 4.0, which permits
redistribution with attribution, so their extracted text is committed here and every citation shows
the source title, publisher and link. Visit Singapore's pages are not openly licensed, so nothing
from them is reproduced: those three documents are factual summaries written for this project, with
the source URL retained as metadata. `npm run kb:fetch` never touches `knowledge-base/curated/`.

Documents are plain markdown with a front-matter block:

```markdown
---
id: wikivoyage-singapore-chinatown
title: "Wikivoyage: Singapore — Chinatown"
url: https://en.wikivoyage.org/wiki/Singapore/Chinatown
publisher: Wikivoyage
license: CC BY-SA 4.0
retrievedAt: 2026-09-12
topics: [neighbourhood, culture, food, temples, shopping]
---
```

Adding a source is: drop a markdown file with that header into `knowledge-base/`, re-run
`npm run kb:ingest`. Nothing else needs to change.

---

## RAG workflow

**1. Load.** `kb:fetch` pulls MediaWiki `extracts` (plain text with `== heading ==` markers, far
more reliable to convert than rendered HTML) and rewrites them as markdown, dropping navigation
sections — "See also", "References", "External links" — that would otherwise win retrieval slots on
keyword overlap while containing no answer.

**2. Chunk.** Heading-aware splitting: markdown is cut on ATX headings, and each chunk carries its
full heading path (`Sentosa > See > S.E.A. Aquarium`). Paragraphs are packed greedily to ~320
estimated tokens, capped at 480, with a short overlap for continuity. Oversized paragraphs split on
sentence boundaries. Chunks under 40 tokens merge into their neighbour; anything still under 20
tokens is dropped as a stub — the corpus is full of one-line fragments like a bare
`visitsingapore.com` under a "Visitor information" heading, which carry no answer but score well
lexically because their heading is short and topical.

**3. Embed.** Each chunk is embedded with its heading path prefixed, so a mid-document paragraph
about opening hours knows it belongs to a particular attraction. Batched at 64.

**4. Store.** A single JSON file (`data/index/singapore.index.json`, ~4.4 MB) holding documents,
chunks and vectors. Loaded once per process, vectors L2-normalised at load so search is a plain dot
product.

**5. Retrieve.** Hybrid, fused by **reciprocal rank fusion** (k=60):

- *Dense* — cosine over the full index. Exhaustive rather than approximate: 505 chunks × 384
  dimensions is a sub-millisecond scan, and the result is exact.
- *Lexical* — BM25 (k1=1.2, b=0.75) with heading terms weighted double. Dense retrieval alone is
  weak on the proper nouns travellers actually type — "Haw Par Villa", "EZ-Link", "Jewel Changi" —
  and exact term matching recovers them.

RRF is used instead of a weighted score blend because the two rankers produce scores on
incomparable scales (bounded cosine vs. unbounded BM25), and a blend weight tuned per corpus is
exactly the kind of hidden constant that rots.

Results are then capped per source document, because a single long article (the Wikivoyage
Singapore page is a third of the corpus) otherwise owns every slot, leaving the reader with one
link instead of four.

**6. Ground.** Retrieved chunks are rendered into a `KNOWLEDGE BASE` block with `[S1]`, `[S2]`
markers; chunks from the same document collapse onto one marker, so answers cite documents rather
than offsets.

**7. Cite.** Markers resolve to title, publisher, section path and URL in the sidebar, alongside
the relevance score.

### Knowing when the corpus does not cover a question

Coverage is judged on the **raw cosine of the closest chunk**, never on the fused score. RRF is
ordinal — whatever ranks first scores 1.0 however irrelevant it is — so a fused-score threshold
would pass every query ever asked. Measured on this corpus with `all-MiniLM-L6-v2`:

| Query type | Best cosine |
| --- | --- |
| Genuine destination questions | 0.43 – 0.75 |
| Off-topic ("visa fee for Reykjavik", "offside rule") | 0.08 – 0.35 |
| Travel-shaped but wrong city ("top attractions in Buenos Aires") | 0.35 |

`RETRIEVAL_MIN_SIMILARITY` defaults to **0.38**, which separates them cleanly. Below it the prompt
switches to a gap instruction: state that the guides do not cover it, offer the closest topic that
is covered, and do not answer destination facts from memory. Tools remain available, so
*"convert 200 SGD to INR"* is still answered — from the tool, without claiming corpus grounding.

The threshold is embedding-model dependent. After switching models, re-measure with
`npm run kb:search`, which prints the best cosine for any query.

---

## MCP tools

Two MCP servers, each a standalone process speaking JSON-RPC over stdio, built with
`@modelcontextprotocol/sdk`. Both upstreams are keyless, so the tool half of the application works
from a fresh clone.

### `travel-weather` — Open-Meteo

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_current_weather` | `location` | Temperature, feels-like, humidity, wind, precipitation |
| `get_weather_forecast` | `location`, `days` (1–7) | Per day: conditions, high/low, rainfall, rain probability, sunrise/sunset, and an outdoor-suitability verdict |

Geocoding and forecast are separate upstream calls; geocode results are memoised. WMO weather codes
are mapped to plain descriptions, and each forecast day carries an explicit `outlook`
("wet — plan indoor options", "dry — good for outdoor activities") so the model has a defensible
basis for swapping an outdoor block rather than inventing one.

### `travel-currency` — Frankfurter (ECB reference rates)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `convert_currency` | `amount`, `from`, `to` | Converted amount, unit rate, rate publication date |
| `list_supported_currencies` | — | 30 ISO 4217 codes with full names |

The rate's publication date is always returned. ECB rates are published once per working day, so a
weekend conversion is Friday's rate — stated rather than hidden, because a traveller comparing it
against an airport board will otherwise think the tool is broken.

### Client integration

`src/lib/mcp/client.ts` spawns each server, performs the MCP handshake, calls `tools/list`, and
adapts the returned JSON Schemas into LangChain tool definitions bound to the model. Specifically:

- **Connection reuse** — servers are started once per process, not per request; a global handle
  survives Next.js hot reloads so editing a file does not leak child processes.
- **Degradation** — a server that fails to start is recorded and skipped. The remaining tools still
  work, and the system prompt is told which server is missing so the model can say what it could
  not check.
- **Failure as data** — a thrown upstream error, a protocol error or a timeout all come back as a
  *failed* `ToolInvocation`, which is handed to the model as a tool result. The model explains the
  gap instead of substituting a plausible-looking number.
- **Name collisions** — if two servers advertise the same tool name, the later one is prefixed with
  its server id.
- **Parallel execution** — tool calls issued in one round run concurrently, so a three-day forecast
  plus a currency conversion is one wait, not two.

### Using other MCP servers

Copy `mcp.config.example.json` to `mcp.config.json`. It uses the same `mcpServers` shape as Claude
Desktop and other MCP hosts, so any third-party server can be dropped in and its tools are offered
to the model with no application change.

### No build step

Both servers are plain TypeScript executed directly by `node`, using Node 24's native type
stripping. This constrains them to erasable syntax — no enums, no parameter properties — in
exchange for there being nothing between editing a tool and calling it.

---

## Prompt and context strategy

Full rationale in [docs/PROMPT_STRATEGY.md](docs/PROMPT_STRATEGY.md); the short version:

The system prompt is written as a **policy document, not a persona**. Its central move is naming
three sources of truth and forbidding them from blurring:

1. **Knowledge base** — the only permitted source for destination facts, cited as `[S1]`.
2. **Live tools** — the only permitted source for weather and exchange rates. The model may not
   state a temperature or a rate that did not come from a tool result in that conversation.
3. **Its own planning** — sequencing, pacing, pairing an activity to the weather. Genuinely useful,
   and explicitly a *suggestion*, phrased so a reader can tell it apart from 1 and 2.

Tool policy is stated as a rule with its converse, because the brief requires both directions:
call a tool for live information; answer what-to-see, where-to-stay, how-to-get-around and
what-to-eat from the corpus and **never** from a tool.

Honesty rules are concrete rather than exhortative: do not attach a citation to a statement the
cited passage does not support; prefer "the guides do not say" to a confident guess; when a tool
fails, name the part of the answer that could not be verified and answer the rest.

**Context assembly.** Retrieved passages go in a separate human message ahead of the question, so
they cannot be mistaken for something the user typed, and so the block can be dropped once the turn
ends rather than accumulating.

**Preferences** are extracted with rules, not with an extra LLM call. Budget, party, trip length,
dietary needs, mobility, pace and interests are stated in a small number of predictable phrasings;
a rule pass costs nothing, is deterministic, and cannot hallucinate a constraint the traveller
never mentioned. Later turns supersede earlier ones; interests accumulate. The trade-off is recall
on unusual phrasing — and since the transcript is still in context, a missed rule degrades to "not
pinned", not "forgotten".

---

## Configuration

All variables live in `.env.local`; see [`.env.example`](.env.example) for the annotated set.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `openai` | `openai` \| `anthropic` \| `groq` \| `google` |
| `LLM_MODEL` | per provider | Must support tool calling |
| `OPENAI_BASE_URL` | — | Point the OpenAI-compatible path at Ollama, LM Studio, vLLM, OpenRouter, Azure |
| `EMBEDDING_PROVIDER` | inferred | `openai` \| `google` \| `local` |
| `RETRIEVAL_TOP_K` | `6` | Chunks passed to the model |
| `RETRIEVAL_MIN_SIMILARITY` | `0.38` | Cosine floor for corpus coverage |
| `MAX_TOOL_ITERATIONS` | `4` | Model/tool round trips before an answer is forced |
| `MCP_TOOL_TIMEOUT_MS` | `20000` | Per tool call |
| `DESTINATION` | `Singapore` | Used in prompts and UI copy |

Environment parsing is schema-validated at startup, so a typo fails immediately with the offending
key named rather than surfacing as `undefined` three layers down.

**Changing embedding provider requires re-running `npm run kb:ingest`** — the index and the query
must be embedded by the same model. The index records what built it, and the loader refuses a
dimension mismatch with an actionable message rather than returning nonsense scores.

---

## Commands

| Command | What it does | Needs a key |
| --- | --- | --- |
| `npm run dev` | Development server | LLM only |
| `npm run build` / `npm start` | Production build and serve | LLM only |
| `npm run kb:fetch` | Re-download source documents | No |
| `npm run kb:ingest` | Chunk + embed into `data/index` | Embeddings |
| `npm run kb:search -- "…"` | Retrieval probe with per-ranker scores | Embeddings |
| `npm run kb:stats` | Index composition and chunk-size distribution | No |
| `npm run mcp:check` | Connect both servers, call every tool, assert failures | No |
| `npm run ask` | Terminal chat client | LLM |
| `npm test` | Unit tests (30) | No |
| `npm run typecheck` / `npm run lint` | Static checks | No |

With `EMBEDDING_PROVIDER=local`, every "needs a key" cell above reading *Embeddings* becomes *No*.

---

## Project layout

```
ai-travel-assistant/
├── knowledge-base/
│   ├── singapore/            fetched documents (Wikivoyage, Wikipedia)
│   └── curated/              hand-written summaries with source attribution
├── mcp-servers/src/
│   ├── weather.ts            MCP server — Open-Meteo
│   ├── currency.ts           MCP server — Frankfurter
│   └── http.ts               shared fetch with timeout + bounded retry
├── scripts/
│   ├── fetch-sources.ts      rebuild the corpus from MediaWiki
│   ├── ingest.ts             chunk + embed + write the index
│   ├── search.ts             retrieval probe
│   ├── index-stats.ts        index composition report
│   ├── mcp-check.ts          MCP end-to-end probe
│   └── ask.ts                terminal client
├── src/
│   ├── app/
│   │   ├── api/chat/         NDJSON streaming endpoint
│   │   ├── api/health/       readiness probe
│   │   └── page.tsx
│   ├── components/           chat UI, provenance panel, status bar
│   └── lib/
│       ├── agent/            prompts + orchestration loop
│       ├── config/           schema-validated env, paths
│       ├── embeddings/       provider registry + local ONNX embeddings
│       ├── llm/              provider registry
│       ├── mcp/              stdio client, server registry
│       ├── rag/              chunker, vector store, BM25, retriever
│       └── session/          conversation store, preference extraction
├── tests/                    chunker, retrieval, preference tests
└── docs/                     architecture, prompt strategy, samples, demo
```

---

## Design decisions

**A purpose-built vector store instead of FAISS or Chroma.** `faiss-node` needs a native build step
and Chroma needs a separate server process, both of which are real friction for a reviewer cloning
this repository. At 505 chunks an exhaustive cosine scan is *exact* and takes under a millisecond,
so an approximate index would trade correctness for a speed-up that is not needed. The store's
interface is deliberately the small one an ANN backend would also satisfy, so swapping in Chroma or
FAISS later is a change to one file.

**Hybrid retrieval rather than dense-only.** Travel questions are dense with proper nouns that an
embedding model has not specialised on. BM25 recovers exactly those, and RRF fuses the rankings
without a tuned blend weight.

**An explicit agent loop rather than a prebuilt executor.** The assignment requires the answer to
identify the sources and tool results used. Collecting that as the turn runs is strictly better than
reconstructing it from callbacks, and the loop is ~60 readable lines.

**Retrieval before the model, not as a tool.** Guarantees every destination answer is grounded, and
makes the gap check possible: the assistant knows the corpus does not cover something *before* the
model starts writing. The cost is one embedding call on turns that turn out to be pure tool
questions. Exposing retrieval as a tool would be the alternative — it would let the model re-query
after seeing tool results, at the cost of ungrounded answers whenever it chose not to call it.

**Rule-based preference extraction rather than an LLM pass.** Deterministic, free, and cannot
invent a constraint the traveller never stated.

**NDJSON rather than SSE.** The client is a plain `fetch` reader; NDJSON needs no framing ceremony
and stays readable under `curl`, which is how this endpoint actually gets debugged.

---

## Limitations

- **Single-node session store.** Conversations live in process memory with a 2-hour TTL. The
  interface is narrow enough that swapping in Redis is a change to `src/lib/session/store.ts` alone.
- **One retrieval per turn.** The model cannot re-query the corpus after seeing tool results.
- **Rebuild on corpus change.** The index is read once per process; changing documents needs
  `kb:ingest` and a restart.
- **Rate freshness.** ECB rates are daily, not live market rates. Fine for trip budgeting, not for
  currency trading — and the response always says which day's rate it used.
- **Preference recall.** Rules cover common phrasings, not all of them.
- **Weather beyond 7 days.** Open-Meteo's free forecast horizon, so "adjust my trip three weeks
  out" gets an explicit "I can't check that far ahead" rather than a guess.
- **Singapore only.** The pipeline is destination-agnostic — swap the corpus, set `DESTINATION`,
  re-ingest — but only Singapore is indexed here.

---

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map and data flow
- [docs/PROMPT_STRATEGY.md](docs/PROMPT_STRATEGY.md) — every prompt rule and the failure it prevents
- [docs/SAMPLE_QUESTIONS.md](docs/SAMPLE_QUESTIONS.md) — worked questions and expected behaviour
- [docs/DEMO.md](docs/DEMO.md) — a demonstration script covering RAG, MCP, combined and multi-turn

## Licence

Application code: MIT (see [LICENSE](LICENSE)).
Knowledge-base content retains its original licences — see
[knowledge-base/README.md](knowledge-base/README.md).
