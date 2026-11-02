import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { ConfigRef } from "./config-ref.js";
import type { FactoryConfig } from "./config.js";
import type { VisualThreshold } from "./shepherd/visual-delta-read.js";
import { successorAccounts, visualThresholdOf } from "./workflows-live.js";

const REVIEW = "/home/user/.claude-profiles/review";
const FIXER = "/home/user/.claude-profiles/fixer";
const SPARE = "/home/user/.claude-profiles/spare";

describe("successorAccounts", () => {
  it("gives a successor the review rotation when no fixer config directory is set", () => {
    const accounts = successorAccounts(undefined, { dirs: [REVIEW, SPARE] });

    expect(accounts?.()).toEqual([REVIEW, SPARE]);
  });

  it("puts the fixer config directory in the review account's place, ahead of the review fallbacks", () => {
    const accounts = successorAccounts(FIXER, { dirs: [REVIEW, SPARE, FIXER] });

    expect(accounts?.()).toEqual([FIXER, SPARE]);
  });

  it("reads the review rotation per call, so a fallback added to the live config reaches the next successor", () => {
    const review = { dirs: [REVIEW] };
    const accounts = successorAccounts(undefined, review);
    review.dirs = [REVIEW, SPARE];

    expect(accounts?.()).toEqual([REVIEW, SPARE]);
  });

  it("wires no rotation when no review is wired, so a successor keeps the fixer config directory", () => {
    expect(successorAccounts(FIXER, undefined)).toBeUndefined();
  });
});

describe("visualThresholdOf", () => {
  const rule = (mode: "off" | "shadow"): VisualThreshold => ({ mode, snapshotPaths: [], apiPaths: [], tokenPaths: [], harnessPaths: [] });

  it("matches a repo key in any case, and reads an edit to the live config on the next call", () => {
    let config: FactoryConfig = { shepherd: { visualThreshold: { "Octo/UI": rule("shadow") } } };
    const thresholdOf = visualThresholdOf(partialFake<ConfigRef>({ get: () => config }));

    const before = thresholdOf("octo/ui");
    config = { shepherd: { visualThreshold: { "octo/ui": rule("off") } } };

    expect([before?.mode, thresholdOf("OCTO/ui")?.mode, thresholdOf("octo/web")]).toEqual(["shadow", "off", undefined]);
  });
});
