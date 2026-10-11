import { RoundSchema } from "@titan-design/review-schema";
import { describe, expect, it } from "vitest";
import { buildOwnerRounds, type OwnerRounds, type Principle } from "./rounds.js";
import type { OwnerItem } from "./schema.js";
import { item } from "./test-fixtures.js";

/** Text round@2 is strict about: blanks, blanket sign-offs, repeats, suffix look-alikes, the principle options' own labels. */
const TEXTS = [
  "", " ", "   ", "\t", "LGTM", "lgtm!", "Ship it", "Approve", "approve it as built", "looks good to me", "Same", "Same (q1)",
  "Same (q1) (q1)", "X (q2)", "Yes: the decider settles each covered item by this rule", "No: ask me each covered item on its own",
  "Pick a cache layout. Now: none", "Option",
];
const CATEGORIES = [undefined, "naming", "tech_design"];
const GRADUATED = ["naming"];

/** mulberry32: a seeded generator, so a failure names a reproducible seed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number): { items: OwnerItem[]; principles: Principle[] } {
  const next = random(seed);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const pickRecommendation = (optionIds: string[]) =>
    next() < 0.3
      ? undefined
      : { optionId: pick(optionIds), by: pick(["decider", " ", ""]), confidence: pick([undefined, 0, 0.6, 1]), rationale: pick([undefined, ...TEXTS]), cite: pick([undefined, " ", "ledger:k-1"]), hidden: pick([undefined, true, false]) };
  const items = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, index) => {
    const options = next() < 0.2 ? undefined : Array.from({ length: 2 + Math.floor(next() * 3) }, (_, n) => ({ id: `o${n}`, label: pick(TEXTS), description: pick([undefined, ...TEXTS]) }));
    return item({
      id: `i${index}`,
      summary: pick(TEXTS),
      context: pick(TEXTS),
      door: next() < 0.2 ? "one-way" : "two-way",
      category: pick(CATEGORIES),
      options,
      recommended: pickRecommendation(options?.map((each) => each.id) ?? ["o0"]) as OwnerItem["recommended"],
    });
  });
  const ids = items.map((each) => each.id);
  const principles = Array.from({ length: Math.floor(next() * 3) }, (_, index) => ({
    id: `p${index}`,
    rule: pick(TEXTS),
    covers: ids.filter(() => next() < 0.5),
    recommended: pickRecommendation(["yes", "no"]) as Principle["recommended"],
  }));
  return { items, principles };
}

function hiddenIn(result: OwnerRounds, items: OwnerItem[], principles: Principle[]): boolean[] {
  const byId = new Map(items.map((each) => [each.id, each]));
  const principleById = new Map(principles.map((each) => [each.id, each]));
  return result.rounds
    .filter((round) => round.manifest.recommendations === "shown")
    .flatMap((round) => round.bindings)
    .map((binding) =>
      binding.itemIds.some((id) => byId.get(id)?.recommended?.hidden === true) ||
      principleById.get(binding.principleId ?? "")?.recommended?.hidden === true,
    );
}

describe("buildOwnerRounds on adversarial input", () => {
  it.each(Array.from({ length: 300 }, (_, seed) => seed))("seed %i: every manifest passes RoundSchema, hides every hidden pick and keeps every option", (seed) => {
    const { items, principles } = generate(seed);

    const result = buildOwnerRounds(items, { unit: "owner-queue", storybookUrl: "http://127.0.0.1:6006", graduated: GRADUATED, principles, maxQuestions: 4 });

    for (const round of result.rounds) expect(RoundSchema.safeParse(round.manifest).error?.issues ?? []).toEqual([]);
    expect(hiddenIn(result, items, principles)).not.toContain(true);
    for (const binding of result.rounds.flatMap((round) => round.bindings).filter((each) => each.principleId === undefined)) {
      const asked = items.find((each) => each.id === binding.itemIds[0])!;
      expect(Object.values(binding.options)).toEqual(asked.options?.map((each) => each.id) ?? []);
    }
  });
});
