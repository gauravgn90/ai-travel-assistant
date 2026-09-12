import { z } from "zod";

export const LLM_PROVIDERS = ["openai", "anthropic", "groq", "google"] as const;
export const EMBEDDING_PROVIDERS = ["openai", "google", "local"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

const schema = z.object({
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default("openai"),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  /**
   * Points the OpenAI-compatible providers at a different host. Set it to use
   * Ollama, LM Studio, vLLM, OpenRouter or an Azure deployment without any
   * other change: OPENAI_BASE_URL=http://localhost:11434/v1.
   */
  OPENAI_BASE_URL: z.string().url().optional(),

  EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),

  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),

  DESTINATION: z.string().min(1).default("Singapore"),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  /**
   * Absolute cosine floor for deciding the knowledge base covers a question at
   * all. Measured on this corpus with all-MiniLM-L6-v2: genuine destination
   * questions score 0.43-0.75, clearly off-topic ones 0.08-0.35. It is
   * embedding-model dependent — `npm run kb:search` prints the value so it can
   * be recalibrated after switching models.
   */
  RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.38),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type AppEnv = z.infer<typeof schema>;

/**
 * Embedding vendors that Anthropic and Groq do not offer. Both are chat-only
 * APIs, so when one of them drives the conversation the index has to be built
 * with a different vendor.
 */
const CHAT_ONLY_PROVIDERS = new Set<LlmProvider>(["anthropic", "groq"]);

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Only used by tests, which mutate process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}

export function apiKeyFor(provider: LlmProvider, env: AppEnv = getEnv()): string | undefined {
  switch (provider) {
    case "openai":
      return env.OPENAI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "groq":
      return env.GROQ_API_KEY;
    case "google":
      return env.GOOGLE_API_KEY;
  }
}

/**
 * Resolves which vendor generates embeddings. An explicit EMBEDDING_PROVIDER
 * always wins. Otherwise we reuse the chat provider when it also sells an
 * embedding endpoint, and fall back to the bundled local model when it does
 * not, so an Anthropic- or Groq-only setup still works out of the box.
 */
export function resolveEmbeddingProvider(env: AppEnv = getEnv()): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER) return env.EMBEDDING_PROVIDER;
  if (CHAT_ONLY_PROVIDERS.has(env.LLM_PROVIDER)) return "local";
  return env.LLM_PROVIDER === "google" ? "google" : "openai";
}

export function configuredProviders(env: AppEnv = getEnv()): LlmProvider[] {
  return LLM_PROVIDERS.filter((provider) => Boolean(apiKeyFor(provider, env)));
}
