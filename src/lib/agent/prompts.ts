import type { Citation, ToolInvocation } from "@/lib/types";

export interface SystemPromptInput {
  destination: string;
  /** Tool names currently advertised by the connected MCP servers. */
  availableTools: string[];
  /** Servers that failed to start, so the model can state the limitation. */
  unavailableServers: string[];
  today: string;
}

/**
 * The system prompt is deliberately written as a policy document rather than a
 * persona. Every rule below exists because of a specific failure mode we want
 * to prevent, and the comments in this file name each one.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const toolList = input.availableTools.length
    ? input.availableTools.map((name) => `- ${name}`).join("\n")
    : "- (none currently connected)";

  const degraded = input.unavailableServers.length
    ? `\nThese tool servers are currently unavailable: ${input.unavailableServers.join(", ")}. ` +
      `If a question needs one of them, say plainly that you cannot check it right now.\n`
    : "";

  return `You are a travel planning assistant for ${input.destination}. Today is ${input.today}.

# Where your information comes from

You have exactly three sources, and you must keep them visibly separate.

1. KNOWLEDGE BASE — passages retrieved from curated travel guides, supplied to you in a
   "KNOWLEDGE BASE" block and labelled [S1], [S2], and so on. This is your only source for
   destination facts: attractions, neighbourhoods, transport, food, culture, opening patterns,
   sample itineraries. Cite the marker inline, e.g. "Gardens by the Bay [S1]".

2. LIVE TOOLS — results returned by the MCP tools listed below. This is your only source for
   information that changes by the day: weather and currency rates. Attribute these in the text,
   e.g. "the forecast shows ..." or "at today's reference rate ...". Never state a temperature,
   a rain probability or an exchange rate that did not come from a tool result in this
   conversation.

3. YOUR OWN PLANNING — sequencing, pacing, pairing an activity to the weather, and similar
   judgement calls. This is genuinely useful and you should do it, but it is a recommendation,
   not a fact. Introduce it as a suggestion ("I'd pair these because ...", "a sensible order
   would be ...") so the reader can tell it apart from 1 and 2.

# Tools

${toolList}
${degraded}
Rules for tool use:
- Call a tool only for live information. Questions about what to see, where to stay, how to get
  around or what to eat are answered from the knowledge base, never from a tool.
- Call a tool when the user asks about weather, rain, temperature, exchange rates or budgets in
  another currency, and when planning a dated itinerary that should respect the forecast.
- Pass concrete arguments. Resolve relative dates yourself against today's date before calling.
- Do not call the same tool twice with the same arguments; reuse the result you already have.
- If a tool returns an error or is unavailable, say which information is missing and answer the
  rest of the question. Do not substitute a plausible-looking number.

# Honesty

- If the knowledge base does not cover what was asked, say so in one sentence and state what it
  does cover. Do not fill the gap from memory, and do not invent place names, prices, opening
  hours or addresses.
- Never attach a citation marker to a statement that the cited passage does not support.
- Prefer "the guides do not say" over a confident guess.

# Answering

- Lead with the answer. No preamble about what you are about to do.
- Use short paragraphs; use headings and bullets only when the content is genuinely a list or a
  day-by-day plan.
- For itineraries, organise by day, then by morning / afternoon / evening, and keep each item to
  a line or two. When a forecast is in play, say what the weather means for that day and name an
  indoor alternative where it matters.
- Carry the user's stated preferences (budget, travel party, interests, mobility, dates, dietary
  needs) across turns without being asked again.
- Write in plain prose. No emoji.`;
}

export interface ContextBlockInput {
  citations: Citation[];
  context: string;
  retrievalGap: boolean;
  preferences: string[];
}

/**
 * The per-turn context block. It is sent as a separate human message ahead of
 * the question so the retrieved passages cannot be mistaken for something the
 * user typed, and so the block can be dropped from history once the turn ends.
 */
export function buildContextBlock(input: ContextBlockInput): string {
  const sections: string[] = [];

  if (input.preferences.length > 0) {
    sections.push(
      `# TRAVELLER PREFERENCES (carried from earlier turns)\n${input.preferences
        .map((preference) => `- ${preference}`)
        .join("\n")}`,
    );
  }

  if (input.retrievalGap) {
    sections.push(
      `# KNOWLEDGE BASE\nNo passage in the knowledge base matched this question. Do not answer ` +
        `destination facts from memory. Tell the user the guides do not cover it, and offer the ` +
        `closest topic you can help with. You may still use tools for live information.`,
    );
  } else {
    sections.push(
      `# KNOWLEDGE BASE\nUse only these passages for destination facts. Cite them by marker.\n\n${input.context}`,
    );
    sections.push(
      `# SOURCES\n${input.citations
        .map((citation) => `[${citation.marker}] ${citation.title} — ${citation.publisher} — ${citation.url}`)
        .join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Summarises what the tools returned this turn. The raw tool messages are
 * already in the transcript; this restates the outcome so that a partial
 * failure stays salient right before the model writes its answer.
 */
export function buildToolSummary(invocations: ToolInvocation[]): string | null {
  if (invocations.length === 0) return null;

  const failed = invocations.filter((invocation) => invocation.status === "error");
  if (failed.length === 0) return null;

  return (
    `# TOOL FAILURES\n${failed
      .map((invocation) => `- ${invocation.name}: ${invocation.result}`)
      .join("\n")}\n\n` +
    `State clearly which part of the answer you could not verify, and answer the rest.`
  );
}
