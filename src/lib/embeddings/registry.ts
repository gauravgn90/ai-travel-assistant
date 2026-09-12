import type { Embeddings } from "@langchain/core/embeddings";
import {
  getEnv,
  resolveEmbeddingProvider,
  type AppEnv,
  type EmbeddingProvider,
} from "@/lib/config/env";
import { LocalEmbeddings } from "@/lib/embeddings/local";

const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  google: "text-embedding-004",
  local: "Xenova/all-MiniLM-L6-v2",
};

export interface EmbeddingsHandle {
  embeddings: Embeddings;
  provider: EmbeddingProvider;
  model: string;
}

export async function createEmbeddings(env: AppEnv = getEnv()): Promise<EmbeddingsHandle> {
  const provider = resolveEmbeddingProvider(env);
  const model = env.EMBEDDING_MODEL ?? DEFAULT_MODELS[provider];

  switch (provider) {
    case "openai": {
      if (!env.OPENAI_API_KEY) throw missingKey("openai", "OPENAI_API_KEY");
      const { OpenAIEmbeddings } = await import("@langchain/openai");
      return {
        provider,
        model,
        embeddings: new OpenAIEmbeddings({
          apiKey: env.OPENAI_API_KEY,
          model,
          batchSize: 96,
        }),
      };
    }
    case "google": {
      if (!env.GOOGLE_API_KEY) throw missingKey("google", "GOOGLE_API_KEY");
      const { GoogleGenerativeAIEmbeddings } = await import("@langchain/google-genai");
      return {
        provider,
        model,
        embeddings: new GoogleGenerativeAIEmbeddings({
          apiKey: env.GOOGLE_API_KEY,
          model,
        }),
      };
    }
    case "local":
      return { provider, model, embeddings: new LocalEmbeddings({ model }) };
  }
}

function missingKey(provider: EmbeddingProvider, envVar: string): Error {
  return new Error(
    `Embedding provider "${provider}" needs ${envVar}. Set it, or use EMBEDDING_PROVIDER=local ` +
      `to embed on-device with no API key.`,
  );
}
