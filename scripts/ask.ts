/**
 * Terminal client for the assistant. Drives the same orchestrator the web UI
 * uses, so it exercises retrieval, MCP tool calls and multi-turn memory without
 * a browser.
 *
 *   npm run ask                        interactive session
 *   npm run ask -- "your question"     one-shot
 *
 * Requires an LLM API key for the configured provider. To check retrieval or
 * the tools on their own, use `npm run kb:search` and `npm run mcp:check`,
 * neither of which calls a model.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runTurn } from "../src/lib/agent/orchestrator.ts";

const RESET = "[0m";
const DIM = "[2m";
const BOLD = "[1m";
const CYAN = "[36m";
const YELLOW = "[33m";
const RED = "[31m";

const useColour = stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColour ? `${code}${text}${RESET}` : text);

const sessionId = randomUUID();

async function ask(question: string): Promise<void> {
  let streaming = false;

  for await (const event of runTurn({ question, sessionId })) {
    switch (event.type) {
      case "status":
        console.log(paint(DIM, `  · ${event.detail ?? event.stage}…`));
        break;

      case "retrieval":
        console.log(
          event.gap
            ? paint(YELLOW, "  · no knowledge-base match for this question")
            : paint(
                DIM,
                `  · retrieved ${event.citations.length} source(s): ` +
                  event.citations.map((c) => `[${c.marker}] ${c.title}`).join("; "),
              ),
        );
        break;

      case "tool_call":
        console.log(
          paint(CYAN, `  → ${event.invocation.name}(${JSON.stringify(event.invocation.args)})`),
        );
        break;

      case "tool_result":
        console.log(
          event.invocation.status === "success"
            ? paint(DIM, `  ← ${event.invocation.name} ok in ${event.invocation.durationMs}ms`)
            : paint(RED, `  ← ${event.invocation.name} failed: ${event.invocation.result}`),
        );
        break;

      case "token":
        if (!streaming) {
          stdout.write("\n");
          streaming = true;
        }
        stdout.write(event.value);
        break;

      case "done": {
        const { provenance } = event;
        const kind = provenance.combined
          ? "knowledge base + MCP tools"
          : provenance.toolInvocations.length > 0
            ? "MCP tools"
            : provenance.citations.length > 0
              ? "knowledge base"
              : "no grounded source";

        stdout.write("\n\n");
        console.log(paint(DIM, `  ${event.provider}/${event.model} · answered from ${kind}`));

        for (const citation of provenance.citations) {
          console.log(paint(DIM, `  [${citation.marker}] ${citation.title} — ${citation.url}`));
        }
        break;
      }

      case "error":
        console.error(paint(RED, `\n  error: ${event.message}`));
        break;
    }
  }
}

const oneShot = process.argv.slice(2).join(" ").trim();

if (oneShot) {
  await ask(oneShot);
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });

console.log(paint(BOLD, "Singapore travel assistant"));
console.log(
  paint(DIM, "Multi-turn: preferences you state are carried forward. Ctrl-C or /exit to quit.\n"),
);

try {
  while (true) {
    const question = (await rl.question(paint(BOLD, "you › "))).trim();
    if (!question) continue;
    if (question === "/exit" || question === "/quit") break;

    await ask(question);
    stdout.write("\n");
  }
} finally {
  rl.close();
}

process.exit(0);
