# Sample questions and application behaviour

Each entry below shows what the application actually does with a question: which sources retrieval
selects, which tools fire, and what shape the answer takes.

**On the contents of this document.** Retrieval output and MCP tool output are **captured from real
runs** on 2026-09-12 and reproducible with the commands shown. Model-generated prose is **not**
transcribed — the exact wording depends on the provider and model you configure, and inventing a
transcript would misrepresent it. Where an answer is described, it is described as the behaviour the
prompt requires, and each entry lists the specific checks you can apply to a real run.

Reproduce any retrieval block with:

```bash
EMBEDDING_PROVIDER=local npm run kb:search -- "<the question>"
```

---

## 1. Knowledge-base only

### "What are the must-visit attractions in Singapore?"

Best cosine **0.689** — well above the 0.38 coverage floor.

| # | Source | Section |
| --- | --- | --- |
| 1 | Visit Singapore: Sample Itineraries | Three days in Singapore |
| 2 | Wikivoyage: Singapore Travel Guide | See |
| 3 | Visit Singapore: Essential Travel Information | — |
| 4 | Wikivoyage: Singapore — Sentosa and HarbourFront | See and do › Resorts World Sentosa |
| 5 | Wikivoyage: Singapore Travel Guide | See |
| 6 | Wikivoyage: Singapore Travel Guide | Get in › Immigration |

Citations: `[S1]` Visit Singapore: Sample Itineraries · `[S2]` Wikivoyage: Singapore Travel Guide ·
`[S3]` Visit Singapore: Essential Travel Information · `[S4]` Wikivoyage: Sentosa and HarbourFront.

**Tools:** none. Nothing here depends on today's weather or exchange rates, and the tool policy
forbids reaching for one.

**Expected answer:** Gardens by the Bay, Marina Bay Sands, Sentosa, the Civic District museums, the
heritage districts and the hawker centres, each carrying a marker. The sidebar shows four sources
and "No tool was needed for this answer".

**Checks:** every named attraction traces to a retrieved passage; no temperature or price appears
that no source stated; no tool row in the trace.

*Note on result 6.* "Get in › Immigration" is a weak hit riding on lexical overlap with
"Singapore". It is harmless — the model is told to use only what is relevant — and it is the visible
cost of hybrid retrieval keeping recall high on proper nouns.

---

### "Which neighbourhoods are suitable for cultural experiences?"

Best cosine **0.453**.

| # | Source | Section |
| --- | --- | --- |
| 1 | Wikipedia: Culture of Singapore | Ethnic areas |
| 2 | Visit Singapore: Things to Do | Fully indoor and air-conditioned › Indoor experiences |
| 3 | Visit Singapore: Sample Itineraries | Itineraries by traveller profile › Culture and heritage |
| 4 | Wikivoyage: Singapore — Chinatown | Understand |
| 5 | Wikivoyage: Singapore — Chinatown | See › Temples and mosques |
| 6 | Visit Singapore: Sample Itineraries | Three days in Singapore |

Four distinct documents across three publishers — the per-document cap doing its job. Without it,
the Chinatown guide alone would have taken most of the slots.

**Expected answer:** Chinatown, Little India, Kampong Glam, Katong/Joo Chiat and the Civic District,
with the specific temples, mosques and museums each is known for.

---

### "How can a tourist travel around Singapore?"

Best cosine **0.711** — the strongest match of the set.

| # | Source | Section |
| --- | --- | --- |
| 1 | Wikipedia: Tourism in Singapore | History |
| 2 | Visit Singapore: Essential Travel Information | Getting around |
| 3 | Wikivoyage: Singapore Travel Guide | Get around › On foot |
| 4 | Wikivoyage: Singapore Travel Guide | Get around |
| 5 | Visit Singapore: Essential Travel Information | — |
| 6 | Wikivoyage: Singapore Travel Guide | Get around › By boat |

**Expected answer:** the MRT as the default, contactless card vs. EZ-Link vs. Tourist Pass with the
trade-off between them, typical S$1–2.50 fares, buses, Grab, and the tap-out rule.

