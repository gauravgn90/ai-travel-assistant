/**
 * Builds the vector index from the markdown knowledge base.
 *
 * Chunking and embedding happen here, ahead of time, rather than per request:
 * it is the one slow step, it is deterministic, and the output is two files the
 * server reads once on boot.
 *
 * Usage: npm run ingest
 */
import { embed } from "../src/lib/embeddings.ts";
import { embeddingText, loadChunks } from "../src/lib/knowledge-base.ts";
import { saveIndex } from "../src/lib/vector-store.ts";
import { config, paths } from "../src/lib/config.ts";

const started = Date.now();

console.log(`Reading ${paths.knowledgeBase}`);
const chunks = await loadChunks();

const documents = new Set(chunks.map((chunk) => chunk.document.id));
console.log(`${documents.size} documents, ${chunks.length} chunks`);

console.log(`Embedding with ${config.embeddingModel}`);
const vectors = await embed(chunks.map(embeddingText));

await saveIndex(chunks, vectors);

console.log(
  `Wrote ${paths.faissFile} and ${paths.chunksFile} ` +
    `(${vectors[0]!.length} dimensions) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
