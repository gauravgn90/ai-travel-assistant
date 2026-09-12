import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "@/lib/config/paths";
import type { SourceDocument } from "@/lib/types";

export interface LoadedDocument {
  metadata: SourceDocument;
  body: string;
  file: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Reads the front matter block at the top of a knowledge-base document.
 *
 * A dedicated YAML parser would be overkill: the block is a fixed set of scalar
 * keys plus one inline list, written by our own tooling. Anything outside that
 * shape is a mistake worth failing loudly on rather than silently coercing.
 */
export function parseFrontmatter(raw: string, file: string): LoadedDocument {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    throw new Error(`${file} has no front matter block. Every document must declare its source.`);
  }

  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`${file}: malformed front matter line "${line}"`);

    fields.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
  }

  const required = ["id", "title", "url", "publisher", "license", "retrievedAt"] as const;
  for (const key of required) {
    if (!fields.get(key)) throw new Error(`${file}: front matter is missing "${key}"`);
  }

  return {
    file,
    body: raw.slice(match[0].length),
    metadata: {
      id: fields.get("id")!,
      title: fields.get("title")!,
      url: fields.get("url")!,
      publisher: fields.get("publisher")!,
      license: fields.get("license")!,
      retrievedAt: fields.get("retrievedAt")!,
      topics: parseList(fields.get("topics") ?? ""),
    },
  };
}

export function serialiseFrontmatter(metadata: SourceDocument, body: string): string {
  const lines = [
    "---",
    `id: ${metadata.id}`,
    `title: ${quote(metadata.title)}`,
    `url: ${metadata.url}`,
    `publisher: ${quote(metadata.publisher)}`,
    `license: ${quote(metadata.license)}`,
    `retrievedAt: ${metadata.retrievedAt}`,
    `topics: [${metadata.topics.join(", ")}]`,
    "---",
    "",
  ];

  return `${lines.join("\n")}${body.trimStart()}`;
}

/** Loads every markdown document under knowledge-base/, recursively. */
export async function loadDocuments(root: string = paths.knowledgeBase): Promise<LoadedDocument[]> {
  const files = await collectMarkdownFiles(root);
  if (files.length === 0) {
    throw new Error(`No markdown documents found under ${root}. Run \`npm run kb:fetch\` first.`);
  }

  const documents = await Promise.all(
    files.map(async (file) => parseFrontmatter(await readFile(file, "utf8"), path.relative(root, file))),
  );

  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.metadata.id)) {
      throw new Error(`Duplicate document id "${document.metadata.id}" in ${document.file}`);
    }
    seen.add(document.metadata.id);
  }

  return documents.sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function quote(value: string): string {
  return /[:#[\]{}]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "").replace(/\\"/g, '"');
}
