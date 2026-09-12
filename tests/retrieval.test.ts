import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LexicalIndex, tokenize } from "../src/lib/rag/lexical.ts";
import { VectorStore } from "../src/lib/rag/vector-store.ts";
import { loadDocuments, parseFrontmatter } from "../src/lib/rag/documents.ts";
import type { IndexedChunk, KnowledgeChunk } from "../src/lib/types.ts";

function chunk(id: string, text: string, headings: string[] = []): KnowledgeChunk {
  return { id, documentId: "doc", headings, text, tokensEstimate: Math.ceil(text.length / 4) };
}

function indexed(id: string, embedding: number[]): IndexedChunk {
  return { ...chunk(id, `text ${id}`), embedding };
}

describe("tokenize", () => {
  it("lowercases, strips punctuation and drops stopwords", () => {
    assert.deepEqual(tokenize("What is the MRT, and how do I use it?"), ["mrt", "use"]);
  });

  it("keeps accented and non-Latin words", () => {
    assert.deepEqual(tokenize("Café Batik 新加坡"), ["café", "batik", "新加坡"]);
  });
});

describe("VectorStore", () => {
  it("ranks by cosine similarity regardless of vector magnitude", () => {
    const store = new VectorStore([
      indexed("a", [1, 0, 0]),
      indexed("b", [0, 1, 0]),
      // Same direction as "a" but ten times longer; normalisation should make
      // it score identically rather than dominate.
      indexed("c", [10, 0, 0]),
    ]);

    const results = store.search([1, 0, 0], 3);
    assert.equal(results[0]?.score.toFixed(4), "1.0000");
    assert.equal(results[1]?.score.toFixed(4), "1.0000");
    assert.ok((results[2]?.score ?? 1) < 0.001);
  });

  it("rejects an index whose vectors disagree on dimensionality", () => {
    assert.throws(
      () => new VectorStore([indexed("a", [1, 0]), indexed("b", [1, 0, 0])]),
      /dimensions/,
    );
  });

  it("rejects a query of the wrong width", () => {
    const store = new VectorStore([indexed("a", [1, 0, 0])]);
    assert.throws(() => store.search([1, 0], 1), /dimensions/);
  });

  it("handles an empty index without throwing", () => {
    assert.deepEqual(new VectorStore([]).search([1, 2, 3], 5), []);
  });
});

describe("LexicalIndex", () => {
  const chunks = [
    chunk("1", "The MRT is the fastest way to reach Sentosa from the city centre.", ["Get around"]),
    chunk("2", "Chilli crab and chicken rice are the dishes visitors ask for most.", ["Eat"]),
    chunk("3", "Gardens by the Bay has two cooled conservatories and a supertree grove.", ["See"]),
  ];

  it("ranks the chunk containing the query terms first", () => {
    const results = new LexicalIndex(chunks).search("where can I eat chilli crab", 3);
    assert.equal(chunks[results[0]!.row]?.id, "2");
  });

  it("matches proper nouns that a dense model would blur together", () => {
    const results = new LexicalIndex(chunks).search("supertree grove", 3);
    assert.equal(chunks[results[0]!.row]?.id, "3");
  });

  it("returns nothing when no term matches", () => {
    assert.deepEqual(new LexicalIndex(chunks).search("snowboarding", 3), []);
  });

  it("weights headings so a topical query finds the right section", () => {
    const results = new LexicalIndex(chunks).search("get around", 3);
    assert.equal(chunks[results[0]!.row]?.id, "1");
  });
});

describe("parseFrontmatter", () => {
  const valid = [
    "---",
    "id: test-doc",
    'title: "Wikivoyage: Singapore"',
    "url: https://example.com/a",
    "publisher: Wikivoyage",
    "license: CC BY-SA 4.0",
    "retrievedAt: 2026-09-12",
    "topics: [food, transport]",
    "---",
    "# Body",
  ].join("\n");

  it("reads every declared field", () => {
    const document = parseFrontmatter(valid, "test.md");

    assert.equal(document.metadata.id, "test-doc");
    assert.equal(document.metadata.title, "Wikivoyage: Singapore");
    assert.deepEqual(document.metadata.topics, ["food", "transport"]);
    assert.equal(document.body.trim(), "# Body");
  });

  it("rejects a document with no front matter", () => {
    assert.throws(() => parseFrontmatter("# Just a body", "test.md"), /front matter/);
  });

  it("names the missing field when one is absent", () => {
    const withoutUrl = valid.replace("url: https://example.com/a\n", "");
    assert.throws(() => parseFrontmatter(withoutUrl, "test.md"), /missing "url"/);
  });
});

describe("loadDocuments", () => {
  it("loads the committed corpus and skips its README", async () => {
    const documents = await loadDocuments();

    assert.ok(documents.length >= 12, `expected the full corpus, got ${documents.length}`);
    assert.ok(
      documents.every((document) => !document.file.endsWith("README.md")),
      "knowledge-base/README.md documents the corpus and is not part of it",
    );

    for (const document of documents) {
      assert.ok(document.metadata.url.startsWith("http"), `${document.file} has no source URL`);
      assert.ok(document.metadata.license.length > 0, `${document.file} has no licence`);
      assert.ok(document.body.trim().length > 500, `${document.file} is suspiciously short`);
    }
  });
});
