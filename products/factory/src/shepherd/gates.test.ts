import { describe, expect, it } from "vitest";
import type { Escalated } from "./route-table.js";
import { liveEscalation } from "./gates.js";

const HEAD = "a".repeat(40);
const conflict: Escalated = { escalation: "conflict", detail: "dirty at the old head", carriedFrom: "b".repeat(40) };

function cleanRun(headRow: Escalated) {
  const lastCi = { headSha: HEAD, mergeableState: "clean" };
  return { carried: conflict as Escalated | undefined, escalations: new Map([[HEAD, headRow]]), lastCi };
}

describe("liveEscalation", () => {
  it.each(["fix-first-runaway", "no-progress"] as const)(
    "clears a carried conflict at a clean head but keeps the %s escalation at that head",
    (escalation) => {
      const row: Escalated = { escalation, detail: `the last at ${HEAD}` };
      const run = cleanRun(row);

      const live = liveEscalation(run, HEAD);

      expect(live).toEqual(row);
      expect(run.carried).toBeUndefined();
      expect(run.escalations.get(HEAD)).toEqual(row);
    },
  );

  it("drops a carried conflict and a conflict head row together at a clean head", () => {
    const run = cleanRun(conflict);

    expect(liveEscalation(run, HEAD)).toBeUndefined();
    expect(run.escalations.size).toBe(0);
  });

  it("keeps a carried conflict while the head still reads dirty", () => {
    const run = cleanRun({ escalation: "no-progress", detail: "x" });
    run.lastCi = { headSha: HEAD, mergeableState: "dirty" };

    expect(liveEscalation(run, HEAD)).toEqual(conflict);
  });
});
