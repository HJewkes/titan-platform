import type { MergeFacts } from "@titan-design/authority";
import { compileGlobs } from "@titan-design/fix-proof";
import { oneLine } from "../gate-brief.js";

/** A check that diffs rendered output against committed baselines: a rendered change must change a file under `paths`. */
export interface VisualBaselines {
  check: string;
  paths: string[];
}

export interface VisualPolicy {
  visualPaths: readonly string[] | undefined;
  visualBaselines: VisualBaselines | undefined;
}

const SHOWN_VISUAL_PATHS = 10;
const MAX_SHOWN_PATH = 200;

/** Each path is flattened, as a PR author names it and a gate reason lands on one line of the owner's prompt. */
export function shownPaths(paths: readonly string[]): string {
  return paths.slice(0, SHOWN_VISUAL_PATHS).map((path) => oneLine(path, MAX_SHOWN_PATH)).join(", ") + (paths.length > SHOWN_VISUAL_PATHS ? ` and ${paths.length - SHOWN_VISUAL_PATHS} more` : "");
}

/** Tests, markdown and type declarations under a visual glob change no rendered output (decision 303, Q2). */
const NON_RENDERING = /(\.(test|spec)\.[^/]*|\.md|\.d\.ts)$/;

function cannotRender(path: string): boolean {
  const name = path.toLowerCase().split("/").pop() ?? "";
  return NON_RENDERING.test(name);
}

/**
 * Case is folded on both sides, as a case-insensitive checkout writes `Packages/UI/x` into `packages/ui/`. A glob list
 * that cannot compile matches every path, so a bad policy gates instead of throwing or allowing.
 */
export function visualMatches(paths: readonly string[], visualPaths: readonly string[]): string[] {
  const isVisual = caseFoldedMatcher(visualPaths);
  return paths.filter((path) => !cannotRender(path) && isVisual(path));
}

function caseFoldedMatcher(globs: readonly string[]): (path: string) => boolean {
  try {
    const matches = compileGlobs(globs.map((glob) => glob.toLowerCase()));
    return (path) => matches(path.toLowerCase());
  } catch {
    return () => true;
  }
}

/**
 * The changed baseline files, every status counted, as a removed or added baseline is a rendered change too; no
 * `cannotRender` filter, as a snapshot directory may be named `.spec.`. A list of only blank globs, or a blank check name,
 * can show no rendered diff, so it reads undefined and the glob gate stays.
 */
export function changedBaselines(paths: readonly string[], baselines: VisualBaselines): string[] | undefined {
  const globs = baselines.paths.filter((path) => path.trim() !== "");
  if (globs.length === 0 || baselines.check.trim() === "") return undefined;
  return paths.filter(caseFoldedMatcher(globs));
}

/** Every run of the check from an allowed app at the head concluded `success`, and there is at least one; pending reads null. */
export function baselineCheckGreen(merge: MergeFacts, check: string, allowedApps: readonly number[]): boolean {
  const runs = merge.checkRuns.filter((run) => run.name === check && allowedApps.includes(run.appId) && run.headSha === merge.head);
  return runs.length > 0 && runs.every((run) => run.conclusion === "success");
}

/** The note an allow carries when visual files were cleared by the baseline check, so the evidence comment records why. */
export function visualClearance(changedPaths: readonly string[], head: string, { visualPaths, visualBaselines }: VisualPolicy): string {
  if (visualPaths === undefined || visualBaselines === undefined) return "";
  const visual = visualMatches(changedPaths, visualPaths);
  if (visual.length === 0) return "";
  return `; visual files ${shownPaths(visual)} changed no baseline and ${oneLine(visualBaselines.check, MAX_SHOWN_PATH)} passed at ${head}`;
}
