"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, StreamEvent } from "@/lib/types";

/** One line of the activity log: what the assistant is doing, or just did. */
interface Step {
  id: string;
  text: string;
  done: boolean;
}

interface Message {
  id: number;
  role: "you" | "assistant";
  text: string;
  steps: Step[];
  citations: Citation[];
  gap: boolean;
  failed?: boolean;
}

const EXAMPLES = [
  "What are the must-visit attractions in Singapore?",
  "Plan a three-day trip for next week and adjust it to the weather forecast.",
  "My budget is INR 60,000. What is that in SGD, and what can I do with it?",
  "Which neighbourhoods are best for cultural experiences?",
  "It might rain tomorrow. What indoor attractions can I visit?",
];

/** Replaces a step in place when it is already on screen, so a line can go from
 *  "Calling …" to "Called …" without the list reordering. */
function upsert(steps: Step[], next: Step): Step[] {
  const at = steps.findIndex((step) => step.id === next.id);
  if (at === -1) return [...steps, next];
  const copy = steps.slice();
  copy[at] = next;
  return copy;
}

const settle = (steps: Step[]) => steps.map((step) => ({ ...step, done: true }));

export default function Chat({ destination }: { destination: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  // Created on the first question rather than during render: render has to be
  // pure, and a value derived there would also be recomputed on every pass.
  const sessionId = useRef("");
  const bottom = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    // Not on mount: with nothing asked yet there is nothing to follow, and
    // scrolling to the anchor would push the heading off the top of the page.
    if (messages.length > 0) bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function updateAnswer(change: (message: Message) => Message) {
    setMessages((all) => all.map((m, i) => (i === all.length - 1 ? change(m) : m)));
  }

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    sessionId.current ||= crypto.randomUUID();
    setBusy(true);
    setQuestion("");
    setMessages((all) => [
      ...all,
      { id: nextId.current++, role: "you", text: trimmed, steps: [], citations: [], gap: false },
      {
        id: nextId.current++,
        role: "assistant",
        text: "",
        steps: [{ id: "start", text: "Working", done: false }],
        citations: [],
        gap: false,
      },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed, sessionId: sessionId.current }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`The server returned HTTP ${response.status}.`);
      }

      // The response is newline-delimited JSON. Chunk boundaries fall wherever
      // the network puts them, so a partial line waits for its newline.
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;

          if (event.type === "step") {
            updateAnswer((m) => ({
              ...m,
              // The placeholder is replaced by the first real step.
              steps: upsert(
                m.steps.filter((s) => s.id !== "start"),
                { id: event.id, text: event.text, done: event.done },
              ),
            }));
          }
          if (event.type === "sources") {
            updateAnswer((m) => ({ ...m, citations: event.citations, gap: event.gap }));
          }
          if (event.type === "reset") updateAnswer((m) => ({ ...m, text: "" }));
          if (event.type === "token") {
            updateAnswer((m) => ({ ...m, text: m.text + event.text }));
          }
          if (event.type === "done") {
            updateAnswer((m) => ({ ...m, steps: settle(m.steps) }));
          }
          if (event.type === "error") {
            updateAnswer((m) => ({
              ...m,
              steps: settle(m.steps),
              failed: true,
              text: event.message,
            }));
          }
        }
      }
    } catch (error) {
      // The server is unreachable or the stream broke. Same treatment as a
      // failure inside the turn: the detail goes to the console, the reader
      // gets one sentence.
      console.error("Chat request failed:", error);
      updateAnswer((m) => ({
        ...m,
        steps: settle(m.steps),
        failed: true,
        text: "Agent is down. Please try again in a moment.",
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      {messages.length === 0 ? (
        <div className="intro">
          <p>Ask about {destination}, or start with one of these:</p>
          <ul>
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button type="button" onClick={() => ask(example)}>
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        messages.map((message) => <Entry key={message.id} message={message} />)
      )}

      <div ref={bottom} />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        <textarea
          value={question}
          rows={2}
          placeholder={`Ask about ${destination}`}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              ask(question);
            }
          }}
        />
        <button type="submit" disabled={busy || !question.trim()}>
          {busy ? "Working…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function Entry({ message }: { message: Message }) {
  if (message.role === "you") {
    return (
      <div className="entry you">
        <span className="who">You</span>
        <p>{message.text}</p>
      </div>
    );
  }

  return (
    <div className="entry">
      <span className="who">Assistant</span>

      {message.steps.length > 0 && (
        <ul className="steps" aria-live="polite">
          {message.steps.map((step) => (
            <li key={step.id} className={step.done ? "done" : ""}>
              {step.done ? <span className="tick">✓</span> : <span className="spinner" />}
              {step.text}
            </li>
          ))}
        </ul>
      )}

      {message.text && (
        <div className={message.failed ? "answer failed" : "answer"}>
          <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
        </div>
      )}

      {message.gap && (
        <p className="note">No indexed guide covered this question.</p>
      )}

      {message.citations.length > 0 && (
        <div className="sources">
          <span className="who">Sources</span>
          <ol>
            {message.citations.map((citation) => (
              <li key={citation.marker}>
                <a href={citation.url} target="_blank" rel="noreferrer">
                  {citation.title}
                </a>{" "}
                <span>{citation.publisher}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
