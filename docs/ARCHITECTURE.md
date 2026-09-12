# Architecture

A module map and the data flow through one turn. The README covers *what* the system does; this
covers *where* each piece lives and why the boundaries fall where they do.

---

## Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  UI                src/components/                                  │
│                    chat, message-view, provenance-panel, composer   │
├─────────────────────────────────────────────────────────────────────┤
│  Transport         src/app/api/chat      NDJSON stream              │
│                    src/app/api/health    readiness probe            │
│                    src/lib/client/       browser-side stream reader │
├─────────────────────────────────────────────────────────────────────┤
│  Orchestration     src/lib/agent/orchestrator.ts   the turn loop    │
│                    src/lib/agent/prompts.ts        prompt assembly  │
├──────────────────┬──────────────────┬───────────────────────────────┤
│  Retrieval       │  Generation      │  Tools                        │
│  src/lib/rag/    │  src/lib/llm/    │  src/lib/mcp/                 │
│  src/lib/        │                  │  mcp-servers/                 │
│    embeddings/   │                  │                               │
├──────────────────┴──────────────────┴───────────────────────────────┤
│  Foundation        src/lib/config/   schema-validated env, paths    │
│                    src/lib/session/  transcript + preferences       │
│                    src/lib/types.ts  shared domain types            │
│                    src/lib/logger.ts                                │
└─────────────────────────────────────────────────────────────────────┘
```

The three middle columns know nothing about each other. The orchestrator is the only module that
imports from all three, which is what keeps retrieval testable without a model and tools testable
without either.

---

## Module responsibilities

### `src/lib/config`

`env.ts` parses `process.env` through a Zod schema once and caches it. A typo fails at startup with
the offending key named, rather than surfacing as `undefined` three layers down. It also resolves
the embedding provider: explicit setting wins, otherwise reuse the chat provider if it sells
embeddings, otherwise fall back to local — which is what makes an Anthropic- or Groq-only
configuration work out of the box, since neither vendor has an embedding endpoint.

`paths.ts` resolves everything relative to the repository root rather than `import.meta.url`,
because the same modules are loaded both by `tsx` (from source) and by the Next.js server build
(from `.next`).

### `src/lib/rag`

| File | Responsibility |
| --- | --- |
| `documents.ts` | Front-matter parsing, document discovery, duplicate-id detection |
| `chunker.ts` | Heading-aware markdown splitting, packing, overlap, stub removal |
| `vector-store.ts` | Flat cosine index over normalised `Float32Array` rows |
| `lexical.ts` | BM25 with heading-term boosting |
| `retriever.ts` | RRF fusion, per-document cap, coverage gate, citation shaping |
| `index-store.ts` | Loads and caches the built index; dimension-mismatch guard |

`vector-store.ts` exposes deliberately the small interface an ANN backend would also satisfy
(`search(query, k)`), so replacing it with Chroma or FAISS is a one-file change.

### `src/lib/embeddings`

A registry keyed by provider, plus `local.ts` — a LangChain `Embeddings` implementation running
`all-MiniLM-L6-v2` through ONNX Runtime in-process. The transformers dependency is optional and
imported dynamically, so a failed install of a native module never breaks an unrelated provider; if
it is missing, the error names the two ways out.

### `src/lib/llm`

A registry that maps provider → LangChain chat model. Provider SDKs are imported lazily so a
deployment only loads the one it uses. `MissingApiKeyError` names the environment variable and the
alternative, because "401 Unauthorized" is a bad first-run experience.

### `src/lib/mcp`

`registry.ts` resolves server definitions — the bundled pair, or a `mcp.config.json` in the standard
`mcpServers` shape. `client.ts` owns the connections: handshake, `tools/list`, JSON-Schema →
LangChain tool definitions, per-call timeouts, and the invariant that **`call()` always resolves**.
A transport failure, a protocol error and a tool-reported error all become a failed
`ToolInvocation`, which the orchestrator feeds back to the model as a tool result. Nothing in the
tool path can throw the turn away.

Connections are held on a `globalThis` handle so Next.js hot reloads reuse them instead of leaking a
pair of child processes per edit.

### `src/lib/session`

`store.ts` keeps transcripts in process memory with a 2-hour TTL and a 500-session cap, trimmed to
the most recent 12 messages. `preferences.ts` is a rule table over user messages.

Preferences survive history trimming — that is the point of pinning them separately. A budget stated
in turn 1 is still in the prompt at turn 20, long after the message that stated it has fallen out
of the window.

### `src/lib/agent`

`prompts.ts` builds the system prompt and the per-turn context block. `orchestrator.ts` runs the
turn as an async generator of `StreamEvent`s.

---

## One turn, end to end

```
runTurn({ question, sessionId })
  │
  ├─ sessionStore.get / appendUserMessage      → extracts + merges preferences
  │
  ├─ Promise.all
  │    ├─ createEmbeddings()                   ← provider registry
  │    ├─ createChatModel()                    ← provider registry
  │    └─ getMcpRegistry()                     ← connects (or reuses) stdio servers
  │
  ├─ retrieve(question, embeddings)
  │    ├─ embedQuery
  │    ├─ vectors.search(k=18)  ─┐
  │    ├─ lexical.search(k=18)   ├─ RRF fusion → per-document cap → top 6
  │    └─ coverage gate on best raw cosine
  │                                            ── yield "retrieval"
  ├─ build messages
  │    system + history + (preferences ∥ knowledge base ∥ sources ∥ question)
  │
  ├─ loop, up to MAX_TOOL_ITERATIONS
  │    ├─ stream from the model                ── yield "token" per delta
  │    ├─ no tool calls?  → done
  │    ├─ yield "tool_call" per call
  │    ├─ Promise.all(mcp.call(...))           ── parallel
  │    ├─ yield "tool_result" per result
  │    └─ append AIMessage + ToolMessages (+ failure note)
  │
  ├─ sessionStore.appendAssistantMessage
  └─ yield "done" with provenance
