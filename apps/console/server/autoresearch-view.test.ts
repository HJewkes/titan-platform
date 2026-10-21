import { describe, expect, it } from "vitest";
import { ArRunViewSchema, type ArRunView } from "./autoresearch-view.js";
import { AR_RUN_FIXTURE } from "./twin/autoresearch.js";

const outcomes = (run: ArRunView) => run.rounds.flatMap((round) => round.ladders.map((ladder) => ladder.outcome));

describe("the autoresearch run fixture", () => {
  it("parses against the run view schema unchanged", () => {
    expect(ArRunViewSchema.parse(AR_RUN_FIXTURE)).toEqual(AR_RUN_FIXTURE);
  });

  it("holds three rounds with one idea kept, one superseded, one stopped at L0 and one running", () => {
    const ended = outcomes(AR_RUN_FIXTURE);

    expect(AR_RUN_FIXTURE.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
    expect(ended.filter((outcome) => outcome?.verdict === "kept")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome?.reason === "superseded")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome?.rungReached === "L0")).toHaveLength(1);
    expect(ended.filter((outcome) => outcome === null)).toHaveLength(1);
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

  it("strips a field the page does not show", () => {
    const parsed = ArRunViewSchema.parse({ ...AR_RUN_FIXTURE, owner: "someone" });
    expect(parsed).not.toHaveProperty("owner");
  });
});
