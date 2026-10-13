import { isAbsolute } from "node:path";
import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import { agentChatAgents } from "./agents.js";
import type { ShepherdDeps } from "./phases.js";
import { restackOnto } from "./stack-restack.js";
import { BranchName, carryCacheDir, carryStateDir, ensureCache, githubRemote, must, reasonOf, serialized, systemGit, type Git } from "./tree-carry.js";

const STACK_CHILDREN_STEP = "sh-stack-children";
const RESTACK_STEP = "sh-restack";
export const STACK_LAND_STEPS: readonly StepDeclaration[] = [
  { id: STACK_CHILDREN_STEP, kind: "dispatch" },
  { id: RESTACK_STEP, kind: "dispatch" },
];

/** Only an agent-chat branch is Shepherd's to push to; any other child is left to its owner. */
const AGENT_CHAT_BRANCH = "agent-chat/";

/** Parent P as Shepherd's own squash left it: `parentFinal` is the head it passed to the merge, `squash` the commit it became. */
interface LandedParent {
  repo: RepoSlug;
  parentPr: number;
  parentHeadRef: string;
  parentFinal: string;
  squash: string;
}

/** A child as the open list showed it: `headSha` is the head Shepherd last saw, the only head it will restack. */
interface StackChild {
  pr: number;
  headRef: string;
  headSha: string;
}

export interface RestackInput extends LandedParent {
  child: StackChild;
}

const Child = z.object({ pr: z.number().int().positive(), headRef: z.string(), headSha: z.string() });
const ChildrenResult = z.object({ children: z.array(Child) });

const RestackRecord = z.object({ parentPr: z.number(), squash: z.string(), parentFinal: z.string(), base: z.string(), tree: z.string(), newHead: z.string() });
const RestackResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("restacked"), pr: z.number(), retargeted: z.boolean(), ...RestackRecord.shape }),
  z.object({ outcome: z.enum(["skipped", "head-moved", "conflict", "guard"]), pr: z.number(), reason: z.string(), woken: z.boolean() }),
]);
type RestackResult = z.infer<typeof RestackResult>;
type Restacked = Extract<RestackResult, { outcome: "restacked" }>;
type Refusal = { outcome: Exclude<RestackResult["outcome"], "restacked">; reason: string };

/** A child the restack refused: its implementer is told why, and its head is left as it was. */
export interface ChildWake {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  reason: string;
}

export interface StackLandDeps {
  port: GitHubPort;
  /** Where the children are read from; absent means the port's open list. */
  snapshot?: PrSnapshot;
  /** Tells the child's implementer; false when no one could be told. */
  wakeChild: (wake: ChildWake) => Promise<boolean>;
  /** Holds Shepherd's bare git cache; absent means the bound state dir. */
  stateDir?: string;
  /** The fetch and push URL for `repo`; absent means GitHub over https. */
  remote?: (repo: string) => string;
  git?: Git;
}

const restackReason = (parentPr: number, detail: string): string => `parent #${parentPr} landed; restack ${detail}`;

/**
 * The open PRs whose base is the parent's head branch. A parent on the default branch or on a fork's branch stacks
 * nothing, since that name is the base of unrelated PRs. A child GitHub already retargeted after the parent branch's
 * deletion is no longer found here; it keeps its head and takes the ordinary update path.
 */
export async function stackChildren(deps: Pick<StackLandDeps, "port" | "snapshot">, parent: Omit<LandedParent, "parentFinal" | "squash"> & { parentHeadRepo: string | null }): Promise<StackChild[]> {
  if (parent.parentHeadRepo?.toLowerCase() !== parent.repo.toLowerCase()) return [];
  if (parent.parentHeadRef === (await deps.port.defaultBranch(parent.repo))) return [];
  const open = deps.snapshot ? await deps.snapshot.openPrs(parent.repo) : await deps.port.listOpenPrs(parent.repo);
  return open.filter((pr) => pr.baseRef === parent.parentHeadRef && pr.number !== parent.parentPr).map(({ number, headRef, headSha }) => ({ pr: number, headRef, headSha }));
}

