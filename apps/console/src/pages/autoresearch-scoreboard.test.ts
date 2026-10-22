import { describe, expect, it } from "vitest";
import { AR_RUN_FIXTURE } from "../../server/twin/autoresearch.js";
import { scoreboard } from "./autoresearch-scoreboard.js";

describe("autoresearch scoreboard", () => {
  it("keeps the superseded winner out of the keep rate and the stop histogram", () => {
    const board = scoreboard(AR_RUN_FIXTURE);

    expect([board.kept, board.rejected, board.stopped, board.superseded]).toEqual([1, 2, 0, 1]);
    expect(board.keepRate).toBeCloseTo(1 / 3);
    expect(board.stopsByRung).toEqual({ L0: 1, L1: 0, L2: 1, L3: 0 });
  });

  it("counts as wasted only the spend on ideas rejected past L1", () => {
    const board = scoreboard(AR_RUN_FIXTURE);

    expect(board.wastedUsd).toBeCloseTo(1.6);
  });

  it("leaves an L0 reject, which has no Δ, off the losses list", () => {
    const board = scoreboard(AR_RUN_FIXTURE);

    expect(board.losses.map((row) => row.id)).toEqual(["i-c81e5a7f3b20"]);
    expect(board.wins.map((row) => [row.id, Number(row.deltaOverSigma.toFixed(2))])).toEqual([["i-3f9a0c1d2e4b", 1.94]]);
  });

  it("has no keep rate or $ per kept before any decision", () => {
    const board = scoreboard({ ...AR_RUN_FIXTURE, rounds: [] });

    expect([board.keepRate, board.usdPerKept, board.wastedUsd]).toEqual([undefined, undefined, 0]);
  });
});
