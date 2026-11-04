import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPort } from "@titan-design/github";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { getRound } from "./rounds.js";
import { shipLineageReader } from "./ship-lineage.js";

const BOUND_MS = 5_000;

function source(getPr: GitHubPort["getPr"]) {
  const lineage = shipLineageReader({ github: { getPr, getHeadSha: async () => null }, timeoutMs: BOUND_MS });
  return { dir: FIXTURE_ROUNDS.dir, lineage };
}

describe("a Ship round's lineage read bound", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rounds.get returns within the bound when GitHub stalls and marks lineage unknown with a reason", async () => {
    const getPr = vi.fn<GitHubPort["getPr"]>(() => new Promise<never>(() => {}));
    const stalled = getRound(source(getPr), "ship-tile-r1");

    await vi.waitFor(() => expect(getPr).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(BOUND_MS);

    expect(await stalled).toMatchObject({ ship: true, lineage: { known: false, reason: "github timed out" } });
  });

  it("a GitHub error marks lineage unknown with the error reason", async () => {
    const detail = await getRound(source(async () => { throw new Error("rate limited"); }), "ship-tile-r1");

    expect(detail).toMatchObject({ lineage: { known: false, reason: expect.stringContaining("rate limited") } });
  });
});
