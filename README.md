# Singapore Travel Assistant

A travel planning assistant for Singapore. Destination questions are answered from a local
knowledge base of travel guides; weather and currency questions go out to MCP tool servers. A
question that needs both gets both, and the answer says which part came from where.

Built with Next.js, LangChain, a local sentence-transformer embedding model and a FAISS index.
The chat model is pluggable: Google Gemini, OpenAI, Anthropic or Groq.

## Setup

Requires Node 24 or newer (it runs the TypeScript tool servers and the ingest script directly).

```bash
npm install
cp .env.example .env.local     # pick a provider and set its key
npm run fetch                  # refresh the knowledge base from the wikis (optional)
npm run ingest                 # build the vector index, about 30 seconds
npm run dev                    # http://localhost:3000
```

The repository ships with the knowledge base already fetched, so `npm run fetch` is only needed to
pull the latest version of the source pages.

`npm run ingest` downloads the embedding model on first run (about 90 MB) and writes
`data/index.faiss` and `data/chunks.json`. Re-run it after changing anything under
`knowledge-base/`.

FAISS and the ONNX runtime are native modules that need their install scripts to run. npm only
runs scripts for packages listed in the `allowScripts` field of `package.json`, which already names
the four that need it.

### Docker

```bash
docker compose up --build
```

Serves on http://localhost:3000, and needs nothing installed on the host but Docker - not even
Node.

#### Credentials

Keys stay in `.env.local` on the host and are handed to the container at run time. The file is in
both `.gitignore` and `.dockerignore`, so it is never committed and never copied into an image.
`compose.yaml` reads it:

```yaml
env_file:
  - path: .env.local
    required: false
```

`required: false` means the container still starts without the file - it answers from the knowledge
base and reports a missing key only when a question reaches the model.

Without Compose the same file works as `docker run --env-file`, but that parser is stricter: it
keeps surrounding quotes and trailing `# comments` as part of the value, where Compose strips both.
So write `GOOGLE_API_KEY=AIza...` with nothing after it, as `.env.example` does, and either command
works:

```bash
docker run --env-file .env.local -p 3000:3000 travel-assistant
```

To override one value without editing the file, pass it after the env file - the later flag wins:

```bash
docker run --env-file .env.local -e LLM_PROVIDER=groq -p 3000:3000 travel-assistant
```

Environment variables are visible to anyone who can run `docker inspect` on the container. That is
fine for a local demo; a deployment should use its platform's secret store instead.

#### Changing a key or a provider

No rebuild. All four provider SDKs are ordinary dependencies, so they are already in the image;
only the environment decides which one is used. But the values are read when a container is
*created*, not when it starts, so `restart` is not enough:

```bash
docker compose up -d        # recreates the container with the new values
docker compose restart      # does NOT - it restarts the old container, old values and all
```

One trap when switching provider: `LLM_MODEL` is not provider-specific. If it is set to a Gemini
model and you switch `LLM_PROVIDER` to `groq`, that model name is sent to Groq and the call fails.
Clear `LLM_MODEL` to fall back to the provider's default, or set a model that provider serves.

A rebuild (`docker compose up --build`) is only needed when the code, the dependencies or anything
under `knowledge-base/` changes.

The image runs `npm run ingest` at build time, so the FAISS index and the embedding model are
already inside it: the container is ready in under a second and needs no network for retrieval.
Only the MCP tools and the chat model reach out. After changing anything under `knowledge-base/`
- including a `npm run fetch` - rebuild with `docker compose up --build` to pick it up.

It is a Debian image rather than Alpine, because FAISS and ONNX Runtime publish prebuilt binaries
for glibc and none for musl. The build drops the ONNX binaries for other platforms and for GPUs,
which is most of the image: the embedding model runs on CPU.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `google` | One of `google`, `openai`, `anthropic`, `groq`. |
| `LLM_MODEL` | per provider | Overrides the default below. Must support function calling. |
| `GOOGLE_API_KEY` etc. | – | Only the key for the selected provider is needed. |
| `DESTINATION` | `Singapore` | Shown in the UI and the prompt. |
| `RETRIEVAL_TOP_K` | `6` | Passages given to the model per question. |
| `RETRIEVAL_MIN_SCORE` | `0.38` | Cosine floor below which the corpus counts as not covering the question. |

| Provider | Default model | Key |
| --- | --- | --- |
| `google` | `gemini-3.5-flash` | `GOOGLE_API_KEY` |
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| `groq` | `openai/gpt-oss-120b` | `GROQ_API_KEY` |

The provider SDKs are imported lazily in `src/lib/model.ts`, so a deployment only loads the one it
uses. Everything downstream drives a LangChain `BaseChatModel`, so switching provider is a
configuration change and never a code change.

