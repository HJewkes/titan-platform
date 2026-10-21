import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Git = (args: readonly string[], cwd: string) => Promise<string>;

const run = promisify(execFile);

export const execGit: Git = async (args, cwd) => (await run("git", [...args], { cwd })).stdout.trim();

interface RatchetMove {
  /** The integration tree: a checkout of the target repo whose `origin` holds the ratchet branch. */
  tree: string;
  ratchetRef: string;
  ratchetPrefix: string;
  /** The ratchet head this winner was judged against. */
  from: string;
  /** The winner's commit. */
  to: string;
}

/** The only code that moves the ratchet: fast-forward only, and only from the head the keep rule was run against. */
export async function ratchetFastForward(git: Git, move: RatchetMove): Promise<{ head: string }> {
  if (!move.ratchetRef.startsWith(`refs/heads/${move.ratchetPrefix}/`)) throw new Error(`[ratchet-ref] ${move.ratchetRef} is outside refs/heads/${move.ratchetPrefix}/`);
  const remote = (await git(["ls-remote", "origin", move.ratchetRef], move.tree)).split(/\s/)[0];
  if (remote !== move.from) throw new Error(`[ratchet-moved] ${move.ratchetRef} is at ${remote || "nothing"}, not ${move.from}`);
  await git(["checkout", "--quiet", "--detach", move.from], move.tree);
  await git(["merge", "--ff-only", "--quiet", move.to], move.tree);
  await git(["push", "--quiet", `--force-with-lease=${move.ratchetRef}:${move.from}`, "origin", `HEAD:${move.ratchetRef}`], move.tree);
  return { head: await git(["rev-parse", "HEAD"], move.tree) };
}