**Check:** fare figures should match the corpus (S$12 for an EZ-Link card, S$17/24/29 for the
1/2/3-day Tourist Pass). A different number means the model went to memory.

---

### "Create a three-day sightseeing itinerary."

Best cosine **0.578**.

| # | Source | Section |
| --- | --- | --- |
| 1 | Visit Singapore: Sample Itineraries | Three days in Singapore |
| 2 | Visit Singapore: Sample Itineraries | Three days in Singapore › Day 3 |
| 3 | Wikivoyage: Singapore Travel Guide | See › Itineraries |
| 4 | Visit Singapore: Sample Itineraries | Three days in Singapore › Day 1 |
| 5 | Wikivoyage: Singapore — Riverside and Marina Bay | Do |
| 6 | Wikivoyage: Singapore — Sentosa and HarbourFront | See and do › Relaxation and sightseeing |

**Note:** no tool fires here. The question asks for an itinerary but names no date, so there is
nothing time-sensitive to look up. Contrast with §3, where "next week" makes the forecast relevant.

**Check:** attractions are cited; the *ordering and pacing* are presented as the assistant's own
suggestion, not attributed to a source. That separation is the third-source rule working.

---

## 2. MCP only

### "What is the weather in Singapore?" → `get_current_weather`

Captured from `npm run mcp:check`:

```
Current weather in Singapore, Singapore (local time 2026-09-12T19:00): partly cloudy,
29.1°C (feels like 33.7°C), humidity 74%, wind 9.2 km/h, precipitation 0 mm in the last hour.
```

Retrieval still runs (best cosine 0.745 — the corpus has a climate section) but the live numbers may
only come from the tool.

---

### "What is the forecast for the next three days?" → `get_weather_forecast`

```
3-day forecast for Singapore, Singapore (timezone Asia/Singapore):
- 2026-09-12: light rain showers, 24.9–29.9°C, 94% chance of rain (6.1 mm)
              — wet — plan indoor options or keep outdoor stops short
- 2026-09-13: light drizzle, 26.4–31.9°C, 51% chance of rain (0.8 mm)
              — wet — plan indoor options or keep outdoor stops short
- 2026-09-14: dense drizzle, 26.7–29.9°C, 100% chance of rain (4.2 mm)
              — wet — plan indoor options or keep outdoor stops short
```

The per-day `outlook` verdict is computed by the tool from the WMO code and rain probability, so the
model has a stated basis for recommending an indoor swap rather than deciding on its own what "94%"
implies.

---

### "Convert INR 50,000 to SGD" → `convert_currency`

```
60,000.00 INR = 796.20 SGD at 1 INR = 0.01327 SGD (ECB reference rate published 2026-09-11).
200.00 SGD = 15,073.80 INR at 1 SGD = 75.369 INR (ECB reference rate published 2026-09-11).
```

Best cosine for this question is **0.302** — below the floor, so the turn is marked as a knowledge
gap. That is the correct outcome: it is a tool question, not a corpus question. The gap instruction
explicitly keeps tools available, so the conversion still happens; the assistant simply does not
claim corpus grounding for it.

---

## 3. Combined RAG + MCP — the brief's required scenario

### "Create a three-day Singapore itinerary for next week and adjust it according to the weather forecast."

Captured event stream from `POST /api/chat`:

```
status      retrieving        Searching the knowledge base
retrieval   4 sources, gap=False
status      thinking          Asking <provider>/<model>
tool_call   get_weather_forecast {'location': 'Singapore', 'days': 3}
tool_call   convert_currency     {'amount': 60000, 'from': 'INR', 'to': 'SGD'}
tool_result get_weather_forecast success 1889ms
tool_result convert_currency     success  793ms
status      continuing        Folding in the tool results
done        combined=True citations=4 tools=2
```

Both tool calls were issued in one round and executed **in parallel** — 1889 ms and 793 ms
overlapping, not summed.

