import type { GitHubPort } from "@titan-design/github";
import type { OwnerOp } from "@titan-design/owner-queue";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import { LIVE } from "../shepherd/gone-elsewhere.js";
import type { Registration } from "../shepherd/store.js";
import { nameHolder, type AgentChatRetirePort } from "./retire-agent.js";

type DeleteBranch = Extract<OwnerOp, { kind: "delete-branch" }>;

/** The branches the console may delete and the repos it manages, both from factory config; absent, every delete is refused. */
export interface BranchDeletePolicy {
  prefixes: readonly string[];
  repos: readonly string[];
}

export const DEFAULT_BRANCH_PREFIXES: readonly string[] = Object.freeze(["scratch/"]);

export interface DeleteBranchDeps {
  port: GitHubPort;
  host: { runtime: { status(runId: string): { status: string } | null | undefined } };
  services: { store: { get(): { all(): readonly Pick<Registration, "repo" | "branch" | "runId">[] } } };
  /** The roster, read so a branch an agent works on is never deleted; absent, every delete is refused. */
  agentChat: Pick<AgentChatRetirePort, "list"> | undefined;
  branches: BranchDeletePolicy | undefined;
  /** The `done` results this action id already logged, so a replay of a record that deleted reads back `already`. */
  done: (actionId: string) => Promise<object[]>;
}

/**
 * Deletes one scratch branch on origin at the tip the owner confirmed. Every check the console showed is run again here, from
 * live state; the record names only repo, branch and tip. GitHub's ref delete takes no expected sha, so a push landing between
 * the tip read and the delete goes with it (TP-3620 Q5); the outcome carries the sha read, which the restore line uses.
 */
export async function deleteBranch(actionId: string, { op }: OpRead, deps: DeleteBranchDeps): Promise<Outcome> {
  if (op.kind !== "delete-branch") return refused("record", `delete-branch cannot run a ${op.kind} op`);
  const stop = staticStop(op, deps.branches);
  if (stop !== undefined) return refused("class", stop);
  try {
    const live = await liveStop(op, deps);
    if (live !== undefined) return live;
    return await deleteAtTip(actionId, op, deps);
  } catch (error) {
    return refused("github-unreadable", `${op.repo} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Checks 1 to 3 of the plan: the repo is managed, the name is a plain branch name, and it carries an allowed prefix. */
function staticStop({ repo, branch }: DeleteBranch, policy: BranchDeletePolicy | undefined): string | undefined {
  if (policy === undefined || !policy.repos.some((managed) => managed.toLowerCase() === repo.toLowerCase())) return "not a repo this console manages";
  if (branchNameProblem(branch)) return "not a valid branch name";
  if (!policy.prefixes.some((prefix) => prefix.length > 0 && branch.startsWith(prefix))) return `only ${policy.prefixes.join(", ")} branches are deleted from the console`;
  return undefined;
}

/** git check-ref-format's rules, plus no leading `-`, so a name can never read as a flag or climb out of refs/heads. */
export function branchNameProblem(branch: string): boolean {
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(branch) || branch.includes("..") || branch.includes("//") || branch.includes("@{")) return true;
  if (/^[-/.]/.test(branch) || /[/.]$/.test(branch) || branch.endsWith(".lock") || branch === "@") return true;
  return branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
}

/** Checks 4 to 9, each a fixed refusal naming the rule; the roster is read last, so a GitHub refusal needs no agent-chat. */
async function liveStop({ repo, branch }: DeleteBranch, deps: DeleteBranchDeps): Promise<Outcome | undefined> {
  const { port } = deps;
  if (branch === (await port.defaultBranch(repo))) return refused("class", "the default branch is never deleted");
  if ((await port.branchProtected(repo, branch)) || (await port.requiredChecks(repo, branch)).contexts.length > 0) return refused("class", "protected branches are never deleted");
  const open = await port.listOpenPrs(repo);
  const head = open.find((pull) => pull.headRef === branch);
  if (head !== undefined) return refused("class", `${repo}#${head.number} is open on this branch`);
  const child = open.find((pull) => pull.baseRef === branch);
  if (child !== undefined) return refused("class", `${repo}#${child.number} targets this branch`);
  const run = liveRunOn(repo, branch, deps);
  if (run !== undefined) return refused("class", `Shepherd run ${run} is on this branch`);
  return agentStop(branch, deps.agentChat);
}

function liveRunOn(repo: string, branch: string, { host, services }: Pick<DeleteBranchDeps, "host" | "services">): string | undefined {
  const named = services.store.get().all().filter((registration) => registration.repo.toLowerCase() === repo.toLowerCase() && registration.branch === branch);
  return named.find((registration) => LIVE.has(host.runtime.status(registration.runId)?.status ?? ""))?.runId;
}

/**
 * agent-chat's roster carries no branch, so an agent is known to work on a branch only by its own `agent-chat/<name>` one.
 * A roster that cannot be read refuses the delete rather than skip the check.
 */
async function agentStop(branch: string, agentChat: DeleteBranchDeps["agentChat"]): Promise<Outcome | undefined> {
  if (agentChat === undefined) return refused("agent-chat-unavailable", "serve has no shepherd.agentChatBin, so the agents on this branch cannot be read");
  const rows = await agentChat.list().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  if (!Array.isArray(rows)) return refused("agent-chat-unavailable", rows);
  const name = branch.startsWith("agent-chat/") ? branch.slice("agent-chat/".length) : undefined;
  const holder = name === undefined ? undefined : nameHolder(rows, name);
  return holder === undefined ? undefined : refused("class", `${holder.name} is working on this branch`);
}

async function deleteAtTip(actionId: string, op: DeleteBranch, deps: DeleteBranchDeps): Promise<Outcome> {
  const tip = await deps.port.getHeadSha(op.repo, op.branch);
  if (tip === null) return absent(actionId, op, deps);
  if (tip !== op.tipSha) return { outcome: "moved", currentHead: tip };
  const result = await deps.port.deleteRef(op.repo, { repo: op.repo, branch: op.branch });
  if (result.done) return { outcome: "deleted", branch: op.branch, tipSha: tip };
  if (result.skipped === "absent") return absent(actionId, op, deps);
  return refused("class", `GitHub's delete skipped ${op.branch}: ${result.skipped}`);
}

/** `already` only when this very record deleted the branch; an absent branch someone else deleted is `gone`. */
async function absent(actionId: string, op: DeleteBranch, { done }: Pick<DeleteBranchDeps, "done">): Promise<Outcome> {
  const mine = (await done(actionId)).some((result) => (result as { outcome?: unknown }).outcome === "deleted");
  return mine ? { outcome: "already", branch: op.branch } : { outcome: "gone", reason: `${op.branch} is not on ${op.repo}` };
}
