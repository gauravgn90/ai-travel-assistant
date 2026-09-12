# Demonstration script

A ten-minute walkthrough covering the four things the brief asks a demonstration to show: RAG, MCP,
a combined response, and conversational context.

Setup before recording:

```bash
npm install
cp .env.example .env.local     # set LLM_PROVIDER + the matching key
npm run kb:ingest              # if data/index/ is absent
npm run dev
```

Open `http://localhost:3000`. The status bar should show four green dots: model, index, MCP tools,
embeddings. If any is red it names what to fix.

---

## 0 · The pipeline, before touching the UI (1 min)

Worth showing first, because it makes the rest legible.

```bash
npm run kb:stats
```

15 documents, ~505 chunks, 384 dimensions, and the chunk-size distribution.

```bash
npm run mcp:check
```

Both MCP servers start, four tools are discovered, six probes run — including one deliberate failure
that returns cleanly rather than throwing.

> Two of the three subsystems need no API key at all. Retrieval embeds locally and both tool
> upstreams are keyless, so this much is verifiable from a fresh clone.

---

## 1 · RAG — a grounded destination answer (2 min)

Ask:

> **What are the must-visit attractions in Singapore?**

Point out, in order:

1. The status line: *Searching the knowledge base*.
2. The sidebar filling with four sources **before** any text appears — retrieval precedes
   generation, so the answer cannot be ungrounded.
3. `[S1]`, `[S2]` markers in the answer resolving to titles, section paths and clickable URLs.
4. The **Live data (MCP)** panel: *"No tool was needed for this answer"*. Nothing here depends on
   today's weather or rates, and the prompt forbids reaching for a tool.

Then show the same query's internals:

```bash
EMBEDDING_PROVIDER=local npm run kb:search -- "What are the must-visit attractions in Singapore?"
```

Per chunk: the fused rank, the raw cosine and the BM25 contribution. Note the rows where cosine is
0.000 but BM25 is high — proper-noun matches that dense retrieval alone would have missed.

---

## 2 · Knowledge gaps (1 min)

Ask:

> **What are the top attractions in Buenos Aires?**

The assistant says the guides do not cover it and offers what it can help with. It does not answer
from model memory, even though the model certainly knows Buenos Aires.

Show why:

```bash
npm run kb:search -- "What are the top attractions in Buenos Aires?"
# Best cosine: 0.350 — below the 0.38 floor
```

> Coverage is judged on raw cosine, never on the fused rank score. Reciprocal rank fusion is
> ordinal — whatever ranks first scores 1.0 however irrelevant it is — so a fused-score threshold
> would pass every query ever asked.

---

## 3 · MCP — live data (2 min)

Ask:

> **What is the forecast for the next three days?**

Show the tool trace appearing live: `get_weather_forecast(location: "Singapore", days: 3)`, then
resolving with a duration. Expand it to show the returned text, including the per-day
indoor/outdoor verdict the *tool* computed.

Then:

> **I have a budget of INR 60,000 — how much is that in Singapore dollars?**

`convert_currency` fires. The answer states the rate **and its publication date**, because ECB rates
are daily and a weekend conversion is Friday's rate.

Optional, to show failure handling:

> **Convert 100 Zimbabwean dollars to SGD.**

The tool returns a clean error listing the supported codes; the assistant reports what it could not
do instead of inventing a rate.

---

## 4 · Combined RAG + MCP — the required scenario (3 min)

The centrepiece. Ask:

> **Create a three-day Singapore itinerary for next week and adjust it according to the weather
> forecast.**

Narrate the trace as it happens:

1. Retrieval fills the sidebar — itineraries, indoor/outdoor activities, transport.
2. `get_weather_forecast` fires. Retrieval alone could not have answered this.
3. The answer streams as a day-by-day plan.

Then read the answer against its three sources of truth:

| In the answer | Where it came from |
| --- | --- |
| "Gardens by the Bay, Cloud Forest conservatory `[S1]`" | Knowledge base — cited |
| "the forecast shows a 94% chance of rain on day one" | MCP tool — attributed |
| "so I'd move the outdoor garden block to day two" | The assistant's own planning — a suggestion |

The sidebar shows the **RAG + MCP** badge and the summary line naming how many sources and how many
tool results fed the answer.

> The tool calls ran in parallel — the trace shows 1.9 s and 0.8 s overlapping, not summed.

---

## 5 · Conversational context (1 min)

Without restating anything, follow up:

> **What about indoor options for day two?**

The answer stays on day two of the same itinerary, still respects the budget, and — if the first
question mentioned children — still recommends child-appropriate venues.

Then push further:

> **And is that still within my budget?**

The budget from three turns ago is still pinned.

> Preferences are extracted by rules, not by an extra LLM call, and stored separately from the
> transcript. That is deliberate: the transcript is trimmed to twelve messages, but a budget stated
> in turn one is still in the prompt at turn twenty.

---

## 6 · Provider portability (30 s)

```bash
# .env.local
LLM_PROVIDER=groq
GROQ_API_KEY=...
```

Restart. The status bar shows the new provider; everything else is unchanged. OpenAI, Anthropic,
Groq and Google are all supported behind one variable.

If Anthropic or Groq is selected, embeddings fall back to the local ONNX model automatically —
neither vendor sells an embedding endpoint.

Worth mentioning: `OPENAI_BASE_URL` points the OpenAI-compatible path at Ollama or LM Studio, so the
whole assistant runs with no vendor account at all.

---

## Closing points

- **Four resources, 15 documents**, each carrying source title, URL, publisher and licence.
  Wikivoyage and Wikipedia are CC BY-SA and committed as fetched; the Visit Singapore material is
  summarised in our own words with the source link retained, because those pages are not openly
  licensed.
- **Two MCP servers** over stdio using the official SDK, with a Claude-Desktop-compatible config
  file so third-party servers drop straight in.
- **Every failure path is a designed path**: missing key, unbuilt index, dimension mismatch, dead
  server, failed tool call, uncovered question — each reports what happened and what to do, and only
  the ones that must fail the turn do.

---

## If something goes wrong on the day

| Symptom | Fix |
| --- | --- |
| Status bar: "Index not built" | `npm run kb:ingest` |
| Status bar: "No MCP servers connected" | `npm run mcp:check` for the underlying error |
| Status bar: "No ..._API_KEY" | Key missing from `.env.local`, or the server needs a restart |
| Dimension-mismatch error | `EMBEDDING_PROVIDER` changed since ingest — re-run `npm run kb:ingest` |
| Quota exhausted mid-demo | Switch `LLM_PROVIDER`, or fall back to `npm run kb:search` and `npm run mcp:check`, which need no LLM |
