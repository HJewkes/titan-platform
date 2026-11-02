import { DEFAULT_PANEL_TABLE } from "@titan-design/review-panel";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, type RetryRule } from "@titan-design/review-workflow";
import { beforeAll, describe, expect, it } from "vitest";
import { hashCanonical } from "../hash.js";
import { FAILURE_FIXTURES, SEED_CASES } from "./cases.js";
import { replaySuite, type ReplayVariant } from "./replay.js";
import { compare, reviewScorecard, type ReviewScorecard } from "./scorecard.js";
import { replayWorld } from "./test-fixture.js";

const SUITE = [...SEED_CASES, ...FAILURE_FIXTURES];

const INCUMBENT: ReplayVariant = {
  id: "incumbent",
  policy: {
    plan: { panel: { roles: { g10: "bd-reviewer", standard: "reviewer" }, shapeRoles: { adversary: { g10: "fable-reviewer", standard: "fable-reviewer" } }, panel: DEFAULT_PANEL_TABLE } },
    timing: { pollMs: 1_000, startDeadlineMs: 5_000, verdictDeadlineMs: 10_000 },
  },
};

const withRows = (...rows: RetryRule[]): RetryPolicy => DEFAULT_RETRY_POLICY.map((row) => rows.find((replacement) => replacement.class === row.class) ?? row);
const retryVariant = (id: string, retry: RetryPolicy): ReplayVariant => ({ id, policy: { ...INCUMBENT.policy, retry } });

/** A timed-out member goes to the fixer after its late read, with no fresh member: one session fewer. */
const TIMEOUT_NO_RETRY: RetryRule = { class: "timeout", steps: [{ action: "late-read", times: 1 }], then: { kind: "fixer", key: "timeout" } };
/** A malformed member is respawned instead of corrected, and the fresh one writes no block either: one session more, no verdict. */
const MALFORMED_RESPAWN: RetryRule = { class: "malformed", steps: [{ action: "retry", times: 1 }], then: { kind: "fixer", key: "parser" } };

async function scored(variant: ReplayVariant): Promise<ReviewScorecard> {
  return reviewScorecard(variant, SUITE, await replaySuite(SUITE, [variant], replayWorld));
}

let incumbent: ReviewScorecard;
beforeAll(async () => {
  incumbent = await scored(INCUMBENT);
});

describe("the review-workflow scorecard", () => {
  it("scores the incumbent on verdict quality and reliability, counting only outcomes the replay produced", () => {
    expect({ catch: incumbent.catchRate.caught, of: incumbent.catchRate.blocking, falseBlocks: incumbent.falseBlocks, noVerdict: incumbent.noVerdict }).toEqual({
      catch: 3,
      of: 3,
      falseBlocks: { count: 0, passing: 2 },
      noVerdict: { "needs-fixer": 3, NO_REPRO: 1, "account-hold": 1 },
    });
  });
});

describe("compare on the reliability track", () => {
  it("accepts a retry-policy change on the fixtures alone when sessions per head fall and verdicts reached do not", async () => {
    const result = compare(await scored(retryVariant("timeout-no-retry", withRows(TIMEOUT_NO_RETRY))), incumbent);

    expect({ track: result.track, accept: result.accept, fewerSessions: result.sessionsPerHeadDelta < 0 }).toEqual({ track: "reliability", accept: true, fewerSessions: true });
  });

  it("rejects a candidate that adds a loop even when its sessions per head do not rise", async () => {
    const result = compare(await scored(retryVariant("malformed-respawn", withRows(TIMEOUT_NO_RETRY, MALFORMED_RESPAWN))), incumbent);

    expect({ accept: result.accept, reasons: result.reasons, sessionsPerHeadDelta: result.sessionsPerHeadDelta }).toEqual({
      accept: false,
      reasons: ["new loop on fixture-synthetic-malformed-twice"],
      sessionsPerHeadDelta: 0,
    });
  });

  it("rejects a candidate that misses tp#747 though its retry rows alone changed", async () => {
    const variant = retryVariant("slower", DEFAULT_RETRY_POLICY);
    const results = (await replaySuite(SUITE, [variant], replayWorld)).map((result) => (result.caseId === "seed-tp747-empty-contexts" ? { ...result, hit: false } : result));

    expect(compare(reviewScorecard(variant, SUITE, results), incumbent).reasons).toEqual(["seed case seed-tp747-empty-contexts missed"]);
  });
});

describe("compare on the verdict track", () => {
  /** The incumbent's own replay results, relabelled as a variant whose plan differs, with the sessions it spent changed. */
  async function planVariant(sessionsDelta: number): Promise<ReviewScorecard> {
    const { panel } = INCUMBENT.policy.plan;
    const variant: ReplayVariant = { id: "roles", policy: { ...INCUMBENT.policy, plan: { panel: { ...panel, roles: { ...panel.roles, standard: "sonnet-reviewer" } } } } };
    const results = (await replaySuite(SUITE, [INCUMBENT], replayWorld)).map((result) => ({
      ...result,
      variantHash: hashCanonical(variant.policy),
      sessions: result.caseId === "seed-tp747-empty-contexts" ? result.sessions + sessionsDelta : result.sessions,
    }));
    return reviewScorecard(variant, SUITE, results);
  }

  it("rejects a plan change that catches as much at no lower cost", async () => {
    const result = compare(await planVariant(0), incumbent);

    expect({ track: result.track, reasons: result.reasons }).toEqual({ track: "verdict", reasons: ["same catch without lower cost"] });
  });

  it("accepts a plan change that catches as much for fewer sessions", async () => {
    expect(compare(await planVariant(-1), incumbent).accept).toBe(true);
  });
});
