import { diffHashes, type DiffPin, type MergeUpCheck } from "./diff-hash.js";
import type { GhExecOptions, GitExec } from "./exec.js";
import { gitMergeTree } from "./git-merge-tree.js";

/**
 * No global or system config, and none a parent `git -c` or `GIT_CONFIG_COUNT` injected, so a hostile gitconfig cannot
 * change the diff, the merge base or the merge. The clone's own config is the factory's, and the §2.3 command pins every
 * diff option that config could set.
 */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_PARAMETERS: "",
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
};

/** v9.1 §2.3's command, after `git -C <clone>` and before `<merge-base> <head>`. */
export const DIFF_HASH_ARGS: readonly string[] = [
  "-c",
  "core.quotePath=true",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--full-index",
  "--binary",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "--inter-hunk-context=0",
  "--default-prefix",
  "--no-relative",
  "-O/dev/null",
  "-U3",
];

export interface DiffPinOptions {
  /** Defaults to `origin`. */
  remote?: string;
  /** Defaults to `main`. */
  branch?: string;
  /** The fetch's credential (as for `lsRemotePullHead`); it rides over `HARDENED_GIT_ENV` for the fetch alone. */
  fetchEnv?: Readonly<Record<string, string>>;
  /** Per git call; defaults to 60 s. */
  timeoutMs?: number;
}

export class DiffHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffHashError";
  }
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Fetches `main` fresh, takes `merge-base --all` of it and `head`, and hashes the §2.3 diff between them. More than one
 * base, or none, gives an ambiguous pin. `head` must be a full sha, so no local branch or tag can shadow it.
 */
export async function gitDiffPin(exec: GitExec, clone: string, head: string, options: DiffPinOptions = {}): Promise<DiffPin> {
  checkOid("head", head);
  const run = runner(exec, clone, options.timeoutMs);
  const main = await freshMain(run, options);
  const bases = await mergeBases(run, main, head);
  if (bases.length !== 1) return { kind: "ambiguous", head, main, bases };
  const base = bases[0]!;
  const diff = await run([...DIFF_HASH_ARGS, base, head], "diff");
  return { kind: "exact", head, base, main, ...diffHashes(diff.stdout) };
}

type Run = (args: readonly string[], what: string, env?: Readonly<Record<string, string>>) => Promise<{ code: number; stdout: string }>;

function runner(exec: GitExec, clone: string, timeoutMs = 60_000): Run {
  return async (args, what, env = HARDENED_GIT_ENV) => {
    const options: GhExecOptions = { env, timeoutMs };
    const result = await exec(["-C", clone, ...args], options);
    if (result.code > 1 || (result.code === 1 && what !== "merge-base" && what !== "ancestry")) throw new DiffHashError(`git ${what} exited ${result.code}: ${result.stderr.trim()}`);
    return result;
  };
}

/** The tip of `main` as the remote has it now, never a local `origin/main` a stale fetch or a same-named branch left. */
async function freshMain(run: Run, { remote = "origin", branch = "main", fetchEnv }: DiffPinOptions): Promise<string> {
  checkName("remote", remote);
  checkName("branch", branch);
  const tracking = `refs/remotes/${remote}/${branch}`;
  await run(["fetch", "--no-tags", "--quiet", "--", remote, `+refs/heads/${branch}:${tracking}`], "fetch", { ...HARDENED_GIT_ENV, ...fetchEnv });
  const { stdout } = await run(["rev-parse", "--verify", "--end-of-options", `${tracking}^{commit}`], "rev-parse");
  return stdout.trim();
}

async function mergeBases(run: Run, main: string, head: string): Promise<string[]> {
  const { stdout } = await run(["merge-base", "--all", main, head], "merge-base");
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * Exclusion 2's check in a clone: `current.head` has exactly two parents, the reviewed head and one already in the main
 * tip the pin was taken from, and a clean `merge-tree --write-tree` of the two reproduces its tree.
 */
export function gitMergeUpCheck(exec: GitExec, clone: string, timeoutMs?: number): MergeUpCheck {
  const run = runner(exec, clone, timeoutMs);
  return async (reviewedHead, current) => {
    const parents = (await run(["rev-list", "--parents", "-n", "1", current.head], "rev-list")).stdout.trim().split(" ").slice(1);
    const mainParent = parents.length === 2 && parents.includes(reviewedHead) ? parents.find((parent) => parent !== reviewedHead) : undefined;
    if (mainParent === undefined) return { ok: false, reason: `head ${current.head} is not a two-parent merge into reviewed ${reviewedHead}` };
    const ancestry = await run(["merge-base", "--is-ancestor", mainParent, current.main], "ancestry");
    if (ancestry.code !== 0) return { ok: false, reason: `merged parent ${mainParent} is not in main ${current.main}` };
    return mergeTreeProof(run, gitMergeTree(clone, HARDENED_GIT_ENV), reviewedHead, mainParent, current.head);
  };
}

async function mergeTreeProof(run: Run, mergeTree: ReturnType<typeof gitMergeTree>, reviewedHead: string, mainParent: string, head: string) {
  const tree = await mergeTree(mainParent, reviewedHead);
  if (tree === null) return { ok: false as const, reason: `reviewed ${reviewedHead} conflicts with merged parent ${mainParent}` };
  const headTree = (await run(["rev-parse", "--verify", "--end-of-options", `${head}^{tree}`], "rev-parse")).stdout.trim();
  return tree === headTree ? { ok: true as const, mainParent } : { ok: false as const, reason: `head ${head} is not a clean merge of ${mainParent} into reviewed ${reviewedHead}` };
}

function checkOid(field: string, value: string): void {
  if (!OID.test(value)) throw new DiffHashError(`${field} must be a full lowercase sha, got ${JSON.stringify(value.slice(0, 80))}`);
}

function checkName(field: string, value: string): void {
  if (!NAME.test(value)) throw new DiffHashError(`${field} must be a plain name, got ${JSON.stringify(value.slice(0, 80))}`);
}