```

The last iteration binds no tools, so the model is forced to answer with what it has instead of
looping to the cap and returning nothing.

---

## Streaming protocol

`POST /api/chat` returns `application/x-ndjson` — one JSON object per line.

| Event | Payload | UI effect |
| --- | --- | --- |
| `status` | `stage`, `detail` | Spinner caption |
| `retrieval` | `citations[]`, `gap` | Sources panel populates |
| `tool_call` | `id`, `name`, `args` | Pending tool row appears |
| `tool_result` | full `ToolInvocation` | Row resolves to success or failure |
| `token` | `value` | Appended to the answer |
| `done` | `provenance`, `model`, `provider` | Final state, combined/gap badges |
| `error` | `message`, `recoverable` | Error styling |

Chunk boundaries fall wherever the network puts them, so the client buffers a partial line until its
newline arrives rather than parsing and dropping it.

Text deltas are forwarded in every round, including rounds that end in a tool call. Providers that
narrate before calling a tool ("Let me check the forecast") produce useful output there; providers
that emit an empty content block produce nothing, so the behaviour is correct either way.

---

## MCP process model

```
Next.js server process
  │
  ├─ child: node mcp-servers/src/weather.ts    ← stdio JSON-RPC
  └─ child: node mcp-servers/src/currency.ts   ← stdio JSON-RPC
```

Servers are spawned on first use and reused for the process lifetime. `stdout` belongs to the
protocol, so all server diagnostics go to `stderr`, which the client pipes into the application log
at debug level.

Both servers run under Node 24's native type stripping — no build step, at the cost of erasable
syntax only (no enums, no parameter properties).

---

## Error boundaries

| Failure | Handled where | Result |
| --- | --- | --- |
| Missing API key | `llm/registry.ts` | Named variable + the alternative, before any network call |
| Index not built | `rag/index-store.ts` | `IndexNotBuiltError` naming the command to run |
| Embedding dimension mismatch | `rag/vector-store.ts` | Refuses to load, says to re-ingest |
| MCP server won't start | `mcp/client.ts` | Skipped; remaining tools work; prompt told which is missing |
| Tool call fails | `mcp/client.ts` | Failed `ToolInvocation` → model explains the gap |
| Model error mid-turn | `agent/orchestrator.ts` | `error` event, flagged recoverable for quota/timeout classes |
| Malformed request | `api/chat/route.ts` | 400 with the Zod message |

The rule throughout: a subsystem that cannot do its job reports that fact as data, and the layer
above decides what to do. Nothing fails the whole turn that does not have to.

---

## Testing

`npm test` — 30 unit tests over the pure logic: chunking, BM25, cosine ranking, front-matter
parsing, preference extraction and merging. No network, no model.

Integration is covered by two probes that need no LLM quota:

- `npm run kb:search -- "…"` — retrieval with per-ranker scores and the coverage decision.
- `npm run mcp:check` — connects both servers, calls every tool, and asserts that an invalid
  currency code comes back as a clean failure rather than an exception.

The LLM boundary is exercised by pointing `OPENAI_BASE_URL` at any OpenAI-compatible server,
including a local stub or Ollama, which runs the full loop — retrieval, tool calls, streaming,
provenance — without a vendor key.
