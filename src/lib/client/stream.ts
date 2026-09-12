import type { StreamEvent } from "@/lib/types";

export interface AskOptions {
  question: string;
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * Reads the chat endpoint's NDJSON response and yields one event per line.
 *
 * Chunk boundaries fall wherever the network puts them, so a partial line is
 * held back until its newline arrives rather than being parsed and dropped.
 */
export async function* askAssistant(options: AskOptions): AsyncGenerator<StreamEvent> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: options.question, sessionId: options.sessionId }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null);
    throw new Error(detail ?? `The assistant returned HTTP ${response.status}.`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        if (line) yield JSON.parse(line) as StreamEvent;
      }
    }

    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail) as StreamEvent;
  } finally {
    reader.releaseLock();
  }
}
