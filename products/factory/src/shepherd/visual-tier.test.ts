import { describe, expect, it } from "vitest";
import { visualTier } from "./visual-tier.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const APP = 15368;

const config = {
  mode: "on",
  storyPaths: ["src/**/*.stories.tsx"],
  logicPaths: ["src/**"],
  testArtifactPaths: ["src/contrast-baseline.json"],
  renderingPaths: ["src/tokens/**", "**/*.css"],
  harnessPaths: ["scripts/capture/**", "visual-paths.mjs"],
  storyDiff: { check: "visual", paths: ["**/__snapshots__/**", "**/*.png"], allowedApps: [APP] },
};

const proof = { head: HEAD, baseSha: BASE, rendered: true, shots: [{ id: "button-default", paired: true, changedPixels: 0 }] };

function verdict(changedPaths: string[], opts: { check?: string | null; extra?: Record<string, unknown> } = {}) {
  const conclusion = opts.check === undefined ? "success" : opts.check;
  const merge = { head: HEAD, changedPaths, checkRuns: [{ name: "visual", appId: APP, headSha: HEAD, conclusion }] };
  const input = { merge, visualPaths: ["src/**"], mergeBase: BASE, config, ...opts.extra };
  return visualTier(input);
}

describe("visual tier verdict (TP-4761 S1)", () => {
  it("story and test only head is tier 1 non-rendering", () => {
    expect(verdict(["src/button/button.stories.tsx", "src/contrast-baseline.json"])).toEqual({ tier: 1, basis: "non-rendering" });
  });

  it("logic-only head with the visual check green and no snapshot changed is tier 1", () => {
    expect(verdict(["src/hooks/use-id.ts"])).toEqual({ tier: 1, basis: "non-rendering" });
    expect(verdict(["src/hooks/use-id.ts"], { check: "failure" })).toMatchObject({ tier: 2, reason: expect.stringContaining("not green") });
    expect(verdict(["src/hooks/use-id.ts"], { check: null })).toMatchObject({ tier: 2, reason: expect.stringContaining("not green") });
  });

  it("logic head that changes a snapshot is tier 2", () => {
    expect(verdict(["src/hooks/use-id.ts", "src/button/__snapshots__/button.png"])).toMatchObject({ tier: 2, reason: expect.stringMatching(/^snapshot: src\/button/) });
  });

  it("a token .ts under renderingPaths is tier 2 though it is .ts", () => {
    expect(verdict(["src/tokens/color.ts"])).toMatchObject({ tier: 2, reason: expect.stringMatching(/^rendering: src\/tokens\/color\.ts/) });
  });

  it("a changed capture script is tier 2 whatever the artifact says", () => {
    expect(verdict(["scripts/capture/shoot.mjs"], { extra: { pixel: proof } })).toMatchObject({ tier: 2, reason: expect.stringMatching(/^harness: /) });
  });

  it("a rendered path is tier 2 even with a zero-diff pixel read in hand", () => {
    expect(verdict(["src/button/button.tsx", "src/hooks/use-id.ts"], { extra: { pixel: proof } })).toEqual({ tier: 2, reason: "renders: src/button/button.tsx" });
  });
});
