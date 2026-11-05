import { describe, expect, it } from "vitest";
import { visualTier } from "./visual-tier.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RENDERED = "src/button/button.tsx";
const WORKFLOW = ".github/workflows/pr-visual.yml";

const config = {
  mode: "on",
  storyPaths: ["src/**/*.stories.tsx"],
  logicPaths: ["src/hooks/**"],
  testArtifactPaths: ["src/contrast-baseline.json"],
  renderingPaths: ["src/tokens/**"],
  harnessPaths: ["scripts/capture/**"],
  storyDiff: { check: "visual", paths: ["**/__snapshots__/**"], allowedApps: [15368] },
  prVisual: { workflow: WORKFLOW, browserPaths: ["src/button/**", "**/.github/**", ".github/workflows/*"] },
};

const proof = { head: HEAD, baseSha: BASE, rendered: true, shots: [{ id: "button-default", paired: true, changedPixels: 0 }] };

function verdict(changedPaths: string[], tierConfig: unknown = config) {
  const merge = { head: HEAD, changedPaths, checkRuns: [] };
  return visualTier({ merge, visualPaths: ["src/**", "**/.github/**", ".storybook/**"], mergeBase: BASE, config: tierConfig, pixel: proof });
}

describe("the pixel proof refuses a head whose code could make its own images (TP-4761 S4)", () => {
  it.each([
    ["a Storybook config the build runs in Node", [".storybook/main.ts"]],
    ["an install hook outside the visual globs", [".pnpmfile.cjs", RENDERED]],
    ["a package manifest that can add a postinstall", ["src/package.json", RENDERED]],
    ["the producer workflow, though an allow-list glob matches it", [WORKFLOW, RENDERED]],
    ["a nested .github path, though an allow-list glob matches it", ["src/.github/actions/x.yml", RENDERED]],
  ])("%s is tier 2 producer-runnable", (_, changedPaths) => {
    expect(verdict(changedPaths)).toMatchObject({ tier: 2, reason: expect.stringMatching(/^producer-runnable: /) });
  });

  it("an allow-listed rendered path alone keeps its pixel proof", () => {
    expect(verdict([RENDERED])).toEqual({ tier: 1, basis: "no-pixel-diff" });
  });

  it("a pixel proof counts for nothing when the policy names no prVisual allow-list", () => {
    const bare: Record<string, unknown> = { ...config };
    delete bare["prVisual"];

    expect(verdict([RENDERED], bare)).toMatchObject({ tier: 2, reason: expect.stringContaining("no prVisual policy") });
  });
});
