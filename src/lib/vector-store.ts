import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SetupError, paths } from "./config.ts";
import type { Chunk } from "./types.ts";

/** The slice of faiss-node this file uses. faiss-node is CommonJS and ships no
 *  types, so the shape is declared here rather than imported. */
interface FaissIndex {
  ntotal(): number;
  add(vectors: number[]): void;
  search(query: number[], k: number): { distances: number[]; labels: number[] };
  write(file: string): void;
}

interface Faiss {
  IndexFlatIP: { new (dimensions: number): FaissIndex; read(file: string): FaissIndex };
}

async function faiss(): Promise<Faiss> {
  const loaded = await import("faiss-node");
  // faiss-node is CommonJS and assigns module.exports wholesale, so it has no
  // named ESM exports - hence the interop through .default.
  return ((loaded as { default?: unknown }).default ?? loaded) as Faiss;
}

/** Builds the index and writes it next to the chunk metadata. Embeddings are
 *  already normalised, so an inner-product index ranks by cosine similarity. */
export async function saveIndex(chunks: Chunk[], vectors: number[][]): Promise<void> {
  const { IndexFlatIP } = await faiss();
  const index = new IndexFlatIP(vectors[0]!.length);
  index.add(vectors.flat());

  await mkdir(paths.indexDir, { recursive: true });
  index.write(paths.faissFile);
  await writeFile(paths.chunksFile, JSON.stringify(chunks), "utf8");
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

let store: Promise<{ index: FaissIndex; chunks: Chunk[] }> | null = null;

/** Loaded once per process and shared across requests - the corpus changes on a
 *  rebuild, not on a request. */
function open() {
  store ??= (async () => {
    const { IndexFlatIP } = await faiss();

    let chunks: Chunk[];
    try {
      chunks = JSON.parse(await readFile(paths.chunksFile, "utf8")) as Chunk[];
    } catch (cause) {
      store = null;
      throw new SetupError("No index found.", { cause });
    }

    const index = IndexFlatIP.read(paths.faissFile);
    if (index.ntotal() !== chunks.length) {
      store = null;
      throw new SetupError("The index and its chunk metadata disagree.");
    }

    return { index, chunks };
  })();

  return store;
}

export async function search(queryVector: number[], k: number): Promise<Hit[]> {
  const { index, chunks } = await open();
  const { labels, distances } = index.search(queryVector, Math.min(k, chunks.length));

  // FAISS pads short result sets with -1 labels rather than returning fewer rows.
  return labels
    .map((label, i) => ({ chunk: chunks[label]!, score: distances[i] ?? 0 }))
    .filter((hit) => hit.chunk);
}
