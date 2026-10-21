import { describe, expect, it } from "vitest";
import { RoundSchema, type Manifest, type Question } from "../../server/round-schema.js";
import { shipsAfter, stackedLabel, stackedPrefixes } from "./ship-stack.js";

const HEAD = "a".repeat(40);
const BASE_HEAD = "1234567".padEnd(40, "0");
const section = (id: string, title: string, rest: Record<string, unknown>) => ({ id, title, deciding: "d", changed: "c", context: "c", kind: "STATES", ...rest });
const ship = (id: string, pr: number) => ({
  id, kind: "pick-one", prompt: `Ship #${pr}?`, options: ["Ship", "Don't ship"], required: true, page: `example/app#${pr}`, signsOff: `${id}-part`,
  merge: { repo: "example/app", pr, headSha: HEAD, ship: ["Ship"] },
});
const part = (id: string) => ({ parts: [{ id, label: id, proposed: id }] });

/** A round over example/app#5 whose `base` section shows frames of the PR it is stacked on, read through the console's schema. */
function stackedRound(extra: Record<string, unknown> = {}): Manifest {
  return RoundSchema.parse({
    schema: "titan-review/round@2", unit: "stacked", round: 1, storybookUrl: "http://localhost:6006", widths: [1280],
    variants: [{ key: "own-frame", image: "images/own.png", label: "Own" }, { key: "base-frame", image: "images/base.png", label: "Base" }],
    sections: [
      section("own", "Own frames", { variantKeys: ["own-frame"], questionIds: ["ship-5"], ...part("ship-5-part") }),
      section("base", "#4 base frames", { variantKeys: ["base-frame"], questionIds: [], ...part("ship-4-part") }),
    ],
    questions: [ship("ship-5", 5)],
    stackedOn: { repo: "example/app", pr: 4, headSha: BASE_HEAD },
    ...extra,
  });
}

const shipOf = (round: Manifest, id = "ship-5"): Question => {
  const question = round.questions.find((each) => each.id === id);
  if (question === undefined) throw new Error(`no question ${id}`);
  return question;
};

describe("stacked-base frame labels (decision 95(3))", () => {
  it("marks a round-level base's frames as context, not under review", () => {
    expect([...stackedPrefixes(stackedRound())]).toEqual([["base-frame", "base PR #4, not under review: "]]);
  });

  it("names a PR group's own base with its head", () => {
    const round = stackedRound({ stackedOn: undefined, prGroups: [{ pr: "example/app#5", headSha: HEAD, sectionIds: ["own"], stackedOn: { repo: "example/app", pr: 4, headSha: BASE_HEAD } }] });

    expect(stackedPrefixes(round).get("base-frame")).toBe("rendered on #4 at 1234567, context, not under review: ");
    expect(stackedPrefixes(round).has("own-frame")).toBe(false);
  });

  it("leaves a base unlabelled when a question asks about it", () => {
    const round = stackedRound({
      questions: [ship("ship-5", 5), ship("ship-4", 4)],
      sections: [
        section("own", "Own frames", { variantKeys: ["own-frame"], questionIds: ["ship-5"], ...part("ship-5-part") }),
        section("base", "#4 base frames", { variantKeys: ["base-frame"], questionIds: ["ship-4"], ...part("ship-4-part") }),
      ],
    });

    expect(stackedPrefixes(round).size).toBe(0);
  });

  it("adds the prefix once, so a harness-built label is not doubled", () => {
    const prefixes = stackedPrefixes(stackedRound());

    expect(stackedLabel(prefixes, "base-frame", "Card")).toBe("base PR #4, not under review: Card");
    expect(stackedLabel(prefixes, "base-frame", "base PR #4, not under review: Card")).toBe("base PR #4, not under review: Card");
    expect(stackedLabel(prefixes, "own-frame", "Card")).toBe("Card");
  });
});

describe("ships after (harness QuestionBlock)", () => {
  const stackedGroup = (on: { repo: string; pr: number }) => ({ pr: "example/app#5", headSha: HEAD, sectionIds: ["own"], stackedOn: { ...on, headSha: BASE_HEAD } });
  const baseGroup = (pr: string) => ({ pr, headSha: BASE_HEAD, sectionIds: ["base"] });

  it("names the PR group a stacked PR ships after, as #n in its own repo", () => {
    const round = stackedRound({ stackedOn: undefined, prGroups: [baseGroup("example/app#4"), stackedGroup({ repo: "example/app", pr: 4 })] });

    expect(shipsAfter(round, shipOf(round))).toBe("#4");
  });

  it("keeps the repo when the holder is in another one, and names nothing for a base outside the round", () => {
    const other = stackedRound({ stackedOn: undefined, prGroups: [baseGroup("example/lib#4"), stackedGroup({ repo: "example/lib", pr: 4 })] });
    const outside = stackedRound({ stackedOn: undefined, prGroups: [stackedGroup({ repo: "example/app", pr: 9 })] });

    expect(shipsAfter(other, shipOf(other))).toBe("example/lib#4");
    expect(shipsAfter(outside, shipOf(outside))).toBeUndefined();
  });
});
