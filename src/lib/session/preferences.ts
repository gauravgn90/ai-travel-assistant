const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

interface Rule {
  key: string;
  pattern: RegExp;
  render(match: RegExpMatchArray): string;
}

/**
 * Preferences are extracted with rules rather than with an LLM call.
 *
 * The facts worth carrying between turns — party size, budget, trip length,
 * dietary needs, interests — are stated in a small number of predictable
 * phrasings, and a rule pass costs nothing, is deterministic, and cannot
 * hallucinate a constraint the traveller never mentioned. The trade-off is
 * recall on unusual phrasing; the full transcript is still in the model's
 * context, so a missed rule degrades to "not pinned", not "forgotten".
 */
const RULES: Rule[] = [
  {
    key: "budget",
    pattern:
      /\b(?:budget|spend|spending|afford|have)\b[^.?!]*?(?:\bof\s+)?(?<![A-Za-z])(INR|SGD|USD|EUR|GBP|AUD|MYR|JPY|S\$|₹|\$|€|£)\s?([\d][\d,\s]*(?:\.\d+)?)\s*(k|lakh|lakhs)?/i,
    render: (match) => {
      const currency = normaliseCurrency(match[1] ?? "");
      const amount = expandAmount(match[2] ?? "", match[3]);
      return `Budget: ${amount} ${currency}`;
    },
  },
  {
    key: "budget",
    pattern:
      /\b([\d][\d,\s]*(?:\.\d+)?)\s*(k|lakh|lakhs)?\s*(INR|SGD|USD|EUR|GBP|AUD|MYR|JPY)\b[^.?!]*?\b(?:budget|to spend)\b/i,
    render: (match) =>
      `Budget: ${expandAmount(match[1] ?? "", match[2])} ${normaliseCurrency(match[3] ?? "")}`,
  },
  {
    key: "duration",
    pattern: /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]?day\b/i,
    render: (match) => `Trip length: ${toNumber(match[1] ?? "")} days`,
  },
  {
    key: "party",
    pattern: /\b(?:family|travelling|traveling|trip)\b[^.?!]*\b(?:with|and)\b[^.?!]*\b(kids|children|toddler|toddlers|baby)\b/i,
    render: () => "Travelling as a family with children",
  },
  {
    key: "party",
    pattern: /\b(?:i am|i'm|travelling|traveling|going)\s+(?:travelling\s+)?(solo|alone|by myself)\b/i,
    render: () => "Travelling solo",
  },
  {
    key: "party",
    pattern: /\b(?:honeymoon|my (?:wife|husband|partner) and i|as a couple|with my (?:wife|husband|partner))\b/i,
    render: () => "Travelling as a couple",
  },
  {
    key: "party",
    pattern: /\b(?:with|and)\s+(?:my\s+)?(?:elderly\s+)?(parents|grandparents|in-laws)\b/i,
    render: (match) => `Travelling with ${(match[1] ?? "family").toLowerCase()}`,
  },
  {
    key: "diet",
    pattern: /\b(vegetarian|vegan|halal|kosher|jain|gluten[- ]free|nut allerg\w*)\b/i,
    render: (match) => `Dietary requirement: ${(match[1] ?? "").toLowerCase()}`,
  },
  {
    key: "mobility",
    pattern: /\b(wheelchair|limited mobility|can(?:'|no)?t walk (?:far|much|long)|step[- ]free)\b/i,
    render: () => "Mobility: needs step-free, low-walking options",
  },
  {
    key: "pace",
    pattern: /\b(relaxed|slow|leisurely|packed|fast[- ]paced|jam[- ]packed)\s+(?:pace|itinerary|trip|schedule)\b/i,
    render: (match) => `Preferred pace: ${(match[1] ?? "").toLowerCase()}`,
  },
  {
    key: "dates",
    pattern: /\b(next week|this weekend|next weekend|next month|in (?:january|february|march|april|may|june|july|august|september|october|november|december))\b/i,
    render: (match) => `Travel window: ${(match[1] ?? "").toLowerCase()}`,
  },
];

const INTERESTS: Array<[RegExp, string]> = [
  [/\b(?:street ?food|hawkers?|food tours?|local food|eating|cuisine|foodie)\b/i, "food"],
  [
    /\b(?:museums?|galler(?:y|ies)|heritage|cultur(?:e|al)|temples?|history|historical)\b/i,
    "culture and heritage",
  ],
  [/\b(?:nature|gardens?|parks?|wildlife|zoos?|hiking|trails?|outdoors?)\b/i, "nature and outdoors"],
  [/\b(?:shopping|malls?|markets?|boutiques?)\b/i, "shopping"],
  [/\b(?:nightlife|bars?|clubs?|rooftops?)\b/i, "nightlife"],
  [/\b(?:architecture|skyline|design)\b/i, "architecture"],
  [/\b(?:theme parks?|universal studios|aquariums?|sentosa)\b/i, "theme parks and attractions"],
  [/\b(?:art|street art|murals?)\b/i, "art"],
];

export interface Preference {
  key: string;
  value: string;
}

/**
 * Extracts preferences from one user message. Returns at most one entry per
 * key, so a later turn can supersede an earlier one rather than stacking
 * contradictory constraints.
 */
export function extractPreferences(message: string): Preference[] {
  const found = new Map<string, string>();

  for (const rule of RULES) {
    if (found.has(rule.key)) continue;
    const match = message.match(rule.pattern);
    if (match) found.set(rule.key, rule.render(match));
  }

  const interests = INTERESTS.filter(([pattern]) => pattern.test(message)).map(([, label]) => label);
  if (interests.length > 0) {
    found.set("interests", `Interests: ${[...new Set(interests)].join(", ")}`);
  }

  return [...found.entries()].map(([key, value]) => ({ key, value }));
}

/** Later turns win; interests accumulate instead of being replaced. */
export function mergePreferences(
  existing: Preference[],
  incoming: Preference[],
): Preference[] {
  const merged = new Map(existing.map((preference) => [preference.key, preference.value]));

  for (const preference of incoming) {
    if (preference.key === "interests") {
      const previous = merged.get("interests")?.replace(/^Interests:\s*/, "") ?? "";
      const next = preference.value.replace(/^Interests:\s*/, "");
      const combined = [...new Set([...splitList(previous), ...splitList(next)])];
      merged.set("interests", `Interests: ${combined.join(", ")}`);
    } else {
      merged.set(preference.key, preference.value);
    }
  }

  return [...merged.entries()].map(([key, value]) => ({ key, value }));
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(token: string): number {
  return NUMBER_WORDS[token.toLowerCase()] ?? Number.parseInt(token, 10);
}

function normaliseCurrency(token: string): string {
  const map: Record<string, string> = { "₹": "INR", $: "USD", "S$": "SGD", "€": "EUR", "£": "GBP" };
  return map[token] ?? token.toUpperCase();
}

function expandAmount(digits: string, suffix?: string): string {
  const base = Number.parseFloat(digits.replace(/[,\s]/g, ""));
  if (!Number.isFinite(base)) return digits.trim();

  const multiplier = suffix?.toLowerCase().startsWith("lakh")
    ? 100_000
    : suffix?.toLowerCase() === "k"
      ? 1_000
      : 1;

  return (base * multiplier).toLocaleString("en-US");
}
