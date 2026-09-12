/** Metadata carried by every knowledge-base document and, through it, by every chunk. */
export interface SourceDocument {
  /** Stable slug, e.g. `wikivoyage-singapore-districts`. */
  id: string;
  title: string;
  url: string;
  /** Publisher of the original material, shown next to citations. */
  publisher: string;
  license: string;
  retrievedAt: string;
  /** Coarse topic labels used to bias lexical retrieval and to explain coverage gaps. */
  topics: string[];
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  /** Heading path within the source document, e.g. ["Districts", "Chinatown"]. */
  headings: string[];
  text: string;
  tokensEstimate: number;
}

export interface IndexedChunk extends KnowledgeChunk {
  embedding: number[];
}

export interface VectorIndexFile {
  version: 1;
  destination: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
  };
  builtAt: string;
  documents: SourceDocument[];
  chunks: IndexedChunk[];
}

/** A chunk that survived retrieval, with the scores that got it there. */
export interface RetrievedChunk {
  chunk: KnowledgeChunk;
  document: SourceDocument;
  /** Fused rank score in [0, 1]; comparable only within a single query. */
  score: number;
  semanticScore: number;
  lexicalScore: number;
}

/** Citation as rendered in the UI and referenced as [S1], [S2], ... in answers. */
export interface Citation {
  marker: string;
  title: string;
  url: string;
  publisher: string;
  headings: string[];
  snippet: string;
  score: number;
}

export type ToolStatus = "success" | "error";

export interface ToolInvocation {
  id: string;
  /** Tool name as advertised by the MCP server. */
  name: string;
  server: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** Human-readable result text handed back to the model. */
  result: string;
  /** Structured payload when the server returns one; used by the UI. */
  structured?: unknown;
  durationMs: number;
  error?: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AnswerProvenance {
  citations: Citation[];
  toolInvocations: ToolInvocation[];
  /** True when the answer draws on both the knowledge base and at least one tool. */
  combined: boolean;
  usedKnowledgeBase: boolean;
  retrievalGap: boolean;
}

export type StreamEvent =
  | { type: "status"; stage: string; detail?: string }
  | { type: "retrieval"; citations: Citation[]; gap: boolean }
  | { type: "tool_call"; invocation: Pick<ToolInvocation, "id" | "name" | "server" | "args"> }
  | { type: "tool_result"; invocation: ToolInvocation }
  | { type: "token"; value: string }
  | { type: "done"; provenance: AnswerProvenance; model: string; provider: string }
  | { type: "error"; message: string; recoverable: boolean };
