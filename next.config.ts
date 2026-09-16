import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Do not scatter generated AGENTS.md / CLAUDE.md files through the repo.
  agentRules: false,
  // Native modules and the MCP SDK must stay outside the bundle so they can be
  // required at runtime and so the tool servers can be spawned as child processes.
  serverExternalPackages: [
    "@huggingface/transformers",
    "@modelcontextprotocol/sdk",
    "faiss-node",
  ],
  outputFileTracingIncludes: {
    "/": ["./README.md"],
    "/api/chat": ["./data/**", "./mcp-servers/**"],
  },
};

export default config;
