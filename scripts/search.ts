/**
 * Retrieval probe. Runs the hybrid retriever against the built index and prints
 * what would be put in front of the model, without calling an LLM.
 *
 * This is the fastest way to tell a retrieval problem apart from a generation
 * problem, and it runs on no API quota at all when EMBEDDING_PROVIDER=local.
 *
 * Usage: npm run kb:search -- "what indoor attractions can I visit?"
 */
import { getEnv } from "../src/lib/config/env.ts";
import { createEmbeddings } from "../src/lib/embeddings/registry.ts";
import { getKnowledgeBase } from "../src/lib/rag/index-store.ts";
import { retrieve, toCitations } from "../src/lib/rag/retriever.ts";

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('Usage: npm run kb:search -- "your question"');
  process.exit(1);
}

const env = getEnv();
const knowledgeBase = await getKnowledgeBase();
const { embeddings, provider, model } = await createEmbeddings(env);

if (knowledgeBase.meta.embedding.model !== model) {
  console.warn(
    `Warning: the index was built with ${knowledgeBase.meta.embedding.provider}/` +
      `${knowledgeBase.meta.embedding.model} but the current configuration is ${provider}/${model}. ` +
      `Scores will be meaningless. Rebuild with \`npm run kb:ingest\`.\n`,
  );
}

const started = performance.now();
const result = await retrieve(query, embeddings);
const elapsed = Math.round(performance.now() - started);

console.log(`\nQuery: ${query}`);
console.log(`Index: ${knowledgeBase.vectors.size} chunks, ${knowledgeBase.vectors.dimensions}d`);
console.log(`Took:  ${elapsed}ms`);
console.log(
  `Best cosine: ${result.bestSimilarity.toFixed(3)} ` +
    `(coverage floor RETRIEVAL_MIN_SIMILARITY=${env.RETRIEVAL_MIN_SIMILARITY})\n`,
);

if (result.gap) {
  console.log(
    "Below the floor: the assistant would tell the user the knowledge base does not cover this, " +
      "rather than answer destination facts from the model's own memory.\n",
  );
  process.exit(0);
}

for (const [position, retrieved] of result.chunks.entries()) {
  const path = retrieved.chunk.headings.join(" > ") || "(document root)";
  console.log(
    `${String(position + 1).padStart(2)}. ${retrieved.document.title}\n` +
      `    ${path}\n` +
      `    fused ${retrieved.score.toFixed(3)}   ` +
      `cosine ${retrieved.semanticScore.toFixed(3)}   bm25 ${retrieved.lexicalScore.toFixed(3)}\n` +
      `    ${retrieved.chunk.text.replace(/\s+/g, " ").slice(0, 180)}…\n`,
  );
}

console.log("Citations the answer would carry:");
for (const citation of toCitations(result.chunks)) {
  console.log(`  [${citation.marker}] ${citation.title} — ${citation.url}`);
}
