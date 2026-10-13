import { HEAD } from "./await-verdict.js";
import { CarryRefusal, type Git, isAncestor, must } from "./tree-carry.js";

/**
 * A stacked child whose parent squash-landed. `parentFinal` is the parent head that was
 * squashed, `squash` the commit it became on the default branch, `main` that branch's tip.
 */
interface RestackInput {
  childHead: string;
  parentFinal: string;
  squash: string;
  main: string;
  parentPr?: number;
}

/** `base` is the child's fork point on its parent, the explicit merge base the tree was built from. */
type RestackResult =
  | { kind: "restacked"; commit: string; tree: string; base: string }
  | { kind: "conflict"; base: string; files: string[] }
  | { kind: "guard"; reason: string };

const SHA_FIELDS = ["childHead", "parentFinal", "squash", "main"] as const;

const treeOf = (git: Git, gitDir: string, commit: string, signal?: AbortSignal): Promise<string> => must(git, gitDir, ["rev-parse", `${commit}^{tree}`], signal);

/** Why the squash cannot stand in for the parent's final head, or undefined when it can. */
async function guardMiss(git: Git, gitDir: string, input: RestackInput, signal?: AbortSignal): Promise<string | undefined> {
  const malformed = SHA_FIELDS.find((field) => !HEAD.test(input[field]));
  if (malformed) return `${malformed} is not a full commit sha`;
  const squashTree = await treeOf(git, gitDir, input.squash, signal);
  if (squashTree !== (await treeOf(git, gitDir, input.parentFinal, signal)))return `tree of squash ${input.squash} differs from parent final ${input.parentFinal}`;
  if (!(await isAncestor(git, gitDir, input.squash, input.main, signal))) return `squash ${input.squash} is not on main ${input.main}`;
  return undefined;
}

const restackMessage = (input: RestackInput, base: string): string => `Restack onto main${input.parentPr === undefined ? "" : ` after #${input.parentPr}`} (merge-base ${base})`;

/**
 * Builds the merge-onto commit for a child whose parent squash-landed: the tree is the child
 * merged onto main from its fork point, so the parent's commits it carries are not replayed
 * against their squash. Writes objects only; no ref moves and nothing is pushed.
 */
export async function restackOnto(git: Git, gitDir: string, input: RestackInput, signal?: AbortSignal): Promise<RestackResult> {
  const reason = await guardMiss(git, gitDir, input, signal);
  if (reason !== undefined) return { kind: "guard", reason };
  const base = await must(git, gitDir, ["merge-base", input.childHead, input.parentFinal], signal);
  const merged = await git(gitDir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${base}`, input.childHead, input.main], signal);
  const [tree = "", ...conflicted] = merged.stdout.split("\n").filter(Boolean);
  if (merged.code === 1) return { kind: "conflict", base, files: [...new Set(conflicted)] };
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const commit = await must(git, gitDir, ["commit-tree", tree, "-p", input.childHead, "-p", input.main, "-m", restackMessage(input, base)], signal);
  return { kind: "restacked", commit, tree, base };
}
