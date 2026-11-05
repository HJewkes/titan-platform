import { describe, expect, it } from "vitest";
import { evidenceOf, OTHER, png, shotOf } from "./pr-visual-evidence.test-helpers.js";

describe("the pr-visual artifact read as evidence (TP-4761 C1)", () => {
  it("a zero-diff artifact reports zero changed pixels per shot", async () => {
    const evidence = await evidenceOf({ pairs: [[png(), png()], [png(), png(1)]] });

    expect(evidence).toEqual({
      measured: true,
      shots: [
        { story: "button--s0", width: "1280", changedPixels: 0 },
        { story: "button--s1", width: "1280", changedPixels: 0 },
      ],
      missing: [],
    });
  });

  it("a selected story without a pair is listed missing", async () => {
    const oneSided = { story: "button--s1", width: "390", before: "before/button--s1@1280.png" };
    const selected = ["button--s0", "button--s1", "card--plain"].map((story) => ({ story, paths: ["src/button/button.tsx"] }));
    const s0Narrow = { ...shotOf("button--s0", "1280"), width: "390" };
    const shots = [shotOf("button--s0", "1280"), s0Narrow, shotOf("button--s1", "1280"), oneSided];

    const evidence = await evidenceOf({ pairs: [[png(), png()], [png(), png()]], manifest: { shots, selected } });

    expect(evidence).toMatchObject({ measured: true, missing: ["button--s1", "card--plain"] });
  });

  it("an artifact at another head is unmeasured", async () => {
    const evidence = await evidenceOf({ pairs: [[png(), png()]], runHead: OTHER });

    expect(evidence).toEqual({ measured: false, reason: "no pr-visual artifact from the configured workflow at the head" });
  });

  it.each([
    ["over the byte cap", { pairs: [[png(), png()]] as [Buffer, Buffer][] }, { zipBytes: 64 }, "artifact over the 64-byte cap"],
    ["zip64", { pairs: [[png(), png()]] as [Buffer, Buffer][], zip64: true }, {}, "artifact zip: zip64 archives are not read"],
  ])("an over-cap or zip64 artifact is unmeasured: %s", async (_case, artifact, limits, reason) => {
    expect(await evidenceOf(artifact, limits)).toEqual({ measured: false, reason });
  });
});
