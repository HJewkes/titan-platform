import { describe, expect, it } from "vitest";
import { tierOutcome } from "./visual-tier-guard.js";
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

interface Case { paths: string[]; config?: unknown }

function verdict({ paths, config: tierConfig = config }: Case) {
  const merge = { head: HEAD, changedPaths: paths, checkRuns: [{ name: "visual", appId: APP, headSha: HEAD, conclusion: "success" }] };
  return visualTier({ merge, visualPaths: ["src/**"], mergeBase: BASE, config: tierConfig });
}

/** 2^9 alternatives: within the schema's length cap, past compileGlobs' 256-expansion cap. */
const UNCOMPILABLE = "src/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}/**";

describe("visual tier fails closed (TP-4761 S1)", () => {
  it("a stored tier record with basis no-pixel-diff gates as tier 2", () => {
    const record = (basis: string) => ({ mode: "on", judged: [RENDERED], verdict: { tier: 1, basis } });

    expect(tierOutcome(record("non-rendering"), [RENDERED])).toMatchObject({ clears: true });
    expect(tierOutcome(record("no-pixel-diff"), [RENDERED])).toEqual({ clears: false, note: "; tier 2: the recorded visual tier is malformed" });
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

  it("every path no clearing row recognises is rendered, so it is tier 2", () => {
    const odd = ["src/x.stories.d/button.tsx", "SRC/Button.TSX", "src/a.ts.orig", "src/ü.vue", `src/${"a".repeat(4096)}`];

    for (const path of odd) expect(verdict({ paths: [path] })).toMatchObject({ tier: 2, reason: expect.stringMatching(/^renders: /) });
    expect(verdict({ paths: [""] })).toMatchObject({ tier: 2, reason: expect.stringContaining("input unreadable") });
    expect(verdict({ paths: [] })).toMatchObject({ tier: 2, reason: expect.stringContaining("input unreadable") });
  });
});