/** Why the child may not be restacked from what GitHub reports now, or undefined when it may; its head is checked on the remote. */
function prMiss(input: RestackInput, child: PullRequest, parent: PullRequest, defaultBranch: string): Refusal | undefined {
  if (!parent.merged || parent.mergeSha !== input.squash) return { outcome: "guard", reason: `guard: parent #${input.parentPr} is not merged as ${input.squash}` };
  if (child.state !== "open") return { outcome: "guard", reason: "guard: the child is not open" };
  if (child.headRepo?.toLowerCase() !== input.repo.toLowerCase()) return { outcome: "guard", reason: "guard: the child's head is on a fork" };
  if (child.headRef !== input.child.headRef) return { outcome: "guard", reason: `guard: the child's head branch is ${child.headRef}, not ${input.child.headRef}` };
  if (child.baseRef !== input.parentHeadRef && child.baseRef !== defaultBranch) return { outcome: "guard", reason: `guard: base ${child.baseRef} is neither the parent's branch nor ${defaultBranch}` };
  return undefined;
}

/** One cache, one remote, one child: what every git call below runs against. */
interface Remote {
  git: Git;
  dir: string;
  url: string;
  input: RestackInput;
  defaultBranch: string;
}

const childRef = (input: RestackInput): string => `refs/heads/${input.child.headRef}`;

/** The remote tips the restack builds from, read at one moment. */
async function remoteTips(remote: Remote): Promise<{ main?: string; child?: string; parent?: string }> {
  const { git, dir, url, input, defaultBranch } = remote;
  const refs = { main: `refs/heads/${defaultBranch}`, child: childRef(input), parent: `refs/pull/${input.parentPr}/head` };
  const listed = new Map((await must(git, dir, ["ls-remote", url, refs.main, refs.child, refs.parent])).split("\n").map((line) => line.split("\t")).map(([sha = "", ref = ""]) => [ref, sha]));
  return { main: listed.get(refs.main), child: listed.get(refs.child), parent: listed.get(refs.parent) };
}

const remoteChild = async (remote: Remote): Promise<string | undefined> => (await must(remote.git, remote.dir, ["ls-remote", remote.url, childRef(remote.input)])).split("\t")[0] || undefined;

/** A restack Shepherd already pushed: the moved head is its own merge-onto commit over the last seen head, found on a replay. */
type Pushed = { base: string; tree: string; newHead: string };

const restackSubject = (parentPr: number): string => `Restack onto main after #${parentPr} `;

/** The moved head when it is this restack's own commit: two parents, the last seen head first, a commit of main second. */
async function priorRestack(remote: Remote, moved: string, main: string): Promise<Pushed | undefined> {
  const { git, dir, url, input } = remote;
  await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, moved, main, input.parentFinal]);
  const [, first, second, ...rest] = (await must(git, dir, ["rev-list", "--parents", "-n", "1", moved])).split(" ");
  if (first !== input.child.headSha || second === undefined || rest.length > 0) return undefined;
  if ((await git(dir, ["merge-base", "--is-ancestor", second, main])).code !== 0) return undefined;
  if (!(await must(git, dir, ["log", "-1", "--format=%s", moved])).startsWith(restackSubject(input.parentPr))) return undefined;
  const base = await must(git, dir, ["merge-base", input.child.headSha, input.parentFinal]);
  return { base, tree: await must(git, dir, ["rev-parse", `${moved}^{tree}`]), newHead: moved };
}

/**
 * Builds the merge-onto commit and pushes it with a plain push, which only fast-forwards. The branch is read again just
 * before the push and after it, so a branch that moved, rewound or vanished is never written over, and only a push read
 * back at the new commit counts. The window between the last read and the push is the only one left.
 */
