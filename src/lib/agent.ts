import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { SetupError, config } from "./config.ts";
import { mcp } from "./mcp.ts";
import { createModel } from "./model.ts";
import { contextBlock, systemPrompt } from "./prompt.ts";
import { retrieve } from "./retriever.ts";
import type { StreamEvent } from "./types.ts";

/** Conversations, in memory. One node, one process; swapping in Redis would be
 *  a change to this map only. Trimmed so a long session cannot grow unbounded. */
const conversations = new Map<string, BaseMessage[]>();
const MAX_HISTORY = 10;
const MAX_SESSIONS = 200;

export interface Turn {
  question: string;
  sessionId: string;
  signal?: AbortSignal;
}

/**
 * Runs one turn and yields the events the browser renders.
 *
 * The loop is written out rather than handed to a prebuilt agent executor
 * because the answer has to report exactly which passages and which tool
 * results produced it. That provenance is the product here, and recovering it
 * from callbacks afterwards is harder than collecting it as the turn runs.
 */
export async function* runTurn({ question, sessionId, signal }: Turn): AsyncGenerator<StreamEvent> {
  try {
    yield step("retrieve", "Searching the knowledge base");

    // Retrieval and the tool handshake are independent, so they overlap.
    const [retrieval, tools] = await Promise.all([retrieve(question), mcp()]);

    const found = retrieval.citations.length;
    yield step(
      "retrieve",
      found === 0
        ? "No matching guides in the knowledge base"
        : `Found ${found} source${found === 1 ? "" : "s"} in the knowledge base`,
      true,
    );
    yield { type: "sources", citations: retrieval.citations, gap: retrieval.gap };

    // Built after the sources are on screen: it only constructs a client, so
    // this costs no time, and a missing key then surfaces as an error the
    // reader sees under what was already found rather than instead of it.
    const model = await createModel();

    const history = conversations.get(sessionId) ?? [];
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt(tools.tools.map((tool) => tool.name), tools.missing)),
      ...history,
      new HumanMessage(contextBlock(retrieval, question)),
    ];

    if (tools.definitions.length && typeof model.bindTools !== "function") {
      throw new SetupError(
        `${config.provider}/${config.model} does not support tool calling, so live weather and ` +
          `currency lookups are unavailable. Choose a tool-capable model.`,
      );
    }

    const withTools = tools.definitions.length
      ? model.bindTools!(tools.definitions)
      : model;

    let answer = "";

    for (let round = 0; round < config.maxToolRounds; round += 1) {
      // On the last round the tools are dropped, so the model answers with what
      // it has instead of looping until the cap.
      const last = round === config.maxToolRounds - 1;
      const thinking = `think-${round}`;
      const label = round === 0 ? "Thinking" : "Reading the tool results";
      yield step(thinking, label);

      let aggregate;
      let text = "";
      for await (const chunk of await (last ? model : withTools).stream(messages, { signal })) {
        aggregate = aggregate ? aggregate.concat(chunk) : chunk;
        if (chunk.text) {
          // The first visible token is the moment the model stopped thinking
          // and started answering, so the spinner stops there rather than at
          // the end of the stream.
          if (!text) yield step(thinking, label, true);
          text += chunk.text;
          yield { type: "token", text: chunk.text };
        }
      }
      if (!text) yield step(thinking, label, true);

      if (!aggregate) throw new Error("The model returned an empty response.");
      const requested = aggregate.tool_calls ?? [];

      if (last || requested.length === 0) {
        answer = text;
        break;
      }

      // The model wrote something and then decided to call a tool - that text
      // was a preamble, not the answer, so the draft is dropped.
      if (text.trim()) yield { type: "reset" };
      messages.push(aggregate as unknown as BaseMessage);

      const planned = requested.map((call, i) => ({
        id: call.id ?? `${call.name}-${round}-${i}`,
        name: call.name,
        args: call.args as Record<string, unknown>,
      }));

      for (const call of planned) {
        yield step(call.id, `Calling ${call.name}${formatArgs(call.args)}`);
      }

      // Calls in one round are independent, so a forecast and a conversion are
      // one wait rather than two.
      const results = await Promise.all(
        planned.map((call) => tools.call(call.id, call.name, call.args)),
      );

      for (const result of results) {
        const label = result.name.replaceAll("_", " ");
        yield step(
          result.id,
          result.ok
            ? `Called ${label}${formatArgs(result.args)}`
            : `${result.name} failed - ${result.result}`,
          true,
        );
        messages.push(
          new ToolMessage({ content: result.result, tool_call_id: result.id, name: result.name }),
        );
      }
    }

    if (!answer.trim()) {
      answer = `I could not answer that. Try asking about ${config.destination} attractions, transport, food, a day-by-day itinerary, the forecast, or your budget in another currency.`;
      yield { type: "token", text: answer };
    }

    // Oldest session out first, so a long-lived server does not accumulate
    // transcripts indefinitely.
    if (conversations.size >= MAX_SESSIONS) {
      conversations.delete(conversations.keys().next().value!);
    }
    conversations.delete(sessionId);
    conversations.set(
      sessionId,
      [...history, new HumanMessage(question), new AIMessage(answer)].slice(-MAX_HISTORY),
    );

    yield { type: "done" };
  } catch (error) {
    if (signal?.aborted) return;

    // The whole fault goes to the server log, where whoever runs this can act
    // on it. The reader gets one sentence: a provider's raw error payload is
    // noise to them, and it carries endpoint and request detail that has no
    // business on screen. Setup problems are the exception - those messages are
    // written for the operator and say exactly what to fix.
    console.error("Turn failed:", error);

    yield {
      type: "error",
      message:
        error instanceof SetupError
          ? error.message
          : "Agent is down. Please try again in a moment.",
    };
  }
}

function step(id: string, text: string, done = false): StreamEvent {
  return { type: "step", id, text, done };
}

/** Tool arguments as the reader sees them: `(location: Singapore, days: 3)`. */
function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return ` (${entries.map(([key, value]) => `${key}: ${String(value)}`).join(", ")})`;
}
