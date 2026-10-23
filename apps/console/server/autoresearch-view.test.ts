import { describe, expect, it } from "vitest";
import { ArRunSummarySchema, ArRunViewSchema, type ArRunView } from "./autoresearch-view.js";
import { AR_RUN_FIXTURE, AR_RUN_PRE_S3A, AR_RUN_SUMMARY, AR_RUN_SYNC_FAILED } from "./twin/autoresearch.js";

const outcomes = (run: ArRunView) => run.rounds.flatMap((round) => round.ladders.map((ladder) => ladder.outcome));

/** The record as a factory that never wrote these keys would send it. */
function without(record: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

describe("the autoresearch run fixture", () => {
  it("parses against the run view schema unchanged, S3a fields included", () => {
    expect(ArRunViewSchema.parse(AR_RUN_FIXTURE)).toEqual(AR_RUN_FIXTURE);
  });

  it("still parses a run recorded before S3a, which has none of its fields", () => {
    expect(ArRunViewSchema.parse(AR_RUN_PRE_S3A)).toEqual(AR_RUN_PRE_S3A);
  });

  it("holds three rounds with one idea kept, one superseded, one stopped at L0, one rejected at L2 and two running", () => {
    const ended = outcomes(AR_RUN_FIXTURE);

    expect(AR_RUN_FIXTURE.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
    expect(ended.filter((outcome) => outcome?.verdict === "kept")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome?.reason === "superseded")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome?.rungReached === "L0")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome?.reason === "clearly-worse")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome === null)).toHaveLength(2);
  });

  it("requeues the superseded winner in a later round's queue", () => {
    const superseded = outcomes(AR_RUN_FIXTURE).findIndex((outcome) => outcome?.reason === "superseded");
    const id = AR_RUN_FIXTURE.rounds.flatMap((round) => round.ladders)[superseded]!.idea.id;

    expect(AR_RUN_FIXTURE.rounds[1]!.queue).toContainEqual(expect.objectContaining({ id, source: "requeue" }));
  });
});

describe("the run view schema", () => {
  it("refuses a run without its pinned target, which labels every metric", () => {
    expect(ArRunViewSchema.safeParse({ ...AR_RUN_FIXTURE, target: undefined }).success).toBe(false);
  });

  it("refuses a ladder that drops its outcome rather than nulling it", () => {
    const [first, ...rest] = AR_RUN_FIXTURE.rounds;
    const broken = { ...AR_RUN_FIXTURE, rounds: [{ ...first!, ladders: [{ ...first!.ladders[0]!, outcome: undefined }] }, ...rest] };
    expect(ArRunViewSchema.safeParse(broken).success).toBe(false);
  });

  it("reads a round whose planner gave no quota exemption as exempting nothing", () => {
    const [first, ...rest] = AR_RUN_FIXTURE.rounds;
    const withoutExempt: Record<string, unknown> = { ...first! };
    delete withoutExempt.exempt;

    const parsed = ArRunViewSchema.parse({ ...AR_RUN_FIXTURE, rounds: [withoutExempt, ...rest] });

    expect(parsed.rounds[0]!.exempt).toEqual({});
  });

  it("refuses a runs row without its current round, which the Round column shows", () => {
    const row: Record<string, unknown> = { ...AR_RUN_SUMMARY };
    delete row.round;
    expect(ArRunSummarySchema.safeParse(row).success).toBe(false);
  });

  it("keeps an ended run's stop reason under the engine's name", () => {
    const parsed = ArRunViewSchema.parse({ ...AR_RUN_FIXTURE, status: "completed", stopReason: "rounds-without-gain" });
    expect(parsed.stopReason).toBe("rounds-without-gain");
  });

  it("reads a run and a runs row from a factory before C-256 S5 as having no move, re-evaluation, snapshot or sync", () => {
    const rounds = AR_RUN_PRE_S3A.rounds.map((round) => without(round, "moves", "reevals"));
    const run = without({ ...AR_RUN_PRE_S3A, rounds }, "snapshots", "snapshotPending", "syncs");
    const row = without(AR_RUN_SUMMARY, "openSnapshot");

    const parsed = ArRunViewSchema.parse(run);

    expect(parsed.rounds.map((round) => [round.moves, round.reevals])).toEqual([[[], []], [[], []], [[], []]]);
    expect(parsed).toMatchObject({ snapshots: [], snapshotPending: null, syncs: [] });
    expect(ArRunSummarySchema.parse(row).openSnapshot).toBeNull();
  });

  it("keeps a sync's re-measure under its sync and admits no sync rung to any ladder", () => {
    const [first, ...rest] = AR_RUN_FIXTURE.rounds;
    const [ladder, ...others] = first!.ladders;
    const syncRung = { ...AR_RUN_FIXTURE, rounds: [{ ...first!, ladders: [{ ...ladder!, outcome: { ...ladder!.outcome!, rungReached: "sync" } }, ...others] }, ...rest] };

    const parsed = ArRunViewSchema.parse(AR_RUN_FIXTURE);

    expect(ArRunViewSchema.safeParse(syncRung).success).toBe(false);
    expect(parsed.syncs[0]!.runs!.map((entry) => entry.repeat)).toEqual(["s1", "s2", "s3"]);
    expect(outcomes(parsed).flatMap((outcome) => (outcome === null ? [] : [outcome.rungReached])).every((rung) => ["none", "L0", "L1", "L2", "L3"].includes(rung))).toBe(true);
    expect(parsed.rounds.flatMap((round) => round.ladders.flatMap((entry) => entry.evals)).some((entry) => entry.repeat.startsWith("s"))).toBe(false);
  });

  it("keeps a failed sync's reason on a sync that stays open", () => {
    const parsed = ArRunViewSchema.parse(AR_RUN_SYNC_FAILED);

    expect(parsed.syncs[1]).toEqual({ round: 3, pr: 102, state: "open", failed: "[sync-push] the push to the snapshot branch was refused" });
  });

  it("refuses a re-evaluation decision the engine does not make", () => {
    const [first, ...rest] = AR_RUN_FIXTURE.rounds;
    const broken = { ...AR_RUN_FIXTURE, rounds: [{ ...first!, reevals: [{ ...first!.reevals[0]!, decision: "superseded" }] }, ...rest] };
    expect(ArRunViewSchema.safeParse(broken).success).toBe(false);
  });

  it("strips a field the page does not show", () => {
    const parsed = ArRunViewSchema.parse({ ...AR_RUN_FIXTURE, owner: "someone" });
    expect(parsed).not.toHaveProperty("owner");
  });
});
