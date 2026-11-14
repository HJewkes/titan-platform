import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { attestDeclined, attestDeclinedWake, declinedSteps } from "./attest-send-back.js";
import type { Verdict } from "./phases.js";

const HEAD = fakeSha("attest-brief");
const unmetRows = (rows: readonly [string, string][]): Verdict => ({ kind: "MERGE", headSha: HEAD, evidence: { attest: { unmet: rows.map(([step, why]) => ({ step, why })) } } });

describe("the declined-attestation brief names who declined (TP-5902)", () => {
  it("a correctness decline beside an adversary decline names each reviewer's steps", () => {
    const payload = attestDeclined(1, declinedSteps(unmetRows([["ci-wait", "no-meeter"], ["merge", "adversary-declined"]]), HEAD));

    const brief = attestDeclinedWake(HEAD, payload);

    expect(brief?.reason).toContain("the independent reviewer did not attest that ci-wait and the adversary did not attest that merge");
    expect(brief?.payload).toBe("Steps the independent reviewer did not attest: ci-wait\nSteps the adversary did not attest: merge");
  });

  it("a payload recorded before TP-5902, with no adversary list, still names the independent reviewer", () => {
    const recorded = { kind: "ATTEST_DECLINED", steps: ["ci-wait"], file: "products/factory/src/registry/attestations/1.json" };

    const brief = attestDeclinedWake(HEAD, recorded);

    expect(brief?.reason).toContain("the independent reviewer did not attest that ci-wait behave as before");
  });

  it("an adversary-missing row beside a decline sends nothing back", () => {
    const steps = declinedSteps(unmetRows([["ci-wait", "adversary-declined"], ["merge", "adversary-missing"]]), HEAD);

    expect(steps).toEqual([]);
  });
});
