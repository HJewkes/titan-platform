import { describe, expect, it } from "vitest";
import { jaccard } from "../text.js";
import { dedupeFacts } from "./dedupe.js";
import { fact, reversedRotation } from "./facts.fixture.js";

const BASE = "run the full lint and test suite before you push any branch to the shared remote for review by the team today";
const SHARED = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";

describe("dedupeFacts", () => {
  it("merges the same body in two projects when it differs only in whitespace and case", () => {
    const facts = [fact("a", { body: "Run pnpm lint first", project: "p1" }), fact("b", { body: "run  PNPM lint\nfirst", project: "p2" })];
    const deduped = dedupeFacts(facts);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.sources.map((source) => source.ref.project)).toEqual(["p1", "p2"]);
  });

  it("merges near-duplicates at Jaccard 0.9 with the same polarity", () => {
    const [a, b] = [`Always ${BASE}`, `Usually ${BASE}`];
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.9);
    expect(dedupeFacts([fact("a", { body: a }), fact("b", { body: b })])).toHaveLength(1);
  });

  it("keeps a rule and its negation apart even at Jaccard 0.9", () => {
    const [always, never] = [`Always ${BASE}`, `Never ${BASE}`];
    expect(jaccard(always, never)).toBeGreaterThanOrEqual(0.9);
    expect(dedupeFacts([fact("a", { body: always }), fact("b", { body: never })])).toHaveLength(2);
  });

  it("keeps facts at Jaccard 0.6 separate", () => {
    const [a, b] = [`${SHARED} mike november oscar papa`, `${SHARED} quebec romeo sierra tango`];
    expect(jaccard(a, b)).toBeCloseTo(0.6);
    expect(dedupeFacts([fact("a", { body: a }), fact("b", { body: b })])).toHaveLength(2);
  });

  it("picks the longest body as representative, ties by path, whatever the input order", () => {
    const facts = [
      fact("c", { body: `Always ${BASE}` }),
      fact("b", { body: `Usually ${BASE}` }),
      fact("a", { body: `Mostly ${BASE}` }),
      fact("d", { body: `Often ${BASE}` }),
    ];
    const [forward] = dedupeFacts(facts);
    const [shuffled] = dedupeFacts(reversedRotation(facts));
    expect(forward?.fact.ref.path).toBe("/memory/p1/b.md");
    expect(shuffled).toEqual(forward);
  });
});
