import { describe, expect, it } from "vitest";
import type { Manifest, Question } from "../../server/round-schema.js";
import { shipsAfter, stackedLabel, stackedPrefixes } from "./ship-stack.js";

const BASE_HEAD = "1234567".padEnd(40, "0");
const section = (id: string, title: string, rest: Partial<Manifest["sections"][number]>) => ({ id, title, deciding: "d", context: "c", questionIds: [], variantKeys: [], ...rest }) as Manifest["sections"][number];
const ship = (id: string, repo: string, pr: number) => ({ id, kind: "pick-one", prompt: "Ship?", options: ["Ship", "Back"], page: `${repo}#${pr}`, merge: { repo, pr, headSha: "a".repeat(40), ship: ["Ship"] } }) as Question;

const SHIP_5 = ship("ship-5", "example/app", 5);

/** A round over example/app#5 whose `base` section shows frames of the PR it is stacked on. */
function stackedRound(extra: Partial<Manifest> = {}): Manifest {
  return {
    sections: [section("own", "Own frames", { variantKeys: ["own-frame"], questionIds: ["ship-5"] }), section("base", "#4 base frames", { variantKeys: ["base-frame"] })],
    questions: [SHIP_5],
    stackedOn: { repo: "example/app", pr: 4, headSha: BASE_HEAD },
    ...extra,
  } as Manifest;
}

describe("stacked-base frame labels (decision 95(3))", () => {
  it("marks a round-level base's frames as context, not under review", () => {
    expect([...stackedPrefixes(stackedRound())]).toEqual([["base-frame", "base PR #4, not under review: "]]);
  });

  it("names a PR group's own base with its head", () => {
    const round = stackedRound({
      stackedOn: undefined,
      prGroups: [{ pr: "example/app#5", headSha: "a".repeat(40), sectionIds: ["own"], stackedOn: { repo: "example/app", pr: 4, headSha: BASE_HEAD } }],
    } as Partial<Manifest>);

    expect(stackedPrefixes(round).get("base-frame")).toBe("rendered on #4 at 1234567, context, not under review: ");
    expect(stackedPrefixes(round).has("own-frame")).toBe(false);
  });

  it("leaves a base unlabelled when a question asks about it", () => {
    const round = stackedRound({ questions: [SHIP_5, ship("ship-4", "example/app", 4)] });

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
  const groups = (on: { repo: string; pr: number }) => [
    { pr: "example/app#4", headSha: "b".repeat(40), sectionIds: ["base"] },
    { pr: "example/app#5", headSha: "a".repeat(40), sectionIds: ["own"], stackedOn: { ...on, headSha: BASE_HEAD } },
  ];

  it("names the PR group a stacked PR ships after, as #n in its own repo", () => {
    const round = stackedRound({ prGroups: groups({ repo: "example/app", pr: 4 }) } as Partial<Manifest>);

    expect(shipsAfter(round, SHIP_5)).toBe("#4");
  });

  it("keeps the repo when the holder is in another one, and names nothing for a base outside the round", () => {
    const other = stackedRound({ prGroups: [{ ...groups({ repo: "example/app", pr: 4 })[0], pr: "example/lib#4" }, groups({ repo: "example/lib", pr: 4 })[1]] } as Partial<Manifest>);
    const outside = stackedRound({ prGroups: [groups({ repo: "example/app", pr: 9 })[1]] } as Partial<Manifest>);

    expect(shipsAfter(other, SHIP_5)).toBe("example/lib#4");
    expect(shipsAfter(outside, SHIP_5)).toBeUndefined();
  });
});
