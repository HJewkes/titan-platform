import type { ReviewerAgent } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { independentOfRun } from "../shepherd/lineage.js";
import { separateLineages } from "../shepherd/reviewer-lineage.js";
import { claimedRows, judgeAttestations, type Attestation, type AttestingVerdict, type JudgeInput } from "./attest.js";

const agent = (name: string, spawnedBy: string | null, generation = 0): ReviewerAgent => ({
  name,
  agentId: `agent-${name}-${generation}`,
  sessionId: `session-${name}-${generation}`,
  presence: "live",
  spawnedBy,
  predecessor: null,
});

// Shepherd's CLI spawns are recorded as the human, and each such spawn is a fresh conversation.
const human = agent("human", null);
const implementer = agent("impl-a", "human");
const fixerWhoPushed = agent("fix-2", "human");
const fixerSpawnedByImplementer = agent("fix-1", "impl-a");
const reviewer = agent("rev-1", "human");
const adversary = agent("adv-1", "human");
const reviewerAgain = agent("rev-1", "human", 1);
const rows = [human, implementer, fixerWhoPushed, fixerSpawnedByImplementer, reviewer, adversary, reviewerAgain];
const authors = [implementer, fixerWhoPushed];

const CLOSURE = `a1b2c3d4e5f6${"0".repeat(52)}`;
const row: Attestation = { step: "ci-wait", closure: CLOSURE, pr: 7 };
const HEAD = "head-sha-1";

const verdict = (by: ReviewerAgent | undefined, attests = ["ci-wait@a1b2c3d4e5f6"]): AttestingVerdict => ({ reviewer: by, attests, head: HEAD });

const judge = (overrides: Partial<JudgeInput>) =>
  judgeAttestations({
    claimed: [row],
    head: HEAD,
    correctness: { ...verdict(reviewer), carried: false },
    adversaryRequired: false,
    independent: (candidate) => independentOfRun(candidate, { implementer: implementer.name }, { rows, complete: true }, authors),
    separate: (a, b) => separateLineages(a, b, rows),
    ...overrides,
  });

const whyUnmet = (overrides: Partial<JudgeInput>) => judge(overrides).unmet.map((unmet) => unmet.why);

describe("judgeAttestations", () => {
  it("the fact rejects the implementer as the meeter", () => {
    expect(whyUnmet({ correctness: { ...verdict(implementer), carried: false } })).toEqual(["meeter-is-author"]);
  });

  it("the fact rejects a fixer as the meeter", () => {
    expect(whyUnmet({ correctness: { ...verdict(fixerWhoPushed), carried: false } })).toEqual(["meeter-is-author"]);
  });

  it("a fixer spawned by the implementer is rejected through lineage even before it pushed", () => {
    expect(whyUnmet({ correctness: { ...verdict(fixerSpawnedByImplementer), carried: false } })).toEqual(["meeter-is-author"]);
  });

  it("a reviewer the roster cannot name meets nothing", () => {
    expect(whyUnmet({ correctness: { ...verdict(undefined), carried: false } })).toEqual(["meeter-is-author"]);
  });

  it("an independent reviewer's Attests line meets the row on a class with no adversary", () => {
    const result = judge({});

    expect(result.unmet).toEqual([]);
    expect(result.met).toEqual([{ step: "ci-wait", closure: CLOSURE, meeters: [reviewer] }]);
  });

  it("where the class has an adversary, the correctness line alone leaves the row unmet: adversary-missing", () => {
    expect(whyUnmet({ adversaryRequired: true })).toEqual(["adversary-missing"]);
    expect(whyUnmet({ adversaryRequired: true, adversary: verdict(adversary, []) })).toEqual(["adversary-missing"]);
  });

  it("an adversary that wrote the code does not meet an adversary class", () => {
    expect(whyUnmet({ adversaryRequired: true, adversary: verdict(fixerWhoPushed) })).toEqual(["meeter-is-author"]);
  });

  it("an independent adversary's line from a separate conversation meets an adversary class", () => {
    expect(judge({ adversaryRequired: true, adversary: verdict(adversary) }).met[0]?.meeters).toEqual([reviewer, adversary]);
  });

  it("two Attests lines from one lineage do not meet an adversary class: adversary-same-lineage", () => {
    expect(whyUnmet({ adversaryRequired: true, adversary: verdict(reviewerAgain) })).toEqual(["adversary-same-lineage"]);
  });

  it("an Attests line for another closure meets nothing: closure-mismatch", () => {
    expect(whyUnmet({ correctness: { ...verdict(reviewer, ["ci-wait@a1b2c3d4ffff"]), carried: false } })).toEqual(["closure-mismatch"]);
  });

  it("a carried MERGE meets nothing in M1b", () => {
    expect(whyUnmet({ correctness: { ...verdict(reviewer), carried: true } })).toEqual(["carried"]);
    expect(whyUnmet({ correctness: { ...verdict(reviewer), head: "older-head", carried: false } })).toEqual(["carried"]);
  });

  it("a malformed Attests token names nothing: no-meeter", () => {
    expect(whyUnmet({ correctness: { ...verdict(reviewer, ["ci-wait@A1B2C3D4E5F6", "ci-wait"]), carried: false } })).toEqual(["no-meeter"]);
  });
});

describe("claimedRows", () => {
  it("a row unchanged from base is not claimed, so it needs no meeter", () => {
    const merge: Attestation = { step: "merge", closure: CLOSURE, pr: 3 };

    expect(claimedRows([merge], [merge])).toEqual([]);
    expect(judge({ claimed: claimedRows([merge], [merge]), correctness: { ...verdict(implementer), carried: false } })).toEqual({ met: [], unmet: [] });
  });

  it("a changed closure in an existing row is claimed again, and a new row is claimed", () => {
    const before: Attestation = { step: "ci-wait", closure: `ffff${"0".repeat(60)}`, pr: 3 };
    const merge: Attestation = { step: "merge", closure: CLOSURE, pr: 7 };

    expect(claimedRows([before], [row, merge])).toEqual([row, merge]);
  });
});
