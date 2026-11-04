import { describe, expect, it } from "vitest";
import { type PixelRead, type VisualMerge, type VisualTierConfig, visualTier } from "./visual-tier.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const APP = 15368;

const config: VisualTierConfig = {
  mode: "on",
  storyPaths: ["src/**/*.stories.tsx"],
  logicPaths: ["src/**"],
  testArtifactPaths: ["src/contrast-baseline.json"],
  renderingPaths: ["src/tokens/**", "**/*.css"],
  harnessPaths: ["scripts/capture/**", "visual-paths.mjs"],
  storyDiff: { check: "visual", paths: ["**/__snapshots__/**", "**/*.png"], allowedApps: [APP] },
};

function mergeWith(conclusion: string | null): VisualMerge {
  return { head: HEAD, checkRuns: [{ name: "visual", appId: APP, headSha: HEAD, conclusion }] };
}

const clean = (shots: PixelRead["shots"] = [{ paired: true, changedPixels: 0 }], over: Partial<PixelRead> = {}): PixelRead => ({ head: HEAD, baseSha: BASE, rendered: true, shots, ...over });

function verdict(visual: string[], opts: { changed?: string[]; check?: string | null; pixel?: PixelRead } = {}) {
  return visualTier({ visual, changedPaths: opts.changed ?? visual, merge: mergeWith(opts.check === undefined ? "success" : opts.check), config, pixel: opts.pixel, mergeBase: BASE });
}

describe("visual tier verdict (TP-4761 S1)", () => {
  it("story and test only head is tier 1 non-rendering", () => {
    expect(verdict(["src/button/button.stories.tsx", "src/contrast-baseline.json"])).toEqual({ tier: 1, basis: "non-rendering" });
  });

  it("logic-only head with the visual check green and no snapshot changed is tier 1", () => {
    expect(verdict(["src/hooks/use-id.ts"])).toEqual({ tier: 1, basis: "non-rendering" });
    expect(verdict(["src/hooks/use-id.ts"], { check: "failure" })).toMatchObject({ tier: 2 });
    expect(verdict(["src/hooks/use-id.ts"], { check: null })).toMatchObject({ tier: 2 });
  });

  it("logic head that changes a snapshot is tier 2", () => {
    const changed = ["src/hooks/use-id.ts", "src/button/__snapshots__/button.png"];

    expect(verdict(["src/hooks/use-id.ts"], { changed })).toMatchObject({ tier: 2, reason: expect.stringContaining("story diff") });
  });

  it("a token .ts under renderingPaths is tier 2 though it is .ts", () => {
    expect(verdict(["src/tokens/color.ts"])).toMatchObject({ tier: 2, reason: expect.stringMatching(/^renders: src\/tokens\/color\.ts/) });
  });

  it("a changed capture script is tier 2 whatever the artifact says", () => {
    expect(verdict(["scripts/capture/shoot.mjs"], { pixel: clean() })).toMatchObject({ tier: 2, reason: expect.stringContaining("renders:") });
  });

  it("a rendered path with no pixel read is tier 2 (missing artifact)", () => {
    expect(verdict(["src/button/button.tsx"])).toMatchObject({ tier: 2, reason: expect.stringContaining("no pr-visual artifact") });
  });

  it("a rendered path with zero changed pixels on every paired shot is tier 1", () => {
    expect(verdict(["src/button/button.tsx"], { pixel: clean() })).toEqual({ tier: 1, basis: "no-pixel-diff" });
  });

  it("a shot whose changed-pixel count is not exactly zero is tier 2", () => {
    const tier = (changedPixels: unknown) => verdict(["src/button/button.tsx"], { pixel: clean([{ paired: true, changedPixels: Number(changedPixels) }]) }).tier;
    const missing = clean([JSON.parse('{"paired":true}')]);

    expect([tier(Number.NaN), tier(-1), tier(0.5)]).toEqual([2, 2, 2]);
    expect(verdict(["src/button/button.tsx"], { pixel: missing }).tier).toBe(2);
    expect(verdict(["src/button/button.tsx"], { pixel: clean([JSON.parse('{"paired":true,"changedPixels":null}')]) }).tier).toBe(2);
  });

  it("a rendered path is tier 2 when the artifact is stale, unpaired, changed or unrendered", () => {
    const tier2 = (pixel: PixelRead) => verdict(["src/button/button.tsx"], { pixel }).tier;

    expect(tier2(clean(undefined, { head: BASE }))).toBe(2);
    expect(tier2(clean(undefined, { baseSha: HEAD }))).toBe(2);
    expect(tier2(clean(undefined, { rendered: false }))).toBe(2);
    expect(tier2(clean([]))).toBe(2);
    expect(tier2(clean([{ paired: false, changedPixels: 0 }]))).toBe(2);
    expect(tier2(clean([{ paired: true, changedPixels: 0 }, { paired: true, changedPixels: 3 }]))).toBe(2);
  });
});
