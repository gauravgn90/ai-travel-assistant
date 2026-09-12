import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getEnv } from "@/lib/config/env";
import { createEmbeddings } from "@/lib/embeddings/registry";
import { createChatModel } from "@/lib/llm/registry";
import { getMcpRegistry } from "@/lib/mcp/client";
import { createLogger } from "@/lib/logger";
import { buildContextBlock, buildSystemPrompt, buildToolSummary } from "@/lib/agent/prompts";
import { formatContext, retrieve, toCitations } from "@/lib/rag/retriever";
import { sessionStore } from "@/lib/session/store";
import type { AnswerProvenance, StreamEvent, ToolInvocation } from "@/lib/types";

const log = createLogger("agent");

export interface AnswerRequest {
  question: string;
  sessionId?: string;
}

/**
 * Runs one conversational turn and yields UI events as they happen.
 *
 * The loop is written out rather than delegated to a prebuilt agent executor
 * because the turn has to report exactly which knowledge-base passages and
 * which tool results fed the answer. That provenance is the product here, not a
 * debugging aid, and reconstructing it from callbacks afterwards is strictly
 * worse than collecting it as the turn runs.
 */
export async function* runTurn(request: AnswerRequest): AsyncGenerator<StreamEvent> {
  const env = getEnv();
  const session = sessionStore.get(request.sessionId);
  const history = session.messages.slice();
  const preferences = sessionStore.appendUserMessage(session, request.question);

  const invocations: ToolInvocation[] = [];
  let answer = "";

  try {
    yield { type: "status", stage: "retrieving", detail: "Searching the knowledge base" };

    const [{ embeddings }, { model, provider, modelName }, mcp] = await Promise.all([
      createEmbeddings(env),
      createChatModel(env),
      getMcpRegistry(),
    ]);

    const retrieval = await retrieve(request.question, embeddings);
    const citations = toCitations(retrieval.chunks);
    yield { type: "retrieval", citations, gap: retrieval.gap };

    if (typeof model.bindTools !== "function") {
      throw new Error(
        `The ${provider} model "${modelName}" does not support tool calling in LangChain, ` +
          `so live weather and currency lookups are unavailable. Choose a tool-capable model.`,
      );
    }

    const toolDefinitions = mcp.listToolDefinitions();
    const status = mcp.status();
    const boundModel = toolDefinitions.length > 0 ? model.bindTools(toolDefinitions) : model;

    const messages: BaseMessage[] = [
      new SystemMessage(
        buildSystemPrompt({
          destination: env.DESTINATION,
          availableTools: toolDefinitions.map((tool) => tool.function.name),
          unavailableServers: status.filter((s) => !s.connected).map((s) => s.serverId),
          today: new Date().toISOString().slice(0, 10),
        }),
      ),
      ...history.map((message) =>
        message.role === "user"
          ? new HumanMessage(message.content)
          : new AIMessage(message.content),
      ),
      new HumanMessage(
        `${buildContextBlock({
          citations,
          context: formatContext(retrieval.chunks, citations),
          retrievalGap: retrieval.gap,
          preferences: preferences.map((preference) => preference.value),
        })}\n\n# QUESTION\n${request.question}`,
      ),
    ];

    for (let round = 0; round < env.MAX_TOOL_ITERATIONS; round += 1) {
      // The final round drops the tools so the model is forced to answer with
      // what it already has instead of looping until the cap.
      const lastRound = round === env.MAX_TOOL_ITERATIONS - 1;
      const runnable = lastRound ? model : boundModel;

      yield {
        type: "status",
        stage: round === 0 ? "thinking" : "continuing",
        detail: round === 0 ? `Asking ${provider}/${modelName}` : "Folding in the tool results",
      };

      let aggregate: AIMessageChunk | undefined;
      let roundText = "";

      for await (const chunk of await runnable.stream(messages)) {
        aggregate = aggregate ? aggregate.concat(chunk) : chunk;
        const delta = chunk.text;
        if (delta) {
          roundText += delta;
          yield { type: "token", value: delta };
        }
      }

      if (!aggregate) throw new Error("The model returned an empty response.");

      const toolCalls = aggregate.tool_calls ?? [];
      if (toolCalls.length === 0 || lastRound) {
        answer = roundText;
        break;
      }

      messages.push(aggregate as unknown as BaseMessage);

      for (const call of toolCalls) {
        const id = call.id ?? `${call.name}-${invocations.length}`;
        yield {
          type: "tool_call",
          invocation: { id, name: call.name, server: "mcp", args: call.args },
        };
      }

      // Tool calls in one round are independent by construction, so they run in
      // parallel; a three-day forecast plus a currency conversion is one wait,
      // not two.
      const results = await Promise.all(
        toolCalls.map((call) =>
          mcp.call(call.id ?? `${call.name}-${invocations.length}`, call.name, call.args),
        ),
      );

      for (const invocation of results) {
        invocations.push(invocation);
        yield { type: "tool_result", invocation };
        messages.push(
          new ToolMessage({
            content: invocation.result,
            tool_call_id: invocation.id,
            name: invocation.name,
          }),
        );
      }

      const failureNote = buildToolSummary(results);
      if (failureNote) messages.push(new HumanMessage(failureNote));
    }

    if (!answer.trim()) {
      answer =
        "I could not produce an answer for that. Try rephrasing the question, or ask about " +
        `${env.DESTINATION} attractions, transport, food, or a day-by-day itinerary.`;
      yield { type: "token", value: answer };
    }

    sessionStore.appendAssistantMessage(session, answer);

    const provenance: AnswerProvenance = {
      citations,
      toolInvocations: invocations,
      usedKnowledgeBase: citations.length > 0,
      combined: citations.length > 0 && invocations.some((i) => i.status === "success"),
      retrievalGap: retrieval.gap,
    };

    yield { type: "done", provenance, model: modelName, provider };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Turn failed: ${message}`);
    yield { type: "error", message, recoverable: isRecoverable(error) };
  }
}

/** Configuration and quota problems are worth retrying after a fix; bugs are not. */
function isRecoverable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /rate.?limit|quota|429|503|timeout|ECONNRESET|overloaded/i.test(error.message);
}
