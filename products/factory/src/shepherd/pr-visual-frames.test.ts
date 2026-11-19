import { describe, expect, it } from "vitest";
import { prVisualFrames } from "./pr-visual-frames.js";
import { fakeGh, HEAD, OTHER, png } from "./pr-visual-evidence.test-helpers.js";

const REPO = "octo/design";

describe("the frames a head's pr-visual artifact rendered (TP-6776)", () => {
  it("counts each shot with a head render", async () => {
    const gh = fakeGh({ pairs: [[png(), png(1)], [png(), png()]] });

    expect(await prVisualFrames(gh)(REPO, HEAD)).toBe(2);
  });

  it("a manifest that says it rendered nothing has zero frames, whatever shots it lists", async () => {
    const gh = fakeGh({ pairs: [[png(), png(1)]], manifest: { rendered: false, reason: "broad" } });

    expect(await prVisualFrames(gh)(REPO, HEAD)).toBe(0);
  });

  it("a manifest captured for another head is no count, only a reason", async () => {
    const gh = fakeGh({ pairs: [[png(), png(1)]], manifest: { headSha: OTHER } });

    expect(await prVisualFrames(gh)(REPO, HEAD)).toBe("the artifact was captured for another head");
  });

  it("a failed read is its reason, never a throw", async () => {
    const gh = { text: async () => Promise.reject(new Error("synthetic outage")), bytes: async () => new Uint8Array() };

    expect(await prVisualFrames(gh)(REPO, HEAD)).toMatch(/^the frame read failed: /);
  });
});
