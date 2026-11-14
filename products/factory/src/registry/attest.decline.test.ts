import type { ReviewerAgent } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { judgeAttestations, type Attestation, type AttestingVerdict } from "./attest.js";

const agent = (name: string): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: "human", predecessor: null });
const reviewer = agent("rev-1");
const adversary = agent("adv-1");

const CLOSURE12 = "a1b2c3d4e5f6";
const CLOSURE = `${CLOSURE12}${"0".repeat(52)}`;
const HEAD = "head-sha-1";
const claimOf = (step: string): Attestation => ({ step, closure: CLOSURE, pr: 7 });
const attesting = (by: ReviewerAgent, steps: readonly string[]): AttestingVerdict => ({ reviewer: by, attests: steps.map((step) => `${step}@${CLOSURE12}`), head: HEAD });

/** An adversary-class judgment where the correctness reviewer attests every claimed step and the adversary answers with `adversaryVerdict`, if at all. */
const judge = (claimed: readonly string[], adversaryVerdict?: AttestingVerdict) =>
  judgeAttestations({
    claimed: claimed.map(claimOf),
    head: HEAD,
    correctness: { ...attesting(reviewer, claimed), carried: false },
    ...(adversaryVerdict && { adversary: adversaryVerdict }),
    adversaryRequired: true,
    independent: () => true,
    separate: (a, b) => a.agentId !== b.agentId,
  });

describe("judgeAttestations on an adversary that declines (TP-5902)", () => {
  it("an adversary MERGE at the head with no Attests line declines the row: adversary-declined, not adversary-missing", () => {
    const result = judge(["ci-wait"], attesting(adversary, []));

    expect(result.unmet).toEqual([{ step: "ci-wait", closure: CLOSURE, why: "adversary-declined" }]);
  });

  it("no adversary verdict at all is still adversary-missing", () => {
    const result = judge(["ci-wait"]);

    expect(result.unmet).toEqual([{ step: "ci-wait", closure: CLOSURE, why: "adversary-missing" }]);
  });

  it("an adversary that attests some claimed steps declines only the one it left out", () => {
    const result = judge(["ci-wait", "sh-await-verdict", "merge"], attesting(adversary, ["ci-wait", "sh-await-verdict"]));

    expect(result.unmet).toEqual([{ step: "merge", closure: CLOSURE, why: "adversary-declined" }]);
    expect(result.met.map(({ step }) => step)).toEqual(["ci-wait", "sh-await-verdict"]);
  });
});
