"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/composer";
import { MessageView } from "@/components/message-view";
import { ProvenancePanel } from "@/components/provenance-panel";
import { StatusBar } from "@/components/status-bar";
import { askAssistant } from "@/lib/client/stream";
import type { Citation, ToolInvocation } from "@/lib/types";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "streaming" | "complete" | "failed";
  stage?: string;
  citations: Citation[];
  toolInvocations: ToolInvocation[];
  /** Tool calls the model has issued but that have not returned yet. */
  pendingTools: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  retrievalGap: boolean;
  combined: boolean;
  model?: string;
  provider?: string;
}

const SUGGESTIONS = [
  "What are the must-visit attractions in Singapore?",
  "Create a three-day Singapore itinerary for next week and adjust it to the weather forecast.",
  "I have a budget of INR 60,000 — convert it to SGD and suggest a three-day itinerary.",
  "Which neighbourhoods are best for cultural experiences?",
  "What indoor attractions can I visit if it rains?",
  "Suggest activities for a family with young children.",
];

export function Chat({ destination }: { destination: string }) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Follow the stream only while the reader is already at the bottom, so
  // scrolling up to re-read an earlier answer is not fought by every token.
  useEffect(() => {
    const element = transcriptRef.current;
    if (element && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const handleScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 80;
  }, []);

  const updateLast = useCallback((mutate: (message: UiMessage) => UiMessage) => {
    setMessages((current) => {
      const last = current.at(-1);
      if (!last || last.role !== "assistant") return current;
      return [...current.slice(0, -1), mutate(last)];
    });
  }, []);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      pinnedToBottom.current = true;
      setBusy(true);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: trimmed,
          status: "complete",
          citations: [],
          toolInvocations: [],
          pendingTools: [],
          retrievalGap: false,
          combined: false,
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          status: "pending",
          stage: "Starting",
          citations: [],
          toolInvocations: [],
          pendingTools: [],
          retrievalGap: false,
          combined: false,
        },
      ]);

      try {
        for await (const event of askAssistant({
          question: trimmed,
          sessionId,
          signal: controller.signal,
        })) {
          switch (event.type) {
            case "status":
              updateLast((message) => ({ ...message, stage: event.detail ?? event.stage }));
              break;

            case "retrieval":
              updateLast((message) => ({
                ...message,
                citations: event.citations,
                retrievalGap: event.gap,
              }));
              break;

            case "tool_call":
              updateLast((message) => ({
                ...message,
                pendingTools: [...message.pendingTools, event.invocation],
              }));
              break;

            case "tool_result":
              updateLast((message) => ({
                ...message,
                pendingTools: message.pendingTools.filter((tool) => tool.id !== event.invocation.id),
                toolInvocations: [...message.toolInvocations, event.invocation],
              }));
              break;

            case "token":
              updateLast((message) => ({
                ...message,
                status: "streaming",
                stage: undefined,
                content: message.content + event.value,
              }));
              break;

            case "done":
              updateLast((message) => ({
                ...message,
                status: "complete",
                stage: undefined,
                pendingTools: [],
                citations: event.provenance.citations,
                toolInvocations: event.provenance.toolInvocations,
                retrievalGap: event.provenance.retrievalGap,
                combined: event.provenance.combined,
                model: event.model,
                provider: event.provider,
              }));
              break;

            case "error":
              updateLast((message) => ({
                ...message,
                status: "failed",
                stage: undefined,
                pendingTools: [],
                content: message.content
                  ? `${message.content}\n\n**The turn stopped early:** ${event.message}`
                  : event.message,
              }));
              break;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        updateLast((message) => ({
          ...message,
          status: "failed",
          stage: undefined,
          pendingTools: [],
          content: error instanceof Error ? error.message : "The request failed.",
        }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, sessionId, updateLast],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    updateLast((message) => ({
      ...message,
      status: message.content ? "complete" : "failed",
      stage: undefined,
      pendingTools: [],
      content: message.content || "Stopped before the assistant replied.",
    }));
    setBusy(false);
  }, [updateLast]);

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

  return (
    <>
      <StatusBar />
      <div className="workspace">
        <section className="conversation" aria-label="Conversation">
          <div
            className="transcript"
            ref={transcriptRef}
            onScroll={handleScroll}
            aria-live="polite"
            aria-busy={busy}
          >
            {messages.length === 0 ? (
              <EmptyState destination={destination} onPick={send} disabled={busy} />
            ) : (
              messages.map((message) => <MessageView key={message.id} message={message} />)
            )}
          </div>
          <Composer onSend={send} onStop={stop} busy={busy} destination={destination} />
        </section>
        <aside className="sidebar" aria-label="Answer provenance">
          <ProvenancePanel message={lastAssistant} />
        </aside>
      </div>
    </>
  );
}

function EmptyState({
  destination,
  onPick,
  disabled,
}: {
  destination: string;
  onPick: (question: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="empty-state">
      <h2>Ask about {destination}</h2>
      <p>
        Destination questions are answered from the indexed guide corpus with a citation for every
        claim. Weather and currency questions go out to MCP tools. Ask something that needs both and
        the answer will use both, and say which part came from where.
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="suggestion"
            onClick={() => onPick(suggestion)}
            disabled={disabled}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
