import { runTurn } from "@/lib/agent";

// Spawning the MCP servers needs child_process, so this cannot run on the edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { question, sessionId } = (await request.json()) as {
    question?: string;
    sessionId?: string;
  };

  if (!question?.trim() || !sessionId) {
    return Response.json({ error: "Ask a question." }, { status: 400 });
  }

  const abort = new AbortController();
  const turn = runTurn({
    question: question.trim().slice(0, 2000),
    sessionId,
    signal: AbortSignal.any([request.signal, abort.signal]),
  });

  // Newline-delimited JSON rather than SSE: the client is a plain fetch reader,
  // it needs no framing, and it stays readable under curl.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of turn) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (error) {
        console.error("Stream failed:", error);
      } finally {
        controller.close();
      }
    },
    // The reader navigated away or pressed Stop. Returning the generator stops
    // the model request in flight rather than paying for an unread answer.
    async cancel() {
      abort.abort();
      await turn.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Without this, proxies buffer the whole response and it arrives at once.
      "x-accel-buffering": "no",
    },
  });
}