## Architecture

```
Browser ──POST /api/chat──▶ agent.ts
                              ├─▶ retriever.ts ─▶ FAISS index  (destination facts)
                              ├─▶ mcp.ts ───────▶ weather / currency servers  (live data)
                              └─▶ the chat model via LangChain
                            ◀── newline-delimited JSON: progress steps, sources, answer tokens
```

One turn runs in `src/lib/agent.ts`:

1. Embed the question and search the FAISS index. The citations are streamed to the browser
   immediately, before the model has written anything.
2. Ask the model with the retrieved passages, the conversation so far, and the MCP tools bound as
   function declarations.
3. If the model calls tools, run them in parallel, stream each result to the browser, feed them
   back and ask again. Up to three rounds, after which the tools are unbound so the model has to
   answer with what it has.
4. Store the question and the answer against the session id for the next turn.

The turn loop is written out rather than delegated to a prebuilt agent executor because the UI has
to report exactly which passages and which tool results produced the answer.

### Progress

A turn can take several seconds, most of it spent waiting on the model or on a tool, so the browser
is told what is happening as it happens. Each phase is a `step` event with a stable id, sent twice -
once when it starts and once when it finishes:

```
✓ Found 5 sources in the knowledge base
✓ Thinking
✓ Called get_weather_forecast (location: Singapore, days: 3)
✓ Called convert_currency (amount: 60000, from: INR, to: SGD)
✓ Reading the tool results
```

While a step is running it carries a spinner and reads `Calling …`; when it lands the same line is
replaced in place with `Called …` and a tick. Because the id is stable the browser replaces the line
rather than appending a second one, so it keeps no state machine of its own. A tool that fails says
so on its own line. The finished list stays under the answer as a record of what the answer was
built from - which is also how the interface distinguishes live tool data from knowledge-base facts.

### When something breaks

A provider's raw error is noise to whoever is using the assistant, and it carries endpoint and
request detail that does not belong on screen. So a failure mid-turn is logged in full on the server
and reported to the browser as one sentence: **Agent is down. Please try again in a moment.**

Setup problems are the exception. A missing API key, an unbuilt index or a model that cannot call
tools all raise a `SetupError`, and those messages are shown as written, because they are addressed
to whoever is running the app and say exactly what to fix:

```
GOOGLE_API_KEY is not set, but LLM_PROVIDER is "google". Add the key to .env.local and
restart, or switch LLM_PROVIDER to a provider you have a key for.
```

Either way the activity log settles - no step is left spinning - and any sources already retrieved
stay on screen.

### Files

```
src/lib/
  agent.ts            the turn: retrieve, call the model, run tools, stream
  model.ts            chat model for the configured provider
  retriever.ts        vector search, per-document capping, citation numbering
  vector-store.ts     FAISS index: build, load, search
  embeddings.ts       all-MiniLM-L6-v2 in-process through ONNX Runtime
  knowledge-base.ts   markdown loading, front matter, chunking
  mcp.ts              stdio client for the two tool servers
  prompt.ts           system prompt and the per-question context block
mcp-servers/          the two MCP tool servers
scripts/fetch.ts      refreshes the wiki documents
scripts/ingest.ts     builds the index
knowledge-base/       15 markdown documents
```

## Knowledge base

15 markdown documents from three public sources, covering attractions and neighbourhoods,
transport, culture and practical guidance, food, sample itineraries, and indoor/outdoor activities.

