import { describe, expect, it } from "vitest";
import { OTHER, png, RENDERED, tierOf } from "./pr-visual-read.test-helpers.js";

describe("the pr-visual pixel path (TP-4761 S4)", () => {
  it("artifact with zero changed pixels on every shot is tier 1 no-diff", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()], [png(), png(1)]] });

    expect(verdict).toEqual({ tier: 1, basis: "no-pixel-diff" });
  });

  it("one shot with changed pixels is tier 2", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()], [png(), png(120)]] });

    expect(verdict).toMatchObject({ tier: 2, reason: expect.stringMatching(/^no pixel proof: shots\.1\.changedPixels/) });
  });

  it("artifact at another head is tier 2", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()]], runHead: OTHER });

    expect(verdict).toEqual({ tier: 2, reason: "no pixel proof: no pr-visual artifact from this pull request's own run of the configured workflow at the head" });
  });

  it("rendered false while Shepherd sees a rendered path is tier 2", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()]], manifest: { rendered: false } });

    expect(verdict).toMatchObject({ tier: 2, reason: expect.stringContaining("rendered nothing") });
  });

  it("artifact over the byte cap is tier 2 unmeasured", async () => {
    const verdict = await tierOf({ pairs: [[png(), png()]] }, { zipBytes: 64 });

    expect(verdict).toEqual({ tier: 2, reason: "no pixel proof: artifact over the 64-byte cap" });
  });

  it("a shot naming one file for before and after is tier 2", async () => {
    const same = { story: "button--s0", width: "1280", before: "before/button--s0@1280.png", after: "before/button--s0@1280.png" };
    const verdict = await tierOf({ pairs: [[png(), png()]], manifest: { shots: [same] } });

    expect(verdict).toEqual({ tier: 2, reason: "no pixel proof: shot 0 names one file for before and after" });
  });
});

describe("the guard never downloads for a head whose code could make its own images (TP-4761 S4)", () => {
  const forged = { pairs: [[png(), png()]] as [Buffer, Buffer][] };

  it("a head with an install hook beside a rendered path is tier 2 with no artifact read", async () => {
    const calls: string[][] = [];
    const verdict = await tierOf(forged, { changedPaths: [".pnpmfile.cjs", RENDERED], calls });

    expect(verdict).toMatchObject({ tier: 2, reason: expect.stringMatching(/^producer-runnable: /) });
    expect(calls).toEqual([]);
  });
});
