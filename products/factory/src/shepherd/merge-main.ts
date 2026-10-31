import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { MergeBaseFirst } from "../workflows/land-merge-base.js";
import { judgeMain, readMainRules } from "./main-verdict.js";
import type { ShepherdDeps } from "./phases.js";

const MERGE_MAIN_STEP = "sh-merge-main";
export const MERGE_MAIN_STEPS: readonly StepDeclaration[] = [{ id: MERGE_MAIN_STEP, kind: "dispatch" }];

/**
 * Files CI's guards read from the merge base or the PR's tree; a green run on an older copy proved nothing against main's.
 * Shepherd's own list, never read from the PR.
 */
const GUARD_FILES: ReadonlySet<string> = new Set([
  "scripts/stage-version-guard.mjs",
  "scripts/index-version-guard.mjs",
  "scripts/dead-code-check.mjs",
  ".github/fix-proof.json",
  ".codewatch/dead-exports.json",
  ".codewatch/dead-exports-adopted.json",
]);

const NON_GREEN_RUN = "no-non-green-run";

const MergeMainInput = z.object({ repo: z.string(), headSha: z.string(), base: z.string(), reason: z.string().optional() });
type MergeMainInput = z.infer<typeof MergeMainInput>;

const MergeMainResult = z.looseObject({
  merge: z.boolean(),
  trigger: z.enum(["guard-files", NON_GREEN_RUN]).optional(),
  /** The base tip the merge brings in. */
  tip: z.string().optional(),
  guardFiles: z.array(z.string()).optional(),
});
type MergeMainResult = z.infer<typeof MergeMainResult>;

const NO_MERGE: MergeMainResult = { merge: false };

/** Some MRG-AU row's only unmet condition is no-non-green-run, so a head with main's fix in it is all that row lacks. */
function onlyNonGreenRunUnmet(reason: string): boolean {
  const rows = [...reason.matchAll(/MRG-AU-[A-Z]+ unmet: ([^;]+)/g)].map((match) => (match[1] ?? "").split(",").map((c) => c.trim()));
  return rows.some((row) => row.length === 1 && row[0] === NON_GREEN_RUN);
}

/** Main's own judgement of the tip: every check that judges main ran and passed. */
async function greenTip(port: GitHubPort, repo: RepoSlug, base: string, tip: string): Promise<boolean> {
  const { rules } = await readMainRules(port, repo, base);
  const judged = judgeMain(tip, await port.checkRuns(repo, tip), rules);
  return judged.counted > 0 && judged.findings.length === 0;
}

async function triggerAt(port: GitHubPort, input: MergeMainInput, tip: string, mainFiles: readonly string[]): Promise<MergeMainResult> {
  if (input.reason === undefined) {
    const guardFiles = mainFiles.filter((path) => GUARD_FILES.has(path));
    return guardFiles.length > 0 ? { merge: true, trigger: "guard-files", tip, guardFiles } : NO_MERGE;
  }
  if (!onlyNonGreenRunUnmet(input.reason) || !(await greenTip(port, input.repo, input.base, tip))) return NO_MERGE;
  return { merge: true, trigger: NON_GREEN_RUN, tip };
}

/** A head already on the base tip, or any failed read, merges nothing and leaves the run as it was. */
async function readMergeMain(port: GitHubPort, input: MergeMainInput): Promise<MergeMainResult> {
  try {
    const tip = await port.getHeadSha(input.repo, input.base);
    if (tip === null || tip === input.headSha) return NO_MERGE;
    const compared = await port.compareFiles(input.repo, input.headSha, tip);
    if (compared.mergeBaseSha === tip) return NO_MERGE;
    return await triggerAt(port, input, tip, compared.files);
  } catch {
    return NO_MERGE;
  }
}

export function mergeMainRoute(deps: Pick<ShepherdDeps, "port" | "now">): StepRoute {
  return codeRoute(MERGE_MAIN_STEP, deps.now, (input: MergeMainInput) => readMergeMain(deps.port, input));
}

/**
 * TP-4691: land's `mergeBaseFirst` for one run. Before a green head's decision it asks whether main changed a guard file
 * since the PR's merge base; at a gate, whether MRG-AU lacks only a green run that main's newer green tip would bring. Either
 * way Shepherd merges main itself instead of waking a worker to push that merge. A record from before this step skips it.
 */
export function mergeMainFirst(repo: RepoSlug): MergeBaseFirst {
  let reads = 0;
  return async (ctx, at) => {
    const next = ctx.historyNext();
    if (next !== undefined && !stepIdMatches(MERGE_MAIN_STEP, next)) return false;
    const input: MergeMainInput = { repo, headSha: at.headSha, base: at.base, ...(at.reason !== undefined && { reason: at.reason }) };
    return (await step(ctx, `${MERGE_MAIN_STEP}:${reads++}`, input, MergeMainResult)).merge;
  };
}
