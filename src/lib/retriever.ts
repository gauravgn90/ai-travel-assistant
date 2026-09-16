import { config } from "./config.ts";
import { embedOne } from "./embeddings.ts";
import { search } from "./vector-store.ts";
import type { Citation } from "./types.ts";

export interface Retrieval {
  /** The KNOWLEDGE BASE block of the prompt, empty when nothing matched. */
  context: string;
  citations: Citation[];
  /** True when the corpus does not cover the question. The prompt then forbids
   *  answering destination facts from memory. */
  gap: boolean;
}

/** At most this many chunks from one document, so a single long article - the
 *  Wikivoyage Singapore page is a third of the corpus - cannot take every slot
 *  and leave the answer with one source to cite. */
const MAX_PER_DOCUMENT = 3;

export async function retrieve(question: string): Promise<Retrieval> {
  const hits = await search(await embedOne(question), config.topK * 3);

  // Coverage is judged on the single closest chunk: if nothing in the corpus is
  // near the question, there is no answer to ground.
  if ((hits[0]?.score ?? 0) < config.minScore) {
    return { context: "", citations: [], gap: true };
  }

  const perDocument = new Map<string, number>();
  const selected = hits
    .filter((hit) => {
      const taken = perDocument.get(hit.chunk.document.id) ?? 0;
      if (taken >= MAX_PER_DOCUMENT) return false;
      perDocument.set(hit.chunk.document.id, taken + 1);
      return true;
    })
    .slice(0, config.topK);

  // Citations are numbered per document, not per chunk: two passages from the
  // same guide are one source to the reader, and one link to click.
  const citations = new Map<string, Citation>();
  for (const { chunk, score } of selected) {
    const existing = citations.get(chunk.document.id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      continue;
    }
    citations.set(chunk.document.id, {
      marker: `S${citations.size + 1}`,
      title: chunk.document.title,
      url: chunk.document.url,
      publisher: chunk.document.publisher,
      score,
    });
  }

  const context = selected
    .map(({ chunk }) => {
      const marker = citations.get(chunk.document.id)!.marker;
      const trail = chunk.headings.length ? ` > ${chunk.headings.join(" > ")}` : "";
      return `[${marker}] ${chunk.document.title}${trail}\n${chunk.text}`;
    })
    .join("\n\n---\n\n");

  return { context, citations: [...citations.values()], gap: false };
}
