import { describe, expect, it } from "vitest";
import type { ArRunView } from "../../server/autoresearch-view.js";
import { AR_RUN_FIXTURE } from "../../server/twin/autoresearch.js";
import { bugRepeatRates, REGISTRY_TAIL, registryTails } from "./autoresearch-registries.js";

const L0_STOP = AR_RUN_FIXTURE.rounds[1]!.ladders[0]!;

function l0Stop(reason: string): ArRunView["rounds"][number]["ladders"][number] {
  return { ...L0_STOP, outcome: { ...L0_STOP.outcome!, reason } };
}

describe("autoresearch bug-repeat rate", () => {
  it("counts an L0 failure as a repeat only when an earlier round logged its code", () => {
    const [first, second, third] = AR_RUN_FIXTURE.rounds;
    const run: ArRunView = {
      ...AR_RUN_FIXTURE,
      rounds: [
        { ...first!, ladders: [l0Stop("rejected:post:unit"), l0Stop("rejected:post:unit")] },
        { ...second!, ladders: [l0Stop("rejected:post:unit"), l0Stop("rejected:post:bounds")] },
        { ...third!, ladders: [] },
      ],
    };

    expect(bugRepeatRates(run)).toEqual([
      { round: 1, failures: 2, repeats: 0, rate: 0 },
      { round: 2, failures: 2, repeats: 1, rate: 0.5 },
      { round: 3, failures: 0, repeats: 0, rate: undefined },
    ]);
  });

  it("leaves a stop past L0 out of the failures", () => {
    expect(bugRepeatRates(AR_RUN_FIXTURE).map((entry) => entry.failures)).toEqual([0, 1, 0]);
  });
});

describe("autoresearch registry tails", () => {
  it("keeps the newest rows the briefs carry", () => {
    const bugs = Array.from({ length: REGISTRY_TAIL + 2 }, (_, index) => ({ symptom: `s${index}`, fix: "", source: "L0" as const }));

    const tails = registryTails({ deadEnds: [], bugs });

    expect(tails.bugs.map((bug) => bug.symptom)).toEqual(bugs.slice(2).map((bug) => bug.symptom));
  });
});
