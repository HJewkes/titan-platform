import type { MergeFacts } from "@titan-design/authority";
import { compileGlobs } from "@titan-design/fix-proof";
import { oneLine } from "../gate-brief.js";
import type { VisualDemotion } from "./auto-pass.js";

/** A check that diffs rendered output against committed baselines: a rendered change must change a file under `paths`. */
export interface VisualBaselines {
  check: string;
  paths: string[];
}

export interface VisualPolicy {
  visualPaths: readonly string[] | undefined;
  visualBaselines: VisualBaselines | undefined;
  /** The D2 guard a gated visual head may pass on; null keeps every visual gate for the owner. */
  visualDemotion?: VisualDemotion | null;
}

/** What `decideAutoMerge` reads about visual files; the D2 guard has no default, so every caller passes the seat-built one. */
export interface AutoMergeVisual {
  visualPaths?: readonly string[];
  visualBaselines?: VisualBaselines;
  /** `seatVisualDemotion` for the repo at decision time; null keeps every visual gate for the owner. */
  visualDemotion: VisualDemotion | null;
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

type DemotionRead = { holds: true; evidence: string[] } | { holds: false; why: string };

const SHARD = /^(.*) (\d+)\/(\d+)$/;

/** Every allowed-app run of `name` at the head; pending reads as not green. */
function runsAt(merge: MergeFacts, allowedApps: readonly number[], name: (run: string) => boolean): MergeFacts["checkRuns"] {
  return merge.checkRuns.filter((run) => name(run.name) && allowedApps.includes(run.appId) && run.headSha === merge.head);
}

/** Shards `<name> i/n` share one n, and every i in 1..n has a run, each green; none at all is not green. */
function shardsGreen(merge: MergeFacts, check: string, allowedApps: readonly number[]): string | undefined {
  const runs = runsAt(merge, allowedApps, (name) => SHARD.exec(name)?.[1] === check);
  const totals = new Set(runs.map((run) => SHARD.exec(run.name)![3]));
  if (runs.length === 0 || totals.size !== 1) return undefined;
  const total = Number([...totals][0]);
  const names = Array.from({ length: total }, (_, i) => `${check} ${i + 1}/${total}`);
  const green = names.every((shard) => runs.some((run) => run.name === shard) && runs.filter((run) => run.name === shard).every((run) => run.conclusion === "success"));
  return green ? names.join(", ") : undefined;
}

function demotionChecks(merge: MergeFacts, demotion: VisualDemotion, allowedApps: readonly number[]): { green: string[] } | { why: string } {
  const green: string[] = [];
  for (const check of demotion.checks) {
    if (!baselineCheckGreen(merge, check, allowedApps)) return { why: `${check} is not green at ${merge.head}` };
    green.push(check);
  }
  for (const check of demotion.shardedChecks) {
    const shards = shardsGreen(merge, check, allowedApps);
    if (shards === undefined) return { why: `not every ${check} shard is green at ${merge.head}` };
    green.push(shards);
  }
  return { green };
}

/**
 * D2 (TP-3697): a gated visual head passes without the owner only when it changes no baseline or token path, every
 * demotion check is green at the head, and the MERGE it stands on was written at this very head, not carried to it.
 */
export function visualDemotionAt(merge: MergeFacts, demotion: VisualDemotion, allowedApps: readonly number[]): DemotionRead {
  const owned = merge.changedPaths.filter(caseFoldedMatcher(demotion.ownerPaths));
  if (owned.length > 0) return { holds: false, why: `it changes baseline or token files ${shownPaths(owned)}` };
  const checks = demotionChecks(merge, demotion, allowedApps);
  if ("why" in checks) return { holds: false, why: checks.why };
  if (merge.verdict.value !== "MERGE" || merge.verdict.head !== merge.head || merge.carry !== undefined) return { holds: false, why: `no MERGE was written at ${merge.head}` };
  const by = `${merge.resolver.agentId}/${merge.resolver.sessionId}`;
  return { holds: true, evidence: [`head ${merge.head}`, `no baseline or token file changed`, `green at the head: ${checks.green.join(", ")}`, `MERGE at ${merge.head} by ${by}`] };
}
