import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.ts";
import type { Chunk, SourceDocument } from "./types.ts";

/** Target chunk size in characters. Roughly 300 tokens, which keeps a whole
 *  attraction or transport section together without crowding the prompt. */
const TARGET = 1200;
const MIN = 200;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Reads the citation block at the top of a knowledge-base document. The keys
 *  are a fixed set of scalars written by hand, so a full YAML parser would be
 *  more machinery than the format needs. */
function parseFrontmatter(raw: string, file: string): { meta: SourceDocument; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error(`${file}: missing front matter block`);

  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    fields.set(line.slice(0, colon).trim(), value);
  }

  for (const key of ["id", "title", "url", "publisher"]) {
    if (!fields.get(key)) throw new Error(`${file}: front matter is missing "${key}"`);
  }

  return {
    body: raw.slice(match[0].length),
    meta: {
      id: fields.get("id")!,
      title: fields.get("title")!,
      url: fields.get("url")!,
      publisher: fields.get("publisher")!,
    },
  };
}

/**
 * Splits a document on markdown headings, then packs the paragraphs of each
 * section up to the target size. Splitting on headings rather than on a fixed
 * character window means a chunk is a topic, and it carries the heading path
 * that tells the reader - and the embedding - what the passage is about.
 */
function chunkDocument(meta: SourceDocument, body: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headings: string[] = [];
  let paragraphs: string[] = [];

  const flush = () => {
    let buffer = "";
    const emit = () => {
      if (buffer.length >= MIN) {
        chunks.push({
          id: `${meta.id}#${chunks.length}`,
          document: meta,
          headings: headings.filter(Boolean),
          text: buffer.trim(),
        });
      }
      buffer = "";
    };

    for (const paragraph of paragraphs) {
      // Only split once the buffer is worth keeping, so a short run of text
      // before a very long paragraph is carried forward rather than dropped.
      if (buffer.length >= MIN && buffer.length + paragraph.length > TARGET) emit();
      buffer += `${paragraph}\n\n`;
    }
    emit();
    paragraphs = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1]!.length;
      headings.length = depth - 1;
      headings[depth - 1] = heading[2]!;
      continue;
    }
    if (line.trim()) paragraphs.push(line.trim());
    else if (paragraphs.length && paragraphs.at(-1) !== "") paragraphs.push("");
  }
  flush();

  // Paragraphs were collected line by line, so re-join the blank-line markers.
  return chunks.map((chunk) => ({ ...chunk, text: chunk.text.replace(/\n{3,}/g, "\n\n") }));
}

/** Loads every markdown document under knowledge-base/ and chunks it. */
export async function loadChunks(): Promise<Chunk[]> {
  const entries = await readdir(paths.knowledgeBase, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();

  if (files.length === 0) {
    throw new Error(`No markdown documents found under ${paths.knowledgeBase}`);
  }

  const chunks: Chunk[] = [];
  for (const file of files) {
    const { meta, body } = parseFrontmatter(await readFile(file, "utf8"), path.basename(file));
    chunks.push(...chunkDocument(meta, body));
  }

  return chunks;
}

/** The text that gets embedded. Prefixing the heading path gives a mid-document
 *  passage the topical context it would otherwise lack. */
export function embeddingText(chunk: Chunk): string {
  return chunk.headings.length ? `${chunk.headings.join(" > ")}\n\n${chunk.text}` : chunk.text;
}
