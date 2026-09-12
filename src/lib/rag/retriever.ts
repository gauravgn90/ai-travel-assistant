import type { Embeddings } from "@langchain/core/embeddings";
import { getEnv } from "@/lib/config/env";
import { createLogger } from "@/lib/logger";
import { getKnowledgeBase } from "@/lib/rag/index-store";
import type { Citation, IndexedChunk, RetrievedChunk } from "@/lib/types";

const log = createLogger("rag:retriever");

/** Rank constant from the reciprocal-rank-fusion paper; 60 is the usual choice. */
const RRF_K = 60;

export interface RetrieveOptions {
  topK?: number;
  /** Candidates pulled from each ranker before fusion. */
  candidateK?: number;
  minSimilarity?: number;
  /** Ceiling on chunks taken from any one source document. */
  maxPerDocument?: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** True when the corpus does not cover the question — the caller must not invent facts. */
  gap: boolean;
  /** Cosine of the single closest chunk; the evidence behind `gap`. */
  bestSimilarity: number;
  query: string;
}

/**
 * Hybrid retrieval: dense cosine similarity fused with BM25 by reciprocal rank.
 *
 * RRF is used instead of a weighted score blend because the two rankers produce
 * scores on incomparable scales (bounded cosine vs. unbounded BM25), and tuning
 * a blend weight per corpus is exactly the kind of hidden constant that rots.
 */
export async function retrieve(
  query: string,
  embeddings: Embeddings,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const env = getEnv();
  const topK = options.topK ?? env.RETRIEVAL_TOP_K;
  const candidateK = options.candidateK ?? Math.max(topK * 3, 15);
  const minSimilarity = options.minSimilarity ?? env.RETRIEVAL_MIN_SIMILARITY;

  const knowledgeBase = await getKnowledgeBase();
  const rows = knowledgeBase.vectors.all();

  const started = performance.now();
  const queryEmbedding = await embeddings.embedQuery(query);

  const dense = knowledgeBase.vectors.search(queryEmbedding, candidateK);
  const lexical = knowledgeBase.lexical.search(query, candidateK);

  // Coverage is judged on raw cosine, never on the fused score. Reciprocal rank
  // fusion is ordinal: whatever ranks first scores 1.0, however irrelevant it
  // is, so a fused-score threshold would pass every query ever asked. The
  // closest chunk's actual similarity is the only signal here that says
  // anything about whether the corpus contains an answer at all.
  const bestSimilarity = round(dense[0]?.score ?? 0);
  if (bestSimilarity < minSimilarity) {
    log.debug(
      `"${truncate(query, 60)}" -> gap (best cosine ${bestSimilarity} < ${minSimilarity})`,
    );
    return { chunks: [], gap: true, bestSimilarity, query };
  }

  const fused = new Map<
    string,
    { chunk: IndexedChunk; rrf: number; semanticScore: number; lexicalScore: number }
  >();

  dense.forEach(({ chunk, score }, rank) => {
    fused.set(chunk.id, {
      chunk,
      rrf: 1 / (RRF_K + rank + 1),
      semanticScore: score,
      lexicalScore: 0,
    });
  });

  const topLexicalScore = lexical[0]?.score ?? 0;
  lexical.forEach(({ row, score }, rank) => {
    const chunk = rows[row];
    if (!chunk) return;

    const normalised = topLexicalScore > 0 ? score / topLexicalScore : 0;
    const existing = fused.get(chunk.id);
    if (existing) {
      existing.rrf += 1 / (RRF_K + rank + 1);
      existing.lexicalScore = normalised;
    } else {
      fused.set(chunk.id, {
        chunk,
        rrf: 1 / (RRF_K + rank + 1),
        semanticScore: 0,
        lexicalScore: normalised,
      });
    }
  });

  // The theoretical maximum is rank 1 in both rankers; scaling against it keeps
  // the reported score in [0, 1] and comparable to the configured floor.
  const maxRrf = 2 / (RRF_K + 1);

  const ranked = [...fused.values()]
    .map((entry) => ({ ...entry, score: entry.rrf / maxRrf }))
    .sort((a, b) => b.score - a.score);

  // A single long article can otherwise own every slot: the Wikivoyage
  // Singapore page alone is a third of the corpus. Capping per document keeps
  // more than one source in front of the model and, because citations collapse
  // per document, keeps more than one link in front of the reader.
  const maxPerDocument = options.maxPerDocument ?? Math.max(2, Math.ceil(topK / 2));
  const perDocument = new Map<string, number>();

  const chunks: RetrievedChunk[] = [];
  for (const entry of ranked) {
    if (chunks.length >= topK) break;

    const taken = perDocument.get(entry.chunk.documentId) ?? 0;
    if (taken >= maxPerDocument) continue;

    const document = knowledgeBase.documents.get(entry.chunk.documentId);
    if (!document) {
      log.warn(`Chunk ${entry.chunk.id} references unknown document ${entry.chunk.documentId}`);
      continue;
    }

    perDocument.set(entry.chunk.documentId, taken + 1);
    chunks.push({
      chunk: entry.chunk,
      document,
      score: round(entry.score),
      semanticScore: round(entry.semanticScore),
      lexicalScore: round(entry.lexicalScore),
    });
  }

  log.debug(
    `"${truncate(query, 60)}" -> ${chunks.length}/${fused.size} chunks in ${Math.round(performance.now() - started)}ms`,
  );

  return { chunks, gap: chunks.length === 0, bestSimilarity, query };
}

/**
 * Numbers the retrieved chunks as [S1], [S2], ... Chunks from the same source
 * document collapse onto one marker so the answer cites documents, not offsets,
 * which is what a reader actually wants to click.
 */
export function toCitations(chunks: RetrievedChunk[]): Citation[] {
  const byDocument = new Map<string, Citation>();

  for (const retrieved of chunks) {
    const existing = byDocument.get(retrieved.document.id);
    if (existing) {
      for (const heading of retrieved.chunk.headings) {
        if (!existing.headings.includes(heading)) existing.headings.push(heading);
      }
      existing.score = Math.max(existing.score, retrieved.score);
      continue;
    }

    byDocument.set(retrieved.document.id, {
      marker: `S${byDocument.size + 1}`,
      title: retrieved.document.title,
      url: retrieved.document.url,
      publisher: retrieved.document.publisher,
      headings: [...retrieved.chunk.headings],
      snippet: truncate(retrieved.chunk.text.replace(/\s+/g, " "), 220),
      score: retrieved.score,
    });
  }

  return [...byDocument.values()];
}

/** Renders retrieved chunks as the KNOWLEDGE BASE block of the prompt. */
export function formatContext(chunks: RetrievedChunk[], citations: Citation[]): string {
  const markerByDocument = new Map(
    citations.map((citation) => [citation.title, citation.marker] as const),
  );

  return chunks
    .map((retrieved) => {
      const marker = markerByDocument.get(retrieved.document.title) ?? "S?";
      const path = retrieved.chunk.headings.length
        ? ` > ${retrieved.chunk.headings.join(" > ")}`
        : "";
      return `[${marker}] ${retrieved.document.title}${path}\n${retrieved.chunk.text}`;
    })
    .join("\n\n---\n\n");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
