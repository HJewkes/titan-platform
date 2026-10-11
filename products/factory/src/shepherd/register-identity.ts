import { ghCliWire, githubPort, type RepoSlug } from "@titan-design/github";
import { implementerFromBranch, taskFromBranch } from "./register-infer.js";

export type HeadRefRead = (repo: RepoSlug, pr: number) => Promise<string>;

const defaultHeadRef: HeadRefRead = async (repo, pr) => (await githubPort(ghCliWire()).getPr(repo, pr)).headRef;

async function headBranchOf({ repo, pr }: { repo: string; pr?: number }, headRef: HeadRefRead): Promise<string> {
  if (pr === undefined) throw new Error(`${repo} names no pull request; pass --branch <name>, or --task and --implementer`);
  return headRef(repo, pr);
}

/** An explicit flag wins; a missing one is read from the head branch, which --branch names or the PR's head supplies. */
export async function inferIdentity(
  target: { repo: string; pr?: number },
  flags: { branch?: string; task?: string; implementer?: string },
  headRef: HeadRefRead = defaultHeadRef,
): Promise<{ task: string; implementer: string }> {
  if (flags.task !== undefined && flags.implementer !== undefined) return { task: flags.task, implementer: flags.implementer };
  const branch = flags.branch ?? (await headBranchOf(target, headRef));
  const task = flags.task ?? taskFromBranch(branch);
  const implementer = flags.implementer ?? implementerFromBranch(branch);
  if (task === undefined) throw new Error(`no task id in head branch ${branch}; pass --task <initiative>/<ID>`);
  if (implementer === undefined) throw new Error(`head branch ${branch} is not agent-chat/<name>; pass --implementer <name>`);
  return { task, implementer };
}
