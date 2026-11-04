import { describe, expect, it } from "vitest";
import { visualTier } from "./visual-tier.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const APP = 15368;
const RENDERED = "src/button/button.tsx";
const STORY = "src/button/button.stories.tsx";
const LOGIC = "src/hooks/use-id.ts";

const config = {
  mode: "on",
  storyPaths: ["src/**/*.stories.tsx"],
  logicPaths: ["src/**"],
  testArtifactPaths: ["src/contrast-baseline.json"],
  renderingPaths: ["src/tokens/**"],
  harnessPaths: ["scripts/capture/**", "playwright.config.ts"],
  storyDiff: { check: "visual", paths: ["**/__snapshots__/**", "**/__snapshots__.spec/**"], allowedApps: [APP] },
};

const shot = { id: "button-default", paired: true, changedPixels: 0 };
const proof = { head: HEAD, baseSha: BASE, rendered: true, shots: [shot] };

interface Case { paths: string[]; pixel?: unknown; config?: unknown; mergeBase?: string }

function verdict({ paths, pixel, config: tierConfig = config, mergeBase = BASE }: Case) {
  const merge = { head: HEAD, changedPaths: paths, checkRuns: [{ name: "visual", appId: APP, headSha: HEAD, conclusion: "success" }] };
  return visualTier({ merge, visualPaths: ["src/**"], mergeBase, config: tierConfig, pixel });
}

/** 2^9 alternatives: within the schema's length cap, past compileGlobs' 256-expansion cap. */
const UNCOMPILABLE = "src/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}/**";

describe("visual tier fails closed (TP-4761 S1)", () => {
  it("a pixel proof holding anything but exact zero, true flags and the merge shas is tier 2", () => {
    const withShot = (over: Record<string, unknown>) => ({ ...proof, shots: [{ ...shot, ...over }] });
    const { changedPixels: _dropped, ...noCount } = shot;
    const bad = [
      ...[-1, 0.5, null, "0", 1, Number.NaN].map((changedPixels) => withShot({ changedPixels })),
      { ...proof, shots: [noCount] },
      withShot({ paired: 1 }),
      { ...proof, rendered: "true" },
      { ...proof, head: "c".repeat(40) },
      { ...proof, shots: [] },
    ];

    expect(verdict({ paths: [RENDERED], pixel: proof })).toEqual({ tier: 1, basis: "no-pixel-diff" });
    expect(bad.map((pixel) => verdict({ paths: [RENDERED], pixel }).tier)).toEqual(bad.map(() => 2));
    expect(verdict({ paths: [RENDERED], pixel: { ...proof, baseSha: "" }, mergeBase: "" }).tier).toBe(2);
  });

  it("a shot with an unknown key such as sizesDiffer is tier 2", () => {
    const pixel = { ...proof, shots: [{ ...shot, sizesDiffer: true }] };

    expect(verdict({ paths: [RENDERED], pixel })).toMatchObject({ tier: 2, reason: expect.stringContaining("no pixel proof") });
  });

  it("a tier policy with an uncompilable, empty or blank list is tier 2 for every head", () => {
    const head = [STORY, LOGIC];
    const bad = [
      { ...config, storyDiff: { ...config.storyDiff, paths: ["**/__snapshots__/**", UNCOMPILABLE] } },
      { ...config, logicPaths: ["src/**", UNCOMPILABLE] },
      { ...config, testArtifactPaths: [] },
      { ...config, storyPaths: [""] },
      { ...config, extra: true },
    ];

    expect(verdict({ paths: head })).toEqual({ tier: 1, basis: "non-rendering" });
    for (const tierConfig of bad) expect(verdict({ paths: head, config: tierConfig })).toMatchObject({ tier: 2, reason: expect.stringContaining("policy unreadable") });
  });

  it("a gating path outside the visual globs or with a test-like name makes a story-only head tier 2", () => {
    const gating = ["playwright.config.ts", "scripts/capture/shoot.test.mjs", "src/button/__snapshots__.spec/button.png", "src/button/__snapshots__/button.spec.png"];

    expect(verdict({ paths: [STORY] })).toEqual({ tier: 1, basis: "non-rendering" });
    for (const path of gating) expect(verdict({ paths: [STORY, path] })).toMatchObject({ tier: 2, reason: expect.stringMatching(/^(harness|snapshot): /) });
  });

  it("every path no clearing row recognises is rendered, so tier 1 needs a pixel proof", () => {
    const odd = ["src/x.stories.d/button.tsx", "SRC/Button.TSX", "src/a.ts.orig", "src/ü.vue", `src/${"a".repeat(4096)}`];

    for (const path of odd) {
      expect(verdict({ paths: [path] })).toMatchObject({ tier: 2, reason: expect.stringContaining("no pixel proof") });
      expect(verdict({ paths: [path], pixel: proof })).toEqual({ tier: 1, basis: "no-pixel-diff" });
    }
    expect(verdict({ paths: [""] })).toMatchObject({ tier: 2, reason: expect.stringContaining("input unreadable") });
    expect(verdict({ paths: [] })).toMatchObject({ tier: 2, reason: expect.stringContaining("input unreadable") });
  });
});
