/**
 * Builds the vector index from the markdown knowledge base.
 *
 * Chunking and embedding happen here, ahead of time, rather than at request
 * time: it is the one expensive step in the pipeline, it is deterministic, and
 * the output is a single file the server can memory-map on boot.
 *
 * Usage: npm run kb:ingest
 */
import { mkdir, writeFile } from "node:fs/promises";
import { getEnv } from "../src/lib/config/env.ts";
import { paths } from "../src/lib/config/paths.ts";
import { createEmbeddings } from "../src/lib/embeddings/registry.ts";
import { chunkDocument } from "../src/lib/rag/chunker.ts";
import { loadDocuments } from "../src/lib/rag/documents.ts";
import type { IndexedChunk, KnowledgeChunk, VectorIndexFile } from "../src/lib/types.ts";

const EMBED_BATCH = 64;

function progress(done: number, total: number, label: string): void {
  const width = 28;
  const filled = Math.round((done / total) * width);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const pct = ((done / total) * 100).toFixed(0).padStart(3);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${label}`);
  if (done === total) process.stdout.write("\n");
}

async function main(): Promise<void> {
  const env = getEnv();
  const startedAt = Date.now();

  console.log(`Reading knowledge base from ${paths.knowledgeBase}`);
  const documents = await loadDocuments();

  const chunks: KnowledgeChunk[] = [];
  for (const document of documents) {
    const documentChunks = chunkDocument(document.metadata.id, document.body);
    chunks.push(...documentChunks);

    const tokens = documentChunks.reduce((sum, chunk) => sum + chunk.tokensEstimate, 0);
    console.log(
      `  ${document.metadata.id.padEnd(38)} ${String(documentChunks.length).padStart(4)} chunks  ` +
        `~${tokens.toLocaleString()} tokens`,
    );
  }

  if (chunks.length === 0) {
    throw new Error("Chunking produced nothing. Are the markdown files empty below their front matter?");
  }

  const { embeddings, provider, model } = await createEmbeddings(env);
  console.log(`\nEmbedding ${chunks.length} chunks with ${provider}/${model}`);

  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH);
    vectors.push(...(await embeddings.embedDocuments(batch.map(toEmbeddingInput))));
    progress(vectors.length, chunks.length, `${vectors.length}/${chunks.length} chunks`);
  }

  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions === 0) throw new Error("The embedding provider returned empty vectors.");

  const indexed: IndexedChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: vectors[i]!,
  }));

  const index: VectorIndexFile = {
    version: 1,
    destination: env.DESTINATION,
    embedding: { provider, model, dimensions },
    builtAt: new Date().toISOString(),
    documents: documents.map((document) => document.metadata),
    chunks: indexed,
  };

  await mkdir(paths.indexDir, { recursive: true });
  await writeFile(paths.indexFile, JSON.stringify(index), "utf8");

  const sizeMb = (Buffer.byteLength(JSON.stringify(index)) / 1024 / 1024).toFixed(1);
  console.log(
    `\nWrote ${paths.indexFile}\n` +
      `  ${documents.length} documents, ${indexed.length} chunks, ${dimensions} dimensions, ${sizeMb} MB\n` +
      `  built in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

/**
 * Prefixing each chunk with its heading path gives the embedding the topical
 * context that a mid-document passage otherwise lacks — a paragraph about
 * opening hours is far more findable when the vector also knows it sits under
 * "Sentosa > S.E.A. Aquarium".
 */
function toEmbeddingInput(chunk: KnowledgeChunk): string {
  return chunk.headings.length > 0
    ? `${chunk.headings.join(" > ")}\n\n${chunk.text}`
    : chunk.text;
}

await main();
