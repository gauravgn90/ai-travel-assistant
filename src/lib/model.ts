import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { API_KEY_VAR, PROVIDERS, SetupError, config } from "./config.ts";

/**
 * Builds the chat model for the configured provider.
 *
 * The provider SDKs are imported lazily so a deployment only loads the one it
 * uses. Nothing downstream knows which provider it got - the agent drives a
 * BaseChatModel - so switching LLM_PROVIDER is a configuration change, never a
 * code change.
 */
export async function createModel(): Promise<BaseChatModel> {
  const { provider, model, apiKey } = config;

  if (!PROVIDERS.includes(provider)) {
    throw new SetupError(`LLM_PROVIDER must be one of: ${PROVIDERS.join(", ")}. Got "${provider}".`);
  }

  if (!apiKey) {
    throw new SetupError(
      `${API_KEY_VAR[provider]} is not set, but LLM_PROVIDER is "${provider}". ` +
        `Add the key to .env.local and restart, or switch LLM_PROVIDER to a provider you have a key for.`,
    );
  }

  const shared = { apiKey, model, temperature: 0.2, maxRetries: 2 };

  switch (provider) {
    case "google": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({ ...shared, maxOutputTokens: 4096 });
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({ ...shared, maxTokens: 4096 });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({ ...shared, maxTokens: 4096 });
    }
    case "groq": {
      const { ChatGroq } = await import("@langchain/groq");
      return new ChatGroq({ ...shared, maxTokens: 4096 });
    }
  }
}
