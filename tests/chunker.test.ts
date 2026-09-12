import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkDocument, splitIntoSections } from "../src/lib/rag/chunker.ts";

describe("splitIntoSections", () => {
  it("carries the heading path down the hierarchy", () => {
    const sections = splitIntoSections(
      ["# Guide", "Intro text.", "## Districts", "About districts.", "### Chinatown", "About Chinatown."].join(
        "\n\n",
      ),
    );

    assert.deepEqual(
      sections.map((section) => section.headings),
      [["Guide"], ["Guide", "Districts"], ["Guide", "Districts", "Chinatown"]],
    );
  });

  it("resets deeper headings when the level goes back up", () => {
    const sections = splitIntoSections(
      ["## A", "a", "### A1", "a1", "## B", "b"].join("\n\n"),
    );

    assert.deepEqual(sections.at(-1)?.headings, ["B"]);
  });

  it("does not treat a hash inside a fenced block as a heading", () => {
    const sections = splitIntoSections(
      ["## Fares", "```", "# this is a comment", "```", "Trailing text."].join("\n\n"),
    );

    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0]?.headings, ["Fares"]);
  });
});

describe("chunkDocument", () => {
  const paragraph = (n: number) => `Paragraph ${n}. ${"Singapore detail. ".repeat(20)}`;

  it("keeps chunks under the hard ceiling", () => {
    const markdown = `## Section\n\n${[1, 2, 3, 4, 5, 6].map(paragraph).join("\n\n")}`;
    const chunks = chunkDocument("doc", markdown);

    assert.ok(chunks.length > 1, "long content should split");
    for (const chunk of chunks) {
      assert.ok(chunk.tokensEstimate <= 600, `chunk of ${chunk.tokensEstimate} tokens is too big`);
    }
  });

  it("drops stub chunks that carry no answer", () => {
    const markdown = ["## Visitor information", "example.com", "## Real section", paragraph(1)].join(
      "\n\n",
    );

    const chunks = chunkDocument("doc", markdown);
    assert.ok(
      chunks.every((chunk) => !chunk.text.trim().startsWith("example.com")),
      "a bare URL should not survive as its own chunk",
    );
  });

  it("assigns contiguous, document-scoped ids", () => {
    const markdown = `## A\n\n${paragraph(1)}\n\n## B\n\n${paragraph(2)}`;
    const chunks = chunkDocument("wikivoyage-singapore", markdown);

    assert.deepEqual(
      chunks.map((chunk) => chunk.id),
      chunks.map((_, i) => `wikivoyage-singapore::${String(i).padStart(3, "0")}`),
    );
  });

  it("splits a single oversized paragraph on sentence boundaries", () => {
    const giant = `${"This is one sentence about the MRT. ".repeat(120)}`;
    const chunks = chunkDocument("doc", `## Transport\n\n${giant}`);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.tokensEstimate <= 600);
  });
});
