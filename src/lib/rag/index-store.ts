import { readFile } from "node:fs/promises";
import { paths } from "@/lib/config/paths";
import { createLogger } from "@/lib/logger";
import { LexicalIndex } from "@/lib/rag/lexical";
import { VectorStore } from "@/lib/rag/vector-store";
import type { SourceDocument, VectorIndexFile } from "@/lib/types";

const log = createLogger("rag");

export class IndexNotBuiltError extends Error {
  constructor(cause?: unknown) {
    super(
      `No vector index found at ${paths.indexFile}. Build it once with \`npm run kb:ingest\` ` +
        `(see the Setup section of the README).`,
      { cause },
    );
    this.name = "IndexNotBuiltError";
  }
}

export interface KnowledgeBase {
  vectors: VectorStore;
  lexical: LexicalIndex;
  documents: Map<string, SourceDocument>;
  meta: Omit<VectorIndexFile, "chunks" | "documents">;
}

let pending: Promise<KnowledgeBase> | null = null;

/**
 * Loads and caches the index. The whole corpus is a few megabytes of JSON, so
 * it is read once per process and shared across requests; a rebuild requires a
 * server restart, which is the right trade for a corpus that changes on a
 * deploy cadence rather than a request cadence.
 */
export function getKnowledgeBase(): Promise<KnowledgeBase> {
  pending ??= load().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

export function invalidateKnowledgeBase(): void {
  pending = null;
}

async function load(): Promise<KnowledgeBase> {
  const started = performance.now();

  let raw: string;
  try {
    raw = await readFile(paths.indexFile, "utf8");
  } catch (cause) {
    throw new IndexNotBuiltError(cause);
  }

  const index = JSON.parse(raw) as VectorIndexFile;
  if (index.version !== 1) {
    throw new Error(`Unsupported index version ${index.version}; rebuild with \`npm run kb:ingest\`.`);
  }
  if (index.chunks.length === 0) {
    throw new Error("The index is empty. Check that knowledge-base/ contains markdown documents.");
  }

  const knowledgeBase: KnowledgeBase = {
    vectors: new VectorStore(index.chunks),
    lexical: new LexicalIndex(index.chunks),
    documents: new Map(index.documents.map((document) => [document.id, document])),
    meta: {
      version: index.version,
      destination: index.destination,
      embedding: index.embedding,
      builtAt: index.builtAt,
    },
  };

  log.info(
    `Loaded ${index.chunks.length} chunks from ${index.documents.length} documents ` +
      `(${index.embedding.provider}/${index.embedding.model}, ${index.embedding.dimensions}d) ` +
      `in ${Math.round(performance.now() - started)}ms`,
  );

  return knowledgeBase;
}
