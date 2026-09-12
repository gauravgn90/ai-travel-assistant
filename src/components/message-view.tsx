"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UiMessage } from "@/components/chat";
import type { ToolInvocation } from "@/lib/types";

export function MessageView({ message }: { message: UiMessage }) {
  if (message.role === "user") {
    return (
      <article className="message user">
        <span className="message-role">You</span>
        <div className="bubble">
          <div className="prose">
            <p>{message.content}</p>
          </div>
        </div>
      </article>
    );
  }

  const showTrace =
    message.pendingTools.length > 0 || message.toolInvocations.length > 0 || Boolean(message.stage);

  return (
    <article className={`message assistant${message.status === "failed" ? " error" : ""}`}>
      <span className="message-role">
        Assistant
        {message.provider && message.model ? ` · ${message.provider}/${message.model}` : ""}
      </span>

      {showTrace && (
        <div className="trace">
          {message.stage && (
            <div className="trace-row">
              <span className="spinner" aria-hidden />
              <span>{message.stage}…</span>
            </div>
          )}
          {message.toolInvocations.map((invocation) => (
            <ToolRow key={invocation.id} invocation={invocation} />
          ))}
          {message.pendingTools.map((tool) => (
            <div className="trace-row" key={tool.id}>
              <span className="spinner" aria-hidden />
              <div>
                <strong>{tool.name}</strong>{" "}
                <span className="trace-args">{formatArgs(tool.args)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {(message.content || message.status === "streaming") && (
        <div className="bubble">
          <div className="prose">
            <Markdown remarkPlugins={[remarkGfm]} components={{ a: ExternalLink }}>
              {message.content}
            </Markdown>
            {message.status === "streaming" && <span className="caret" aria-hidden />}
          </div>
        </div>
      )}
    </article>
  );
}

function ToolRow({ invocation }: { invocation: ToolInvocation }) {
  const failed = invocation.status === "error";

  return (
    <div className={`trace-row ${failed ? "bad" : "ok"}`}>
      <span aria-hidden>{failed ? "!" : "✓"}</span>
      <div>
        <strong>{invocation.name}</strong>{" "}
        <span className="trace-args">{formatArgs(invocation.args)}</span>
        <span className="trace-args"> · {invocation.server} · {invocation.durationMs}ms</span>
        <p className="trace-detail">{invocation.result}</p>
      </div>
    </div>
  );
}

function ExternalLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "()";
  return `(${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")})`;
}
