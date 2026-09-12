import type { KnowledgeChunk } from "@/lib/types";

export interface ChunkOptions {
  /** Target chunk size in estimated tokens. */
  targetTokens?: number;
  /** Hard ceiling; a paragraph longer than this is split on sentence boundaries. */
  maxTokens?: number;
  /** Tokens of trailing context repeated at the head of the next chunk. */
  overlapTokens?: number;
  /** Chunks smaller than this are merged into their neighbour instead of stored alone. */
  minTokens?: number;
  /** Chunks still below this after merging are dropped as stubs. */
  dropBelowTokens?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 320,
  maxTokens: 480,
  overlapTokens: 60,
  minTokens: 40,
  dropBelowTokens: 20,
};

/** Cheap proxy for tokeniser output; good enough for sizing, and dependency-free. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Section {
  headings: string[];
  blocks: string[];
}

/**
 * Splits markdown on ATX headings, carrying the heading path down so every
 * chunk knows where in the document it came from. Fenced code blocks are kept
 * intact — the travel corpus has few, but tables and pre-formatted fare charts
 * are worth not shredding.
 */
export function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const blocks = splitBlocks(buffer.join("\n"));
    if (blocks.length > 0) sections.push({ headings: [...headingStack], blocks });
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const heading = inFence ? null : /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1]!.length;
      headingStack.length = Math.min(headingStack.length, depth - 1);
      headingStack[depth - 1] = heading[2]!;
      for (let i = 0; i < depth - 1; i += 1) headingStack[i] ??= "";
      continue;
    }

    buffer.push(line);
  }
  flush();

  return sections.map((section) => ({
    ...section,
    headings: section.headings.filter(Boolean),
  }));
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

export function chunkDocument(
  documentId: string,
  markdown: string,
  options: ChunkOptions = {},
): KnowledgeChunk[] {
  const config = { ...DEFAULTS, ...options };
  const chunks: KnowledgeChunk[] = [];

  for (const section of splitIntoSections(markdown)) {
    for (const text of packBlocks(section.blocks, config)) {
      chunks.push({
        id: `${documentId}::${chunks.length.toString().padStart(3, "0")}`,
        documentId,
        headings: section.headings,
        text,
        tokensEstimate: estimateTokens(text),
      });
    }
  }

  return mergeUndersizedChunks(chunks, config);
}

/** Greedily fills chunks up to the target size, then repeats a tail for continuity. */
function packBlocks(blocks: string[], config: Required<ChunkOptions>): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push(current.join("\n\n"));
    current = [];
    currentTokens = 0;
  };

  for (const block of blocks) {
    for (const piece of block.length / 4 > config.maxTokens ? splitLongBlock(block, config.maxTokens) : [block]) {
      const pieceTokens = estimateTokens(piece);

      if (currentTokens > 0 && currentTokens + pieceTokens > config.targetTokens) {
        const tail = takeTail(current, config.overlapTokens);
        flush();
        if (tail) {
          current.push(tail);
          currentTokens = estimateTokens(tail);
        }
      }

      current.push(piece);
      currentTokens += pieceTokens;
    }
  }
  flush();

  return out;
}

function splitLongBlock(block: string, maxTokens: number): string[] {
  const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (estimateTokens(candidate) > maxTokens && current) {
      pieces.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);

  return pieces;
}

function takeTail(blocks: string[], overlapTokens: number): string | null {
  if (overlapTokens <= 0) return null;
  const last = blocks.at(-1);
  if (!last) return null;
  return estimateTokens(last) <= overlapTokens ? last : null;
}

/**
 * Folds tiny chunks into the preceding chunk of the same section, then discards
 * whatever is still too small to be worth retrieving.
 *
 * The corpus is full of one-line stubs — a bare "visitsingapore.com" under a
 * "Visitor information" heading, say. They carry no answer, but they score well
 * on lexical overlap because their heading is short and topical, so left in
 * place they displace real passages from the top of the ranking.
 */
function mergeUndersizedChunks(
  chunks: KnowledgeChunk[],
  config: Required<ChunkOptions>,
): KnowledgeChunk[] {
  const merged: KnowledgeChunk[] = [];

  for (const chunk of chunks) {
    const previous = merged.at(-1);
    const sameSection = previous && previous.headings.join("/") === chunk.headings.join("/");

    if (chunk.tokensEstimate < config.minTokens && sameSection) {
      previous.text = `${previous.text}\n\n${chunk.text}`;
      previous.tokensEstimate = estimateTokens(previous.text);
      continue;
    }

    merged.push({ ...chunk });
  }

  return merged
    .filter((chunk) => chunk.tokensEstimate >= config.dropBelowTokens)
    .map((chunk, position) => ({
      ...chunk,
      id: `${chunk.documentId}::${position.toString().padStart(3, "0")}`,
    }));
}