async function buildAndPush(remote: Remote): Promise<Pushed | Refusal> {
  const { git, dir, url, input } = remote;
  await ensureCache(git, dir);
  const tips = await remoteTips(remote);
  if (tips.parent !== input.parentFinal) return { outcome: "guard", reason: `guard: refs/pull/${input.parentPr}/head is not the merged head ${input.parentFinal}` };
  if (tips.main === undefined) return { outcome: "guard", reason: `guard: ${remote.defaultBranch} was not found` };
  const prior = tips.child !== undefined && tips.child !== input.child.headSha ? await priorRestack(remote, tips.child, tips.main) : undefined;
  if (prior !== undefined) return prior;
  if (tips.child !== input.child.headSha) return headMoved(`the branch is at ${tips.child ?? "nothing"}, not the last seen ${input.child.headSha}`);
  await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, tips.main, input.child.headSha, input.parentFinal]);
  const built = await restackOnto(git, dir, { childHead: input.child.headSha, parentFinal: input.parentFinal, squash: input.squash, main: tips.main, parentPr: input.parentPr });
  if (built.kind === "conflict") return { outcome: "conflict", reason: `conflict in ${built.files.join(", ") || "unlisted files"}; Shepherd pushed nothing` };
  if (built.kind === "guard") return { outcome: "guard", reason: `guard: ${built.reason}` };
  if ((await remoteChild(remote)) !== input.child.headSha) return headMoved("the branch moved before the push");
  if ((await git(dir, ["push", "--quiet", "--porcelain", url, `${built.commit}:${childRef(input)}`])).code !== 0) return headMoved("the fast-forward push was rejected");
  if ((await remoteChild(remote)) !== built.commit) return headMoved(`the branch does not read back at ${built.commit} after the push`);
  return { base: built.base, tree: built.tree, newHead: built.commit };
}

const headMoved = (detail: string): Refusal => ({ outcome: "head-moved", reason: `head moved: ${detail}; Shepherd left the base as it was` });

/** Retargets only after the push read back, and only while the base is still the parent's branch. */
async function retarget(deps: StackLandDeps, input: RestackInput, child: PullRequest, defaultBranch: string, pushed: Pushed): Promise<Restacked | Refusal> {
  const retargeted = child.baseRef === input.parentHeadRef;
  const write = retargeted ? await deps.port.setPrBase(input.repo, input.child.pr, defaultBranch).catch((error: unknown) => reasonOf(error)) : undefined;
  const failed = typeof write === "string" ? write : write !== undefined && !write.done && write.skipped !== "unchanged" ? `skipped (${write.skipped})` : undefined;
  if (failed !== undefined) return { outcome: "guard", reason: `guard: pushed ${pushed.newHead}, but the retarget to ${defaultBranch} ${failed}; retarget the PR by hand` };
  const { parentPr, squash, parentFinal } = input;
  return { outcome: "restacked", pr: input.child.pr, retargeted, parentPr, squash, parentFinal, ...pushed };
}

async function attempt(deps: StackLandDeps, input: RestackInput): Promise<Restacked | Refusal> {
  if (!input.child.headRef.startsWith(AGENT_CHAT_BRANCH) || !BranchName.safeParse(input.child.headRef).success) return { outcome: "skipped", reason: "skipped: the head branch is not an agent-chat/* branch" };
  const [child, parent, defaultBranch] = await Promise.all([deps.port.getPr(input.repo, input.child.pr), deps.port.getPr(input.repo, input.parentPr), deps.port.defaultBranch(input.repo)]);
  const miss = prMiss(input, child, parent, defaultBranch);
  if (miss !== undefined) return miss;
  const dir = carryCacheDir(carryStateDir(deps.stateDir), input.repo);
  const remote: Remote = { git: deps.git ?? systemGit, dir, url: (deps.remote ?? githubRemote)(input.repo), input, defaultBranch };
  const pushed = await serialized(dir, () => buildAndPush(remote));
  deps.snapshot?.invalidate(input.repo);
  return "newHead" in pushed ? retarget(deps, input, child, defaultBranch, pushed) : pushed;
}

