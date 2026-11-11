import type { ContextCandidate } from "./plan.js";

export type FixtureTopic = "lighthouse" | "tide" | "ferry";

const PHRASES: Record<FixtureTopic, string> = {
  lighthouse: "the keeper trims the lamp wick at dusk ",
  tide: "high water at the north quay runs late ",
  ferry: "the morning ferry leaves the slip at seven ",
};

/** Exactly `tokens * 4` characters, so the default estimator returns `tokens`. */
export function fixtureText(topic: FixtureTopic, tokens: number, tier = 0): string {
  const length = tokens * 4;
  const phrase = PHRASES[topic];
  const body = `t${tier}:${phrase.repeat(Math.ceil(length / phrase.length) + 1)}`;
  return body.slice(0, length);
}

export function fixtureCandidate(
  id: string,
  category: string,
  score: number,
  tierTokens: readonly number[],
  topic: FixtureTopic = "lighthouse",
): ContextCandidate {
  return { id, category, score, tiers: tierTokens.map((tokens, tier) => fixtureText(topic, tokens, tier)) };
}

export const FIXTURE_CORPUS: readonly ContextCandidate[] = [
  fixtureCandidate("lamp-wick", "notes", 0.96, [3, 8, 16], "lighthouse"),
  fixtureCandidate("ferry-0715", "tasks", 0.94, [2, 5, 12], "ferry"),
  fixtureCandidate("north-quay-tide", "notes", 0.91, [2, 6, 14], "tide"),
  fixtureCandidate("tide-table-march", "sources", 0.9, [4, 10, 24], "tide"),
  fixtureCandidate("paint-gallery", "tasks", 0.88, [3, 7, 15], "lighthouse"),
  fixtureCandidate("harbour-chart", "sources", 0.86, [5, 11, 22], "ferry"),
  fixtureCandidate("fog-signal", "notes", 0.83, [4, 9, 20], "lighthouse"),
  fixtureCandidate("order-paraffin", "tasks", 0.8, [2, 4, 10], "lighthouse"),
  fixtureCandidate("spring-tide", "notes", 0.77, [2, 5, 9], "tide"),
  fixtureCandidate("relief-roster", "tasks", 0.77, [3, 6, 11], "lighthouse"),
  fixtureCandidate("ferry-0715", "sources", 0.72, [3, 6, 13], "ferry"),
  fixtureCandidate("keepers-log", "sources", 0.7, [4, 8, 18], "lighthouse"),
];
