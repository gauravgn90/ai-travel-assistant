import type { KnowledgeChunk } from "@/lib/types";

const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "get", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on",
  "or", "should", "so", "that", "the", "there", "they", "this", "to", "was", "we", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

interface Posting {
  row: number;
  frequency: number;
}

/**
 * BM25 over the same chunks the vector store holds.
 *
 * Dense retrieval alone is weak on the queries travellers actually ask, which
 * are full of proper nouns the embedding model has never specialised on —
 * "Haw Par Villa", "EZ-Link", "Jewel Changi". Exact term matching recovers
 * those; the hybrid retriever fuses the two rankings.
 */
export class LexicalIndex {
  private readonly postings = new Map<string, Posting[]>();
  private readonly lengths: number[];
  private readonly averageLength: number;
  private readonly documentCount: number;

  constructor(chunks: readonly KnowledgeChunk[]) {
    this.documentCount = chunks.length;
    this.lengths = new Array(chunks.length).fill(0);

    chunks.forEach((chunk, row) => {
      // Headings repeat the section topic and are short, so weighting them
      // twice materially improves recall on topical questions.
      const tokens = [...tokenize(chunk.text), ...tokenize(chunk.headings.join(" ")), ...tokenize(chunk.headings.join(" "))];
      this.lengths[row] = tokens.length;

      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

      for (const [token, frequency] of frequencies) {
        const list = this.postings.get(token);
        if (list) list.push({ row, frequency });
        else this.postings.set(token, [{ row, frequency }]);
      }
    });

    const total = this.lengths.reduce((sum, length) => sum + length, 0);
    this.averageLength = chunks.length > 0 ? total / chunks.length : 0;
  }

  /** Returns row indices and raw BM25 scores, highest first. */
  search(query: string, k: number): Array<{ row: number; score: number }> {
    if (this.documentCount === 0) return [];

    const scores = new Map<number, number>();

    for (const token of new Set(tokenize(query))) {
      const postings = this.postings.get(token);
      if (!postings) continue;

      const idf = Math.log(
        1 + (this.documentCount - postings.length + 0.5) / (postings.length + 0.5),
      );

      for (const { row, frequency } of postings) {
        const length = this.lengths[row] ?? 0;
        const denominator =
          frequency + K1 * (1 - B + (B * length) / (this.averageLength || 1));
        scores.set(row, (scores.get(row) ?? 0) + (idf * frequency * (K1 + 1)) / denominator);
      }
    }

    return [...scores.entries()]
      .map(([row, score]) => ({ row, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
