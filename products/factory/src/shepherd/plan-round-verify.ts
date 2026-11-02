// The drift check of the plan round (TP-4360): before review, a head is held to the plan the owner approved, so a PR
// that strays is re-asked at plan time instead of gating at merge.
import type { CiPolicyScope } from "./plan-approval.js";
import { planUnit, predictGates, type GitRead, type PlanBlock } from "./plan-round.js";

interface VerifyTarget {
  /** The plan as the caller named it, echoed into the re-ask line. */
  source: string;
  ref: string;
  base: string;
}

/** `git diff --name-status -M -z`: a rename or copy entry carries two paths, and the guard reads both as changed. */
export function parseNameStatus(output: string): string[] {
  const tokens = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length && tokens[i] !== ""; ) {
    const width = /^[RC]/.test(tokens[i]!) ? 2 : 1;
    paths.push(...tokens.slice(i + 1, i + 1 + width));
    i += 1 + width;
  }
  return paths;
}

const short = (blob: string): string => blob.slice(0, 12);

async function pinDrift({ path, blob }: CiPolicyScope["files"][number], git: GitRead, head: string, ref: string): Promise<string | undefined> {
  const actual = await git.blob(head, path);
  if (actual === blob) return undefined;
  if (blob === null) return `${path} is pinned absent but is ${short(actual!)} at ${ref}`;
  return `${path} is pinned at ${short(blob)} but is ${actual === null ? "absent" : short(actual)} at ${ref}`;
}

/**
 * Each way the head at `ref` would fall outside the plan's approvals, one line per problem, each ending in the re-ask.
 * Only a ci-policy plan pins content; skill and visual approvals name paths, so their content may still change.
 */
export async function verifyPlan(plan: PlanBlock, target: VerifyTarget, git: GitRead): Promise<string[]> {
  const head = await git.commit(target.ref);
  const planned = new Set(plan.files.map((file) => file.path));
  const changed = [...new Set(await git.diffNames(target.base, head))];
  const unplanned = changed.filter((path) => !planned.has(path)).map((path) => `unplanned path ${path}: ${target.ref} changes it and the plan does not list it`);
  const pinned = predictGates(plan, undefined).ciPolicy?.files ?? [];
  const drifted = (await Promise.all(pinned.map((file) => pinDrift(file, git, head, target.ref)))).filter((line) => line !== undefined);
  return [...unplanned, ...drifted].map((problem) => `${problem}; re-ask: ${reAskLine(plan, target.source, head)}`);
}

/** `--pin-from` refuses inline bytes, since the head's bytes are the new answer, so the line says to drop them first. */
function reAskLine(plan: PlanBlock, source: string, head: string): string {
  const inline = plan.files.some((file) => file.content !== undefined || file.absent !== undefined);
  const command = `titan-factory shepherd plan-round ${source} --pin-from ${head} --round <n+1> --supersedes ${planUnit(plan.task)}-r<n>`;
  return inline ? `drop the block's inline content and absent fields, then ${command}` : command;
}
