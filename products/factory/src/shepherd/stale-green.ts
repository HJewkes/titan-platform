import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { RecheckMovedBase } from "../workflows/land-merge-base.js";
import type { ShepherdDeps } from "./phases.js";
import { pathUnit } from "./train-shadow-disjoint.js";

const STALE_GREEN_STEP = "sh-stale-green";
export const STALE_GREEN_STEPS: readonly StepDeclaration[] = [{ id: STALE_GREEN_STEP, kind: "dispatch" }];

/** Root files every unit builds under, so a change to one can break a head no matter which units it touches. */
const BUILD_CONFIG = /^(?:tsconfig[^/]*\.json|eslint\.config\.[^/]+|vitest\.config\.[^/]+|pnpm-workspace\.yaml)$/;

const StaleGreenInput = z.object({ repo: z.string(), pr: z.number(), headSha: z.string(), base: z.string() });
type StaleGreenInput = z.infer<typeof StaleGreenInput>;

const StaleGreenResult = z.looseObject({
  recheck: z.boolean(),
  /** What main's delta shares with the PR: units both changed, and build config main changed. */
  shared: z.array(z.string()).optional(),
  /** Why the delta could not be judged; an unjudged delta is re-checked. */
  unread: z.string().optional(),
});
type StaleGreenResult = z.infer<typeof StaleGreenResult>;

/** Markdown builds nothing, and Version Packages rewrites a CHANGELOG in almost every unit. */
function buildUnit(path: string): string | null {
  return path.endsWith(".md") ? null : pathUnit(path);
}

/** Pure: the units both sides changed, and any build config main changed. Empty means the pair may land back to back. */
export function sharedWithMain(prFiles: readonly string[], delta: readonly string[]): string[] {
  const units = new Set(prFiles.map(buildUnit));
  const shared = delta.filter((path) => BUILD_CONFIG.test(path)).concat(delta.map(buildUnit).filter((unit) => unit !== null && units.has(unit)) as string[]);
  return [...new Set(shared)];
}

/** Main's delta runs from the head's fork point, so it may name commits the green already saw: that costs a run, never a stale land. */
async function readStaleGreen(port: GitHubPort, input: StaleGreenInput): Promise<StaleGreenResult> {
  try {
    const delta = await port.compareFiles(input.repo, input.headSha, input.base);
    if (delta.truncated) return { recheck: true, unread: "main's delta is past the compare cap" };
    const files = await port.listPrFiles(input.repo, input.pr);
    const shared = sharedWithMain(files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]), delta.files);
    return { recheck: shared.length > 0, shared };
  } catch (error) {
    return { recheck: true, unread: error instanceof Error ? error.message : String(error) };
  }
}

export function staleGreenRoute(deps: Pick<ShepherdDeps, "port" | "now">): StepRoute {
  return codeRoute(STALE_GREEN_STEP, deps.now, (input: StaleGreenInput) => readStaleGreen(deps.port, input));
}

/**
 * TP-4711: land's `recheckMovedBase` for one run. Green heads land back to back only when main's delta shares no unit with
 * the PR; otherwise land merges main in and the required checks run on that merge, as tp#3130 and tp#3131 needed. A record
 * from before this step skips it and lands as it did.
 */
export function staleGreenCheck(repo: RepoSlug, pr: number): RecheckMovedBase {
  let reads = 0;
  return async (ctx, at) => {
    const next = ctx.historyNext();
    if (next !== undefined && !stepIdMatches(STALE_GREEN_STEP, next)) return false;
    const input: StaleGreenInput = { repo, pr, headSha: at.headSha, base: at.base };
    return (await step(ctx, `${STALE_GREEN_STEP}:${reads++}`, input, StaleGreenResult)).recheck;
  };
}
