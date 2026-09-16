import path from "node:path";

/** Everything on disk is addressed from the repository root, so scripts and the
 *  Next.js server resolve the same files. */
const root = process.cwd();

export const paths = {
  knowledgeBase: path.join(root, "knowledge-base"),
  indexDir: path.join(root, "data"),
  chunksFile: path.join(root, "data", "chunks.json"),
  faissFile: path.join(root, "data", "index.faiss"),
};

/**
 * A problem with how the app is set up - a missing key, an unbuilt index - as
 * opposed to a fault at run time. These messages are written for whoever is
 * running the app and say what to do about it, so they are shown in the UI.
 * Everything else is logged and reported as a generic failure instead.
 */
export class SetupError extends Error {}

export const PROVIDERS = ["google", "openai", "anthropic", "groq"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Defaults chosen for reliable tool calling rather than raw capability. Any of
 *  them can be overridden with LLM_MODEL. */
export const DEFAULT_MODEL: Record<Provider, string> = {
  google: "gemini-3.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  groq: "llama-3.3-70b-versatile",
};

export const API_KEY_VAR: Record<Provider, string> = {
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
};

const provider = (process.env.LLM_PROVIDER ?? "google") as Provider;

export const config = {
  destination: process.env.DESTINATION ?? "Singapore",
  provider,
  model: process.env.LLM_MODEL || DEFAULT_MODEL[provider] || DEFAULT_MODEL.google,
  apiKey: process.env[API_KEY_VAR[provider] ?? "GOOGLE_API_KEY"] ?? "",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  /** Chunks handed to the model per question. */
  topK: Number(process.env.RETRIEVAL_TOP_K ?? 6),
  /** Cosine floor below which we treat the knowledge base as not covering the
   *  question, so the assistant says so instead of inventing destination facts.
   *  Calibrated on this corpus: real travel questions score 0.43-0.75. */
  minScore: Number(process.env.RETRIEVAL_MIN_SCORE ?? 0.38),
  /** Model/tool rounds per turn before we force a final answer. */
  maxToolRounds: 3,
};
