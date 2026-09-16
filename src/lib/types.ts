/** Citation metadata carried from a knowledge-base document through to the UI. */
export interface SourceDocument {
  id: string;
  title: string;
  url: string;
  publisher: string;
}

export interface Chunk {
  id: string;
  document: SourceDocument;
  /** Heading path inside the source document, e.g. ["Districts", "Chinatown"]. */
  headings: string[];
  text: string;
}

/** A document cited by an answer, numbered [S1], [S2], ... in the text. */
export interface Citation {
  marker: string;
  title: string;
  url: string;
  publisher: string;
  score: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: string;
}

export type StreamEvent =
  /** One line of the activity log. The same `id` arrives twice: once when the
   *  step starts and once when it finishes, so the browser can replace the line
   *  in place rather than keep its own state machine. */
  | { type: "step"; id: string; text: string; done: boolean }
  | { type: "sources"; citations: Citation[]; gap: boolean }
  | { type: "token"; text: string }
  /** Discard the text streamed so far: the model wrote a preamble and then
   *  called a tool, so the answer is what it writes after the results land. */
  | { type: "reset" }
  | { type: "done" }
  | { type: "error"; message: string };
