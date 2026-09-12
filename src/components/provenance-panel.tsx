"use client";

import type { UiMessage } from "@/components/chat";

/**
 * Shows where the most recent answer came from: which knowledge-base documents
 * were retrieved, and which MCP tools ran. The assignment asks the assistant to
 * distinguish stable destination knowledge from live tool data, and this panel
 * is the part of that contract the reader can actually audit.
 */
export function ProvenancePanel({ message }: { message?: UiMessage }) {
  if (!message) {
    return (
      <section className="panel">
        <h2 className="panel-title">Answer sources</h2>
        <p className="panel-empty">
          Ask a question and the knowledge-base passages and tool calls behind the answer will be
          listed here.
        </p>
      </section>
    );
  }

  const succeededTools = message.toolInvocations.filter((tool) => tool.status === "success");

  return (
    <>
      <section className="panel">
        <h2 className="panel-title">
          Knowledge base
          {message.combined && <span className="badge combined">RAG + MCP</span>}
          {message.retrievalGap && <span className="badge gap">no match</span>}
        </h2>

        {message.retrievalGap ? (
          <p className="panel-empty">
            Nothing in the indexed guides matched this question, so the assistant was instructed to
            say so rather than answer destination facts from memory.
          </p>
        ) : message.citations.length === 0 ? (
          <p className="panel-empty">Retrieving…</p>
        ) : (
          message.citations.map((citation) => (
            <div className="source" key={citation.marker}>
              <div className="source-head">
                <span className="marker">[{citation.marker}]</span>
                <a
                  className="source-title"
                  href={citation.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {citation.title}
                </a>
              </div>
              <div className="source-meta">
                {citation.publisher}
                {citation.headings.length > 0 && ` · ${citation.headings.join(" › ")}`}
                {` · relevance ${citation.score.toFixed(2)}`}
              </div>
              <p className="source-snippet">{citation.snippet}</p>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Live data (MCP)</h2>
        {message.toolInvocations.length === 0 ? (
          <p className="panel-empty">
            No tool was needed for this answer — nothing in it depends on today&apos;s weather or
            exchange rates.
          </p>
        ) : (
          message.toolInvocations.map((tool) => (
            <div className="source" key={tool.id}>
              <div className="source-head">
                <span className="marker">{tool.status === "success" ? "✓" : "!"}</span>
                <span className="source-title">{tool.name}</span>
              </div>
              <div className="source-meta">
                {tool.server} · {tool.durationMs}ms
                {tool.status === "error" && " · failed"}
              </div>
              <p className="source-snippet">{tool.result}</p>
            </div>
          ))
        )}
      </section>

      {message.status === "complete" && (
        <section className="panel">
          <h2 className="panel-title">This answer</h2>
          <div className="panel-body">
            {describe(message.citations.length, succeededTools.length)}
          </div>
        </section>
      )}
    </>
  );
}

function describe(sources: number, tools: number): string {
  if (sources > 0 && tools > 0) {
    return `Combined: ${sources} knowledge-base source${sources === 1 ? "" : "s"} for destination facts and ${tools} live tool result${tools === 1 ? "" : "s"} for current information. Anything beyond those is the model's own planning, and should read as a suggestion.`;
  }
  if (sources > 0) {
    return `Grounded in ${sources} knowledge-base source${sources === 1 ? "" : "s"}. No live data was needed.`;
  }
  if (tools > 0) {
    return `Answered from ${tools} live tool result${tools === 1 ? "" : "s"}. No destination facts were claimed from the knowledge base.`;
  }
  return "No knowledge-base passage matched and no tool ran, so this answer should only describe what the assistant cannot cover.";
}
