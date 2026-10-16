import { describe, expect, it } from "vitest";
import { contentTerms, guardRewrite, type GuardOptions, type GuardRejection, type GuardRule } from "./rewrite-guard.js";

const rules = (source: string, candidate: string, span: string, opts: GuardOptions = {}): GuardRule[] =>
  guardRewrite(source, candidate, span, opts).map((rejection: GuardRejection) => rejection.rule);

describe("guardRewrite numbers", () => {
  // Catches: the number check skipped, so a candidate that drops a count is accepted.
  it("rejects a candidate that drops a number, naming it", () => {
    const rejections = guardRewrite("the flomber sync runs 13 hops.", "the flomber sync runs many hops.", "13");

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.rule).toBe("number");
    expect(rejections[0]?.detail).toContain("13");
  });

  // Catches: comparing raw text, so digits and their spoken words never meet.
  it("accepts a number spelled out the way normalization reads it", () => {
    expect(rules("the flomber sync runs 147 hops.", "the flomber sync runs one hundred forty-seven hops.", "147")).toEqual([]);
  });

  // Catches: a subset check in place of multiset equality, so an added number passes.
  it("rejects a candidate that adds a number", () => {
    expect(rules("the flomber sync runs 13 hops.", "the flomber sync runs 13 hops in 4 waves.", "hops")).toEqual(["number"]);
  });
});

describe("guardRewrite entities", () => {
  // Catches: the entity check skipped, or the sentence-initial exemption applied to every word.
  it("rejects a candidate that drops a name in mid-sentence", () => {
    const rejections = guardRewrite("then Quellan syncs the flomber.", "then it syncs the flomber.", "syncs");

    expect(rejections.map((r) => r.rule)).toEqual(["entity"]);
    expect(rejections[0]?.detail).toContain("Quellan");
  });

  it("does not treat a sentence-initial capital as a name", () => {
    expect(rules("Then the flomber syncs.", "then the flomber syncs.", "syncs")).toEqual([]);
  });

  // Catches: protectedTerms ignored, so an all-lowercase coined term can be dropped.
  it("rejects a candidate that drops a protected term", () => {
    const opts = { protectedTerms: ["zorptrix"] };

    expect(rules("the zorptrix sync is live.", "the sync is live.", "live", opts)).toEqual(["entity"]);
    expect(rules("the zorptrix sync is live.", "the sync is live.", "live")).toEqual([]);
  });
});

describe("guardRewrite markup", () => {
  const source = "the [show](/ʃˈO/) runs 13 hops [live](=adj).";

  // Catches: every link exempted rather than only the flagged span's own link.
  it("lets the span's own markup go but keeps every other link verbatim", () => {
    expect(rules(source, "the [show](/ʃˈO/) runs 13 hops on air.", "live")).toEqual([]);
    expect(rules(source, "the show runs 13 hops on air.", "live")).toEqual(["markup"]);
    expect(rules(source, "the [show](/ʃˈɒ/) runs 13 hops on air.", "live")).toEqual(["markup"]);
  });
});

describe("guardRewrite content terms", () => {
  const source = "the flomber sync gathers quiet hops.";

  // Catches: an off-by-one in maxDroppedTerms.
  it("allows one dropped content term and rejects two", () => {
    expect(rules(source, "the flomber sync gathers hops.", "quiet")).toEqual([]);
    expect(rules(source, "the flomber sync takes hops.", "quiet")).toEqual(["terms"]);
  });
});

describe("guardRewrite length", () => {
  // Catches: the minimum slack ignored, so a short sentence cannot gain two words.
  it("allows a short sentence to grow within the slack and rejects a sprawling one", () => {
    expect(rules("the show is live", "the show is in real time", "live")).toEqual([]);
    expect(
      rules("the show is live", "the show is going out right now to every flomber in the hall", "live"),
    ).toEqual(["length"]);
  });

  it("counts a path's symbol words, not the path, as the growth", () => {
    expect(rules("then run src/flomber_util.ts.", "then run src slash flomber underscore util dot ts.", "src/flomber_util.ts")).toEqual(
      [],
    );
  });
});

describe("guardRewrite empty", () => {
  it("rejects an empty candidate", () => {
    expect(rules("the show is live.", "  ", "live")).toEqual(["empty"]);
  });
});

describe("contentTerms", () => {
  // Golden values recorded from explainer's lint-text contentTerms on these lines.
  // Catches: the moved copy drifting from the original.
  it.each([
    ["The readers kept reading every flomber chapter twice.", ["read", "kept", "flomb", "twice"]],
    [
      "Quellan writes 147 zorptrix modules, and the builder fixes them.",
      ["quellan", "writ", "147", "zorptrix", "modul", "build", "fix"],
    ],
    ["It is just here now, but the shows are streaming tonight.", ["show", "stream", "tonight"]],
  ])("matches explainer on %j", (line, expected) => {
    expect([...contentTerms(line)]).toEqual(expected);
  });
});
