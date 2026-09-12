import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The MCP SDK, the LangChain provider packages and the optional local
  // embedding runtime all reach for Node built-ins and native bindings. Keeping
  // them external stops Turbopack from trying to bundle them into the server
  // build, which is both faster and avoids a pile of "module not found: fs"
  // style failures.
  serverExternalPackages: [
    "@modelcontextprotocol/sdk",
    "@huggingface/transformers",
    "@langchain/anthropic",
    "@langchain/google-genai",
    "@langchain/groq",
    "@langchain/openai",
  ],
  outputFileTracingIncludes: {
    "/api/chat": ["./data/index/**", "./knowledge-base/**", "./mcp-servers/**"],
  },
};

export default config;
