import { describe, expect, it } from "vitest";
import { seedFactSteps } from "../../registry/steps/seed-facts.js";
import { projectionDigest } from "../projection.js";
import type { Verdict } from "../validity.js";
import { compareCall, type CompareCall } from "./compare.js";

const ciWait = seedFactSteps[0]!;
const SHA = "a".repeat(40);
const green = { verdict: "green", headSha: SHA, mergeableState: "clean" };
const red = { verdict: "red", headSha: SHA, mergeableState: "clean" };
const digestOfGreen = projectionDigest(ciWait, green);
const valid = (drift: string[] = []): Verdict => ({ status: "valid", digests: { projection: digestOfGreen, output: "sha256:x" }, drift });

const call = (over: Partial<CompareCall> = {}): CompareCall => ({
  verdict: valid(),
  wouldFastForward: true,
  markerProjection: digestOfGreen,
  liveOutput: green,
  entry: ciWait,
  memoHit: false,
  ...over,
});

describe("compareCall", () => {
  it("a would-fast-forward call whose live projection matches is a hit", () => {
    // The live output carries a field outside the projection, so only a projection compare agrees.
    const row = compareCall(call({ liveOutput: { ...green, extra: "outside the projection" } }));

    expect(row).toMatchObject({ family: "tree", class: "hit", materialValid: true, fullValid: true, drift: [], liveProjection: digestOfGreen });
  });

  it("a would-fast-forward call whose live projection differs is a false-hit, recording material-valid and full-valid separately", () => {
    const row = compareCall(call({ verdict: valid(["head:pushed"]), liveOutput: red }));

    expect(row).toMatchObject({ family: "tree", class: "false-hit", materialValid: true, fullValid: false, drift: ["head:pushed"] });
  });

  it("a memo hit and an Unavailable output give no row", () => {
    const unavailable = { unavailable: { resetAt: 1_798_000_000_000, reason: "rate-limited", class: "core-read" } };

    expect(compareCall(call({ memoHit: true }))).toBeUndefined();
    expect(compareCall(call({ liveOutput: unavailable }))).toBeUndefined();
  });

  it("a call with no verdict is unmarked", () => {
    const row = compareCall(call({ verdict: undefined, wouldFastForward: false, markerProjection: null }));

    expect(row).toMatchObject({ class: "unmarked", materialValid: false, fullValid: false, drift: [] });
  });

  it("a miss whose live projection equals the previous marker's is miss-same-output", () => {
    const absent: Verdict = { status: "absent", reason: "input-changed", inputs: [] };
    const base = call({ verdict: absent, wouldFastForward: false, markerProjection: null });

    expect(compareCall({ ...base, previousProjection: digestOfGreen })).toMatchObject({ class: "miss-same-output", materialValid: false });
    expect(compareCall({ ...base, previousProjection: projectionDigest(ciWait, red) })?.class).toBe("miss");
  });
});
