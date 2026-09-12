import type { IndexedChunk } from "@/lib/types";

export interface ScoredChunk {
  chunk: IndexedChunk;
  score: number;
}

/**
 * Flat, in-memory cosine index persisted as a single JSON file.
 *
 * The Singapore corpus is a few hundred chunks, so an exhaustive scan is exact,
 * costs well under a millisecond, and avoids both the native build step that
 * faiss-node needs and the separate server process that Chroma needs. The
 * interface is deliberately the small one an ANN index would also satisfy, so
 * swapping in a real ANN backend later is a single file change.
 */
export class VectorStore {
  private readonly chunks: IndexedChunk[];
  private readonly matrix: Float32Array;
  readonly dimensions: number;

  constructor(chunks: IndexedChunk[]) {
    this.chunks = chunks;
    this.dimensions = chunks[0]?.embedding.length ?? 0;

    const mismatch = chunks.find((chunk) => chunk.embedding.length !== this.dimensions);
    if (mismatch) {
      throw new Error(
        `Chunk ${mismatch.id} has ${mismatch.embedding.length} dimensions, expected ${this.dimensions}. ` +
          `The index was probably built with a different embedding model — rebuild it with \`npm run kb:ingest\`.`,
      );
    }

    // Vectors are L2-normalised once at load time so search is a plain dot product.
    this.matrix = new Float32Array(chunks.length * this.dimensions);
    chunks.forEach((chunk, row) => {
      const normalised = normalise(chunk.embedding);
      this.matrix.set(normalised, row * this.dimensions);
    });
  }

  get size(): number {
    return this.chunks.length;
  }

  search(queryEmbedding: number[], k: number): ScoredChunk[] {
    if (this.chunks.length === 0) return [];
    if (queryEmbedding.length !== this.dimensions) {
      throw new Error(
        `Query embedding has ${queryEmbedding.length} dimensions but the index has ${this.dimensions}.`,
      );
    }

    const query = normalise(queryEmbedding);
    const scored: ScoredChunk[] = new Array(this.chunks.length);

    for (let row = 0; row < this.chunks.length; row += 1) {
      const offset = row * this.dimensions;
      let dot = 0;
      for (let col = 0; col < this.dimensions; col += 1) {
        dot += (this.matrix[offset + col] as number) * (query[col] as number);
      }
      scored[row] = { chunk: this.chunks[row]!, score: dot };
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }

  all(): readonly IndexedChunk[] {
    return this.chunks;
  }
}

function normalise(vector: number[] | Float32Array): Float32Array {
  const out = new Float32Array(vector.length);
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) sumSquares += (vector[i] as number) ** 2;

  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) return out;

  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] as number) / magnitude;
  return out;
}
