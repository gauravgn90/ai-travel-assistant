import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runTurn } from "@/lib/agent/orchestrator";
import { createLogger } from "@/lib/logger";
import type { StreamEvent } from "@/lib/types";

// Spawning the MCP servers needs child_process, so this route cannot run on the
// edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api:chat");

const requestSchema = z.object({
  question: z.string().trim().min(1, "Ask a question.").max(2000, "That question is too long."),
  sessionId: z.string().uuid().optional(),
});

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Request body must be JSON.");
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");
  }

  const sessionId = parsed.data.sessionId ?? randomUUID();
  const encoder = new TextEncoder();

  /**
   * Events go out as newline-delimited JSON rather than SSE. The client is a
   * plain `fetch` reader, NDJSON needs no framing ceremony, and it stays
   * readable with `curl` — which matters, because that is how this endpoint
   * gets debugged.
   */
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        for await (const event of runTurn({ question: parsed.data.question, sessionId })) {
          send(event);
        }
      } catch (error) {
        // runTurn yields its own error events; reaching here means the
        // generator itself broke, which is a bug worth logging loudly.
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Stream aborted: ${message}`);
        send({ type: "error", message, recoverable: false });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-session-id": sessionId,
      // Without this, nginx and friends buffer the whole response and the
      // stream arrives as one lump.
      "x-accel-buffering": "no",
    },
  });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