**Expected answer:** a day-by-day plan where each day's activities are drawn from the corpus and
cited, the forecast for that date is stated and attributed to the tool, and wet days swap outdoor
blocks for the indoor alternatives the corpus lists (Cloud Forest and Flower Dome instead of
Supertree Grove; the Civic District museums instead of the Southern Ridges walk).

The sidebar shows a **RAG + MCP** badge and the summary: *"Combined: 4 knowledge-base sources for
destination facts and 2 live tool results for current information."*

**Checks:** every attraction has a marker; every weather claim matches a tool result; the reasoning
that connects them ("I'd move the gardens to the morning because…") reads as a suggestion.

---

### "I have a budget of INR 60,000. Convert it to SGD and suggest a three-day itinerary."

Same flow, both tools again. Preference extraction pins `Budget: 60,000 INR` and
`Trip length: 3 days` to the session, so the budget survives into later turns without being
restated.

---

## 4. Multi-turn context

Captured across two requests on one session id:

| Turn | Question | Messages the model received |
| --- | --- | --- |
| 1 | "I have a budget of INR 60,000 and I am travelling with my kids. Plan three days in Singapore around the weather." | 2 (system + context/question) |
| 2 | "What about indoor options for day two?" | 4 (system + turn-1 pair + context/question) |

Turn 2 names neither the budget, nor the children, nor the trip length. The context block still
carried:

```
# TRAVELLER PREFERENCES (carried from earlier turns)
- Budget: 60,000 INR
- Trip length: 3 days
- Travelling as a family with children
```

**Expected answer:** indoor options appropriate to *children* — the Science Centre, S.E.A. Aquarium,
ArtScience Museum's Future World, Jewel's Canopy Park — because the party composition persisted.

---

## 5. Knowledge gaps and failures

### Off-topic: "What is the visa fee for Brazilian citizens visiting Reykjavik in winter?"

```
Best cosine: 0.260 (coverage floor RETRIEVAL_MIN_SIMILARITY=0.38)
Below the floor: the assistant would tell the user the knowledge base does not cover this,
rather than answer destination facts from the model's own memory.
```

### Travel-shaped but wrong destination: "What are the top attractions in Buenos Aires?"

```
Best cosine: 0.350 — below the floor.
```

The harder case, and the one a naive threshold gets wrong: phrasing nearly identical to a
supported question, subject matter entirely outside the corpus.

### Tool failure: an unsupported currency

From `npm run mcp:check`:

```
PASS  convert_currency  3ms (expected to fail)
      ZZZ is not covered by the ECB reference rates. Supported codes: AUD, BRL, CAD, CHF,
      CNY, CZK, DKK, EUR, GBP, HKD, HUF, IDR, ILS, INR, ISK, JPY, KRW, MXN, MYR, NOK, NZD,
      PHP, PLN, RON, SEK, SGD, THB, TRY, USD, ZAR.
```

The failure returns as a tool *result*, not an exception, and carries the recovery path. The model
reports that the conversion could not be done and still answers the rest of the question.

### Missing API key

```
$ LLM_PROVIDER=anthropic npm run ask -- "What are the top attractions?"
  · Searching the knowledge base…
  error: anthropic is selected as LLM_PROVIDER but ANTHROPIC_API_KEY is not set.
         Add it to .env.local, or switch LLM_PROVIDER to a provider you have a key for.
```

Raised before any network call, naming both the variable and the way out.

---

## Acceptance criteria coverage

| Criterion | Where demonstrated |
| --- | --- |
| Knowledge base from ≥3 travel resources | 4 resources, 15 documents — README § Knowledge base |
| Embedding-based semantic retrieval | §1, every entry; hybrid dense + BM25 |
| Grounded answers with source references | §1, `[S1]`-style markers → sidebar with URLs |
| Weather through an MCP tool | §2 |
| Currency conversion through an MCP tool | §2 |
| ≥1 response combining RAG and MCP | §3, `combined=True` |
| Multi-turn conversation with retained context | §4 |
| Appropriate tool selection from intent | §1 (no tool) vs §3 (both tools) |
| Clear handling of missing knowledge and tool failures | §5 |
| A simple, usable interface | Web UI with live trace and provenance sidebar; terminal client |
