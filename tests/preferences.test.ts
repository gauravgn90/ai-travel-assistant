import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPreferences, mergePreferences } from "../src/lib/session/preferences.ts";

function valueFor(message: string, key: string): string | undefined {
  return extractPreferences(message).find((preference) => preference.key === key)?.value;
}

describe("extractPreferences", () => {
  it("reads a budget written with a currency code", () => {
    assert.equal(valueFor("I have a budget of INR 60,000 for the trip", "budget"), "Budget: 60,000 INR");
  });

  it("expands lakh and k suffixes", () => {
    assert.equal(valueFor("my budget is INR 1.5 lakh", "budget"), "Budget: 150,000 INR");
    assert.equal(valueFor("budget of USD 3k", "budget"), "Budget: 3,000 USD");
  });

  it("normalises currency symbols", () => {
    assert.equal(valueFor("I can spend ₹50,000", "budget"), "Budget: 50,000 INR");
  });

  it("reads trip length in digits and in words", () => {
    assert.equal(valueFor("plan a 5-day trip", "duration"), "Trip length: 5 days");
    assert.equal(valueFor("a three day itinerary please", "duration"), "Trip length: 3 days");
  });

  it("identifies the travel party", () => {
    assert.equal(valueFor("travelling with my kids", "party"), "Travelling as a family with children");
    assert.equal(valueFor("I'm going solo", "party"), "Travelling solo");
    assert.equal(valueFor("my wife and I are visiting", "party"), "Travelling as a couple");
  });

  it("collects interests and dietary needs", () => {
    const preferences = extractPreferences("we love street food and museums, and we are vegetarian");
    const byKey = new Map(preferences.map((p) => [p.key, p.value]));

    assert.equal(byKey.get("diet"), "Dietary requirement: vegetarian");
    assert.match(byKey.get("interests") ?? "", /food/);
    assert.match(byKey.get("interests") ?? "", /culture and heritage/);
  });

  it("returns nothing for a message that states no preference", () => {
    assert.deepEqual(extractPreferences("How do I get from the airport to the city?"), []);
  });
});

describe("mergePreferences", () => {
  it("lets a later turn supersede an earlier one", () => {
    const merged = mergePreferences(
      [{ key: "budget", value: "Budget: 50,000 INR" }],
      [{ key: "budget", value: "Budget: 60,000 INR" }],
    );

    assert.deepEqual(merged, [{ key: "budget", value: "Budget: 60,000 INR" }]);
  });

  it("accumulates interests across turns instead of replacing them", () => {
    const merged = mergePreferences(
      [{ key: "interests", value: "Interests: food" }],
      [{ key: "interests", value: "Interests: nature and outdoors" }],
    );

    assert.deepEqual(merged, [{ key: "interests", value: "Interests: food, nature and outdoors" }]);
  });

  it("does not duplicate an interest already recorded", () => {
    const merged = mergePreferences(
      [{ key: "interests", value: "Interests: food, shopping" }],
      [{ key: "interests", value: "Interests: shopping" }],
    );

    assert.deepEqual(merged, [{ key: "interests", value: "Interests: food, shopping" }]);
  });
});