| Source | Documents |
| --- | --- |
| [Wikivoyage Singapore](https://en.wikivoyage.org/wiki/Singapore) | 9 - the main guide plus Chinatown, Little India, Bugis, Orchard, Riverside, Sentosa, East Coast, North and West |
| Wikipedia - [Tourism](https://en.wikipedia.org/wiki/Tourism_in_Singapore), [Transport](https://en.wikipedia.org/wiki/Transport_in_Singapore), [Culture](https://en.wikipedia.org/wiki/Culture_of_Singapore) | 3 |
| [Visit Singapore](https://www.visitsingapore.com/) - essentials, itineraries, things to do | 3 |

Every document starts with a front matter block naming its title, URL and publisher. That block is
the citation: it travels with each chunk through indexing and retrieval, so an answer can always
name and link its source.

```markdown
---
id: wikivoyage-singapore-chinatown
title: "Wikivoyage: Singapore - Chinatown"
url: https://en.wikivoyage.org/wiki/Singapore/Chinatown
publisher: Wikivoyage
retrievedAt: 2026-09-16
---
```

### Keeping it current

```bash
npm run fetch && npm run ingest
```

`npm run fetch` re-downloads the twelve Wikivoyage and Wikipedia pages and rewrites them under
`knowledge-base/singapore/`. Both sites expose a plain-text extract of a page through the same
MediaWiki endpoint, so it is one request per page - no HTML scraping, and no parser to keep in step
with a site redesign. Navigation sections (references, see also, external links and the like) are
dropped, because left in they win retrieval slots on keyword overlap and answer nothing.

MediaWiki rate-limits bursts, so the script serialises its requests and backs off on a 429. If a
page still fails, it says which one and leaves the copy already on disk alone, so a partial refresh
never empties the corpus. The three hand-written documents under `knowledge-base/curated/` are never
touched.

Re-run `npm run ingest` afterwards - the index is built from whatever is on disk at that moment.

### RAG workflow

Documents are split on markdown headings, then the paragraphs of each section are packed to about
1,200 characters. Splitting on headings rather than a fixed window means a chunk is a topic, and it
carries its heading path - that path is prefixed to the text before embedding, which gives a
mid-document paragraph the context it would otherwise lack.

Chunks are embedded with `all-MiniLM-L6-v2` running in-process through ONNX Runtime. It needs no API
key and no quota, so indexing and retrieval work offline and the index stays valid regardless of
which chat model is configured. The 384-dimension vectors are stored in a FAISS `IndexFlatIP`;
because the vectors are L2-normalised, inner product is cosine similarity.

At query time the question is embedded and the index searched. Two guards shape the result:

- **Coverage.** If the closest chunk scores below `RETRIEVAL_MIN_SCORE`, the corpus is treated as
  not covering the question. The prompt then forbids answering destination facts from memory.
- **Per-document cap.** At most three chunks from any one document. The Wikivoyage Singapore page
  is roughly a third of the corpus and would otherwise take every slot, leaving the answer with a
  single source to cite.

Citations are numbered per document rather than per chunk, so two passages from one guide are one
source to the reader and one link to click.

## MCP tools

Two stdio MCP servers, spawned once per process and reused. Both use free APIs that need no key.

| Server | Tool | Backed by |
| --- | --- | --- |
| `weather` | `get_current_weather` | Open-Meteo |
| `weather` | `get_weather_forecast` - up to 7 days, with an indoor/outdoor call per day | Open-Meteo |
| `currency` | `convert_currency` | Frankfurter (European Central Bank reference rates) |

The model picks the tool; the servers are not called for anything the knowledge base already covers.
The forecast tool returns a plain indoor-or-outdoor verdict per day rather than raw numbers, because
that is the judgement the itinerary actually needs.

Failures are contained. A server that will not start is recorded and skipped, and the prompt tells
the model to say what it cannot check. A tool that errors returns the error text as its result, so
the model explains the gap instead of inventing a number. MCP servers publish JSON Schema derived
from Zod, and Gemini rejects any keyword outside its own subset, so `mcp.ts` narrows every schema to
that subset before binding - one code path rather than a branch per provider, and it costs the
other three nothing.

## Prompt strategy

The system prompt in `src/lib/prompt.ts` is written as a policy, not a persona. Its core is that the
assistant has exactly three sources and must keep them visibly apart:

1. **Knowledge base** - the retrieved passages, labelled `[S1]`, `[S2]`. The only source for
   destination facts, cited inline.
2. **Tools** - the only source for anything that changes daily. The answer attributes these in the
   text: "the forecast shows", "at today's published rate".
3. **The model's own planning** - ordering, pacing, matching an activity to the weather. Useful, and
   the assistant should do it, but phrased as a suggestion so a reader can tell it from the first two.

Retrieved passages are sent as a separate message ahead of the question, so they cannot be mistaken
for something the traveller typed, and so they do not accumulate in the conversation history - only
the plain question and answer are kept, trimmed to the last ten messages. That is what carries a
stated budget, party or set of dates across turns without asking again.

The remaining rules each exist to prevent a specific failure: never attach a citation marker to a
claim the passage does not support; never state a temperature or a rate that no tool returned; say
plainly when the guides do not cover something rather than filling the gap from memory; resolve
relative dates before calling a tool.

## Sample questions

Knowledge base only:

- What are the must-visit attractions in Singapore?
- Which neighbourhoods are suitable for cultural experiences?
- How can a tourist travel around Singapore?
- What indoor attractions can I visit?

MCP only:

- What is the weather in Singapore?
- What is the forecast for the next three days?
- Convert INR 50,000 to SGD.

Both:

- Create a three-day Singapore itinerary for next week and adjust it to the weather forecast.
- I have a budget of INR 60,000. Convert it to SGD and suggest a three-day itinerary.
- Suggest outdoor attractions and replace them with indoor options if rain is expected.

Multi-turn - the second question relies on the first:

- "I'm travelling with two young children and have four days." -> "Now plan the four days around the
  forecast."
