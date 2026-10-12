import { DIRTY_SUFFIX, UNKNOWN_BUILD_SHA } from "./build-info.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";

/** Whether the running build holds a target: yes, no, or why git could not tell. */
type Holds = boolean | { unknown: string };

/** Answers `git merge-base --is-ancestor ancestor descendant` in the deploy checkout. */
export type AncestryProbe = (ancestor: string, descendant: string) => Promise<Holds>;

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

/** Exit 1 is git's "not an ancestor"; any other failure, such as a missing object (128), is no answer. */
export function gitAncestry(checkout: string, run: Run = runCommand): AncestryProbe {
  return async (ancestor, descendant) => {
    const result = await run("git", ["-C", checkout, "merge-base", "--is-ancestor", ancestor, descendant]);
    if (result === undefined) return { unknown: "git is not on PATH" };
    if (result.code === 0 || result.code === 1) return result.code === 0;
    return { unknown: `git merge-base exited ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}` };
  };
}

/** Commits never change, so a definite answer holds for good; a failure is retried, since a fetch may bring the object. */
export function cachedAncestry(probe: AncestryProbe): AncestryProbe {
  const answers = new Map<string, boolean>();
  return async (ancestor, descendant) => {
    const key = `${ancestor} ${descendant}`;
    const known = answers.get(key);
    if (known !== undefined) return known;
    const answer = await probe(ancestor, descendant);
    if (typeof answer === "boolean") answers.set(key, answer);
    return answer;
  };
}

/** A dirty build still contains its base commit; an unknown build contains nothing anyone can prove. */
export async function runningHolds(probe: AncestryProbe, runningSha: string, target: string): Promise<Holds> {
  if (runningSha === target) return true;
  if (runningSha === UNKNOWN_BUILD_SHA) return false;
  const base = runningSha.endsWith(DIRTY_SUFFIX) ? runningSha.slice(0, -DIRTY_SUFFIX.length) : runningSha;
  return base === target || probe(target, base);
}