/**
 * Restacks one child of a parent Shepherd squash-merged: a merge-onto commit pushed fast-forward, never forced, and only
 * then retargeted. Every refusal, a failed read or fetch included, wakes the child's implementer; there is no rebase
 * fallback. Only direct children come here, so a grandchild keeps its base and is untouched until its own parent lands.
 */
export async function restackChild(deps: StackLandDeps, input: RestackInput): Promise<RestackResult> {
  const result = await attempt(deps, input).catch((error: unknown): Refusal => ({ outcome: "guard", reason: `guard: ${reasonOf(error)}` }));
  if (result.outcome === "restacked") return result;
  const reason = restackReason(input.parentPr, result.reason);
  const woken = await deps.wakeChild({ repo: input.repo, pr: input.child.pr, headSha: input.child.headSha, reason }).catch(() => false);
  return { outcome: result.outcome, pr: input.child.pr, reason, woken };
}

/**
 * Called once Shepherd's own squash of the parent returned its commit. Each child's record is keyed by the head it was
 * restacked from; a replay after the push finds its own commit there, so it neither pushes twice nor wakes anyone.
 */
async function restackChildren(ctx: WorkflowContext, parent: LandedParent & { parentHeadRepo: string | null }): Promise<RestackResult[]> {
  const { children } = await step(ctx, `${STACK_CHILDREN_STEP}:${parent.parentPr}`, parent, ChildrenResult);
  const results: RestackResult[] = [];
  for (const child of children) results.push(await step(ctx, `${RESTACK_STEP}:${child.pr}:${child.headSha}`, { ...parent, child }, RestackResult));
  return results;
}

/** Only the run's own merge write restacks; a PR GitHub reports merged elsewhere restacks nothing, even with `landed` set. */
export async function restackLanded(ctx: WorkflowContext, target: { repo: RepoSlug; pr: number; mergeSha: string; own?: true; landed?: { headRef: string; headRepo: string | null; headSha: string } }): Promise<void> {
  if (target.own !== true || target.landed === undefined || target.mergeSha === "") return;
  const { headRef, headRepo, headSha } = target.landed;
  await restackChildren(ctx, { repo: target.repo, parentPr: target.pr, parentHeadRef: headRef, parentHeadRepo: headRepo, parentFinal: headSha, squash: target.mergeSha });
}

/** Messages the child's registered implementer; a child Shepherd does not track has no one to tell. */
function wakeOver(deps: ShepherdDeps): (wake: ChildWake) => Promise<boolean> {
  return async (wake) => {
    const registration = deps.store.get().byPr(wake.repo, wake.pr);
    if (registration === undefined || !isAbsolute(deps.agentChatBin)) return false;
    const agents = agentChatAgents(deps.agentChatBin, { configDir: deps.agentChatConfigDir, roster: deps.roster });
    const message = `${wake.repo}#${wake.pr} at ${wake.headSha}: ${wake.reason}.`;
    return agents.message(registration.implementer, message).then(() => true, () => false);
  };
}

/** An advisory repo is never written to, so it stacks no child to restack. */
export function stackLandRoutes(deps: ShepherdDeps): StepRoute[] {
  const land: StackLandDeps = { port: deps.port, wakeChild: wakeOver(deps), ...(deps.snapshot && { snapshot: deps.snapshot }) };
  return [
    codeRoute(STACK_CHILDREN_STEP, deps.now, async (input: LandedParent & { parentHeadRepo: string | null }) => ({ children: deps.advisory?.(input.repo) ? [] : await stackChildren(land, input) })),
    codeRoute(RESTACK_STEP, deps.now, (input: RestackInput) => restackChild(land, input)),
  ];
}
