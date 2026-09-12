/**
 * Prints what is actually in the built index: documents, chunk counts, size
 * distribution and the embedding model used.
 *
 * Mostly useful after changing the chunker — a jump in the number of very small
 * or very large chunks is the first sign that a tuning change made retrieval
 * worse, and it shows up here long before it shows up in an answer.
 *
 * Usage: npm run kb:stats
 */
import { paths } from "../src/lib/config/paths.ts";
import { getKnowledgeBase } from "../src/lib/rag/index-store.ts";

const knowledgeBase = await getKnowledgeBase();
const chunks = knowledgeBase.vectors.all();

console.log(`Index:      ${paths.indexFile}`);
console.log(`Built:      ${knowledgeBase.meta.builtAt}`);
console.log(
  `Embeddings: ${knowledgeBase.meta.embedding.provider}/${knowledgeBase.meta.embedding.model} ` +
    `(${knowledgeBase.meta.embedding.dimensions}d)`,
);
console.log(`Chunks:     ${chunks.length} across ${knowledgeBase.documents.size} documents\n`);

const byDocument = new Map<string, number[]>();
for (const chunk of chunks) {
  const sizes = byDocument.get(chunk.documentId) ?? [];
  sizes.push(chunk.tokensEstimate);
  byDocument.set(chunk.documentId, sizes);
}

console.log("Document                                Chunks   Tokens   Median  Publisher");
console.log("-".repeat(94));

for (const [id, sizes] of [...byDocument].sort((a, b) => b[1].length - a[1].length)) {
  const document = knowledgeBase.documents.get(id);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  console.log(
    `${id.padEnd(40)}${String(sizes.length).padStart(6)}` +
      `${total.toLocaleString().padStart(9)}${String(median(sizes)).padStart(9)}  ` +
      `${document?.publisher ?? "?"}`,
  );
}

const allSizes = chunks.map((chunk) => chunk.tokensEstimate).sort((a, b) => a - b);
const buckets = [0, 50, 100, 200, 300, 400, 500, Infinity];

console.log("\nChunk size distribution (estimated tokens)");
for (let i = 0; i < buckets.length - 1; i += 1) {
  const low = buckets[i]!;
  const high = buckets[i + 1]!;
  const count = allSizes.filter((size) => size >= low && size < high).length;
  const label = high === Infinity ? `${low}+` : `${low}–${high}`;
  console.log(
    `  ${label.padEnd(10)} ${String(count).padStart(4)}  ${"#".repeat(Math.round((count / chunks.length) * 60))}`,
  );
}

console.log(
  `\n  min ${allSizes.at(0)}   median ${median(allSizes)}   ` +
    `p95 ${allSizes[Math.floor(allSizes.length * 0.95)]}   max ${allSizes.at(-1)}`,
);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}
