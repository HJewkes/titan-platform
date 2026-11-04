import type { MergeFacts } from "@titan-design/authority";
import { compileGlobs } from "@titan-design/fix-proof";
import { baselineCheckGreen, caseFoldedMatcher, shownPaths } from "./visual-gate.js";

export type VisualMerge = Pick<MergeFacts, "checkRuns" | "head">;

type VisualTierMode = "off" | "shadow" | "on";

export interface VisualTierConfig {
  mode: VisualTierMode;
  storyPaths: readonly string[];
  logicPaths: readonly string[];
  testArtifactPaths: readonly string[];
  renderingPaths: readonly string[];
  harnessPaths: readonly string[];
  /** The visual check and the baseline files a rendered change must touch. */
  storyDiff: { check: string; paths: readonly string[]; allowedApps: readonly number[] };
}

/** What the pr-visual artifact at the head showed; an absent read is a missing, expired or unreadable artifact. */
export interface PixelRead {
  head: string;
  baseSha: string;
  rendered: boolean;
  shots: readonly { paired: boolean; changedPixels: number }[];
}

type VisualTierBasis = "non-rendering" | "no-pixel-diff";
type VisualTierVerdict = { tier: 1; basis: VisualTierBasis } | { tier: 2; reason: string };

type PathClass = "harness" | "rendering" | "test" | "story" | "logic" | "rendered";

/** A bad list matches nothing for a class that clears a path, so a bad policy gates instead of allowing. */
function clearingMatcher(globs: readonly string[]): (path: string) => boolean {
  try {
    const matches = compileGlobs(globs.map((glob) => glob.toLowerCase()));
    return (path) => matches(path.toLowerCase());
  } catch {
    return () => false;
  }
}

const CODE_FILE = /\.(ts|js|mts|cts|mjs|cjs)$/;

/** Gating classes come first, so a token `.ts` is rendering though it is `.ts`. */
function classifyVisualPaths(paths: readonly string[], config: VisualTierConfig): Map<string, PathClass> {
  const is = {
    harness: caseFoldedMatcher(config.harnessPaths),
    rendering: caseFoldedMatcher(config.renderingPaths),
    test: clearingMatcher(config.testArtifactPaths),
    story: clearingMatcher([...config.storyPaths, "**/*.stories.*"]),
    logic: clearingMatcher(config.logicPaths),
  };
  const classOf = (path: string): PathClass => {
    if (config.harnessPaths.length > 0 && is.harness(path)) return "harness";
    if (config.renderingPaths.length > 0 && is.rendering(path)) return "rendering";
    if (is.test(path)) return "test";
    if (is.story(path)) return "story";
    return CODE_FILE.test(path.toLowerCase()) && is.logic(path) ? "logic" : "rendered";
  };
  return new Map(paths.map((path) => [path, classOf(path)]));
}

const tier2 = (reason: string): VisualTierVerdict => ({ tier: 2, reason });

function pixelVerdict(pixel: PixelRead | undefined, head: string, mergeBase: string | undefined): VisualTierVerdict {
  if (pixel === undefined) return tier2("no pr-visual artifact read at the head");
  if (pixel.head !== head) return tier2("pr-visual artifact is at another head");
  if (mergeBase === undefined || pixel.baseSha !== mergeBase) return tier2("pr-visual artifact base is not the merge base");
  if (!pixel.rendered) return tier2("pr-visual says nothing rendered but a rendered path changed");
  if (pixel.shots.length === 0) return tier2("pr-visual artifact holds no shots");
  if (pixel.shots.some((shot) => !shot.paired)) return tier2("pr-visual artifact has a shot with no pair");
  const changed = pixel.shots.filter((shot) => shot.changedPixels > 0).length;
  return changed > 0 ? tier2(`pr-visual shows changed pixels on ${changed} shot(s)`) : { tier: 1, basis: "no-pixel-diff" };
}

function logicVerdict(changedPaths: readonly string[], merge: VisualMerge, { storyDiff }: VisualTierConfig): VisualTierVerdict {
  const snapshots = changedPaths.filter(clearingMatcher(storyDiff.paths));
  if (snapshots.length > 0) return tier2(`logic with a story diff: ${shownPaths(snapshots)}`);
  if (!baselineCheckGreen(merge, storyDiff.check, storyDiff.allowedApps)) return tier2(`logic with ${storyDiff.check} not green at the head`);
  return { tier: 1, basis: "non-rendering" };
}

/** The verdict for the paths `visualMatches` flagged; `changedPaths` is every changed file, as the story diff may sit outside the visual globs. */
interface VisualTierInput {
  visual: readonly string[];
  changedPaths: readonly string[];
  merge: VisualMerge;
  config: VisualTierConfig;
  pixel?: PixelRead;
  mergeBase?: string;
}

export function visualTier(input: VisualTierInput): VisualTierVerdict {
  const { visual, changedPaths, merge, config, pixel, mergeBase } = input;
  const classes = classifyVisualPaths(visual, config);
  const of = (...wanted: PathClass[]) => visual.filter((path) => wanted.includes(classes.get(path) ?? "rendered"));
  const gating = of("harness", "rendering");
  if (gating.length > 0) return tier2(`renders: ${shownPaths(gating)}`);
  if (of("rendered").length > 0) return pixelVerdict(pixel, merge.head, mergeBase);
  return of("logic").length > 0 ? logicVerdict(changedPaths, merge, config) : { tier: 1, basis: "non-rendering" };
}
