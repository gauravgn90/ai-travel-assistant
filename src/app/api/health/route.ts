import {
  apiKeyFor,
  configuredProviders,
  getEnv,
  resolveEmbeddingProvider,
} from "@/lib/config/env";
import { defaultModelFor } from "@/lib/llm/registry";
import { getMcpRegistry } from "@/lib/mcp/client";
import { getKnowledgeBase } from "@/lib/rag/index-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe and the UI's status bar in one.
 *
 * Each subsystem is reported independently so a half-configured install says
 * which half is missing — "the index is not built" and "the Groq key is absent"
 * are very different problems and should never surface as one generic failure.
 * Never returns the API keys themselves, only whether they are present.
 */
export async function GET(): Promise<Response> {
  const env = getEnv();

  const [knowledgeBase, mcp] = await Promise.allSettled([getKnowledgeBase(), getMcpRegistry()]);

  const body = {
    destination: env.DESTINATION,
    llm: {
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL ?? defaultModelFor(env.LLM_PROVIDER),
      keyPresent: Boolean(apiKeyFor(env.LLM_PROVIDER, env)),
      configuredProviders: configuredProviders(env),
    },
    embeddings: {
      provider: resolveEmbeddingProvider(env),
      model: env.EMBEDDING_MODEL ?? null,
    },
    knowledgeBase:
      knowledgeBase.status === "fulfilled"
        ? {
            ready: true,
            chunks: knowledgeBase.value.vectors.size,
            dimensions: knowledgeBase.value.vectors.dimensions,
            documents: knowledgeBase.value.documents.size,
            builtWith: knowledgeBase.value.meta.embedding,
            builtAt: knowledgeBase.value.meta.builtAt,
          }
        : { ready: false, error: reason(knowledgeBase.reason) },
    mcp:
      mcp.status === "fulfilled"
        ? { ready: mcp.value.hasTools(), servers: mcp.value.status() }
        : { ready: false, error: reason(mcp.reason) },
  };

  const ready = body.knowledgeBase.ready && body.llm.keyPresent;
  return Response.json({ ready, ...body }, { status: ready ? 200 : 503 });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
