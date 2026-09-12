import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { apiKeyFor, getEnv, type AppEnv, type LlmProvider } from "@/lib/config/env";

/**
 * Defaults chosen for tool-calling reliability and cost, not for raw capability.
 * Every one of them is overridable with LLM_MODEL.
 */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  groq: "llama-3.3-70b-versatile",
  google: "gemini-2.5-flash",
};

const KEY_ENV_VAR: Record<LlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GOOGLE_API_KEY",
};

export class MissingApiKeyError extends Error {
  constructor(readonly provider: LlmProvider) {
    super(
      `${provider} is selected as LLM_PROVIDER but ${KEY_ENV_VAR[provider]} is not set. ` +
        `Add it to .env.local, or switch LLM_PROVIDER to a provider you have a key for.`,
    );
    this.name = "MissingApiKeyError";
  }
}

export interface ChatModelHandle {
  model: BaseChatModel;
  provider: LlmProvider;
  modelName: string;
}

export function defaultModelFor(provider: LlmProvider): string {
  return DEFAULT_MODELS[provider];
}

/**
 * Builds the chat model for the configured provider. The provider SDKs are
 * imported lazily so that a deployment only ever loads the one it uses, and so
 * that a missing optional dependency never breaks an unrelated provider.
 */
export async function createChatModel(env: AppEnv = getEnv()): Promise<ChatModelHandle> {
  const provider = env.LLM_PROVIDER;
  const apiKey = apiKeyFor(provider, env);
  if (!apiKey) throw new MissingApiKeyError(provider);

  const modelName = env.LLM_MODEL ?? DEFAULT_MODELS[provider];
  const temperature = env.LLM_TEMPERATURE;
  const maxTokens = env.LLM_MAX_TOKENS;

  const model = await instantiate(provider, {
    apiKey,
    modelName,
    temperature,
    maxTokens,
    baseUrl: env.OPENAI_BASE_URL,
  });

  return { model, provider, modelName };
}

interface ModelArgs {
  apiKey: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
  baseUrl?: string;
}

async function instantiate(provider: LlmProvider, args: ModelArgs): Promise<BaseChatModel> {
  switch (provider) {
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({
        apiKey: args.apiKey,
        model: args.modelName,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        maxRetries: 2,
        ...(args.baseUrl ? { configuration: { baseURL: args.baseUrl } } : {}),
      });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({
        apiKey: args.apiKey,
        model: args.modelName,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        maxRetries: 2,
      });
    }
    case "groq": {
      const { ChatGroq } = await import("@langchain/groq");
      return new ChatGroq({
        apiKey: args.apiKey,
        model: args.modelName,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        maxRetries: 2,
      });
    }
    case "google": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({
        apiKey: args.apiKey,
        model: args.modelName,
        temperature: args.temperature,
        maxOutputTokens: args.maxTokens,
        maxRetries: 2,
      });
    }
  }
}
