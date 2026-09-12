"use client";

import { useEffect, useState } from "react";

interface Health {
  ready: boolean;
  llm: { provider: string; model: string; keyPresent: boolean };
  embeddings: { provider: string };
  knowledgeBase: { ready: boolean; chunks?: number; documents?: number; error?: string };
  mcp: { ready: boolean; servers?: Array<{ serverId: string; connected: boolean; toolCount: number }> };
}

/**
 * Surfaces the readiness probe in the UI. A missing API key or an unbuilt index
 * is otherwise only discovered by asking a question and getting an error, which
 * is a poor first-run experience for something with three separate setup steps.
 */
export function StatusBar() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then((response) => response.json() as Promise<Health>)
      .then(setHealth)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailed(true);
        void error;
      });

    return () => controller.abort();
  }, []);

  if (failed) {
    return (
      <div className="status-bar">
        <span className="pill">
          <span className="dot bad" /> Cannot reach the server
        </span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="status-bar">
        <span className="pill">
          <span className="dot" /> Checking configuration…
        </span>
      </div>
    );
  }

  const connectedServers = health.mcp.servers?.filter((server) => server.connected) ?? [];
  const toolCount = connectedServers.reduce((sum, server) => sum + server.toolCount, 0);

  return (
    <div className="status-bar">
      <span className="pill">
        <span className={`dot ${health.llm.keyPresent ? "ok" : "bad"}`} />
        {health.llm.keyPresent ? (
          <>
            Model <code>{health.llm.provider}/{health.llm.model}</code>
          </>
        ) : (
          <>
            No <code>{health.llm.provider.toUpperCase()}_API_KEY</code>
          </>
        )}
      </span>

      <span className="pill">
        <span className={`dot ${health.knowledgeBase.ready ? "ok" : "bad"}`} />
        {health.knowledgeBase.ready
          ? `${health.knowledgeBase.chunks} chunks · ${health.knowledgeBase.documents} documents`
          : "Index not built — run npm run kb:ingest"}
      </span>

      <span className="pill">
        <span className={`dot ${health.mcp.ready ? "ok" : "bad"}`} />
        {health.mcp.ready
          ? `${toolCount} MCP tools · ${connectedServers.map((s) => s.serverId).join(", ")}`
          : "No MCP servers connected"}
      </span>

      <span className="pill">
        <span className="dot ok" /> Embeddings <code>{health.embeddings.provider}</code>
      </span>
    </div>
  );
}
