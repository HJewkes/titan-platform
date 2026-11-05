import { describe, expect, it } from "vitest";
import { png, PR, tierOf } from "./pr-visual-read.test-helpers.js";

const zeroDiff = { pairs: [[png(), png()]] as [Buffer, Buffer][] };
const otherPr = { number: PR + 1, base: { ref: "main" } };

describe("the pixel proof is read only from this pull request's own run (TP-4761 S4)", () => {
  it("its own pull_request run of the configured workflow at its base is measured", async () => {
    expect(await tierOf(zeroDiff)).toEqual({ tier: 1, basis: "no-pixel-diff" });
  });

  it.each([
    ["a run of another workflow path", { path: ".github/workflows/other.yml" }],
    ["a run of another event", { event: "workflow_dispatch" }],
    ["a run for another pull request at the same head", { pull_requests: [otherPr] }],
    ["a run against another base, whose workflow that base wrote", { pull_requests: [{ number: PR, base: { ref: "evil" } }] }],
    ["a run listing another pull request beside this one", { pull_requests: [{ number: PR, base: { ref: "main" } }, otherPr] }],
  ])("%s is tier 2", async (_, run) => {
    expect(await tierOf({ ...zeroDiff, run })).toMatchObject({ tier: 2, reason: expect.stringContaining("no pr-visual artifact from this pull request's own run") });
  });
});
