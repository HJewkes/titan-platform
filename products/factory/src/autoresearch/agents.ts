import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ArPorts, ImplementRequest } from "@titan-design/autoresearch";
import { dispatchToAgentChat, listAgents, resumeAgent } from "@titan-design/agent-dispatch";
import { resolveLimits, type ParsedLimits } from "@titan-design/agent-dispatch/limits";
import { createWorktreeAllocator, type WorktreeAllocator } from "@titan-design/worktree";
import { z } from "zod";
import { awaitAgent, hasResponded, rosterRow, transcriptEnd, type AgentChat, type AgentResult } from "./agent-run.js";
import { loadWaitPort, staggerLatch, type LoadWaitOptions } from "./load-wait.js";
import { execGit } from "./ratchet.js";

export interface ArAgentsOptions {
  /** The target repo checkout idea trees are cut from. */
  clone: string;
  agentChat: AgentChat;
  /** The agents account's Claude config directory; every spawn runs on it. */
  configDir: string;
  /** Recorded on each implementer as its `account`. */
  account: string;
  profiles: { implementer: string; planner: string };
  /** The planner only reads, so it sits in a checkout no lane writes to. */
  plannerCwd: string;
  /** Read before every spawn or resume; a closed pool or profile refuses it. */
  limits: { pool: string; read: () => ParsedLimits };
  load: LoadWaitOptions;
  now?: () => Date;
}

type AgentPorts = Pick<ArPorts, "allocTree" | "releaseTree" | "implement" | "plan" | "loadWait">;
type From = { path?: string; offset: number };
type Done = AgentResult & { name: string };

interface Host {
  options: ArAgentsOptions;
  chat: AgentChat;
  allocator: WorktreeAllocator;
  stagger: (tag: string) => ReturnType<typeof staggerLatch>;
}

const FinalImplementSchema = z.object({ head: z.string().min(1), lesson: z.string().optional() });
const BRANCH_PREFIX = "ar/";

/** Peer names are capped at 64 lowercase characters, so the run id is folded to a fixed tag. */
const runTag = (runId: string): string => createHash("sha256").update(runId).digest("hex").slice(0, 8);
export const plannerName = (runId: string): string => `ar-${runTag(runId)}-planner`;
const treeName = (runId: string, ideaId: string): string => `ar-${runTag(runId)}-${ideaId}`;
const implementerName = (tag: string, round: number, ideaId: string): string => `ar-${tag}-r${round}-${ideaId}`.toLowerCase();
const inside = (path: string, tree: string): boolean => path === tree || path.startsWith(tree + sep);

/** `ImplementRequest` carries no run id; the tree `allocTree` named carries its tag. */
function tagOfTree(tree: string): string {
  const tag = /^ar-([0-9a-f]{8})-/.exec(basename(tree))?.[1];
  if (tag === undefined) throw new Error(`[tree] ${tree} was not allocated by this host`);
  return tag;
}

function admit(host: Host, profile: string): void {
  const { limits, now } = host.options;
  const resolved = resolveLimits(limits.read(), { pool: limits.pool, profile, now: now?.() ?? new Date() });
  if (!resolved.open) throw new Error(`[limits] ${resolved.reason}`);
}

/** A name already on the roster is a spawn a restarted host already sent, so it is joined, not sent twice. */
async function spawnOrJoin(host: Host, name: string, profile: string, cwd: string, brief: string): Promise<void> {
  if ((await rosterRow(host.chat, name)) !== undefined) return;
  admit(host, profile);
  const { options, chat } = host;
  const request = { agentChatBinPath: chat.bin, peerName: name, profile, brief, cwd, configDir: options.configDir };
  await dispatchToAgentChat(request, chat.timeoutMs, [options.profiles.implementer, options.profiles.planner]);
}

/** A live row is a resume a restarted host already sent, so it is joined rather than resumed twice. */
async function resumeOrJoin(host: Host, name: string, profile: string, message: string): Promise<From> {
  const row = await rosterRow(host.chat, name);
  if (row === undefined) throw new Error(`[resume] ${name} is not on the roster`);
  const from = transcriptEnd(row);
  if (row.presence !== "exited") return from;
  admit(host, profile);
  await resumeAgent(host.chat.bin, name, message, host.chat.timeoutMs);
  return from;
}

async function untilResponded(host: Host, name: string, responded: () => void, signal: AbortSignal): Promise<void> {
  while (!(await hasResponded(host.chat, name))) await sleep(host.chat.pollMs, undefined, { signal });
  responded();
}

function implementBrief(input: ImplementRequest): string {
  return `${input.brief}\n\nWork in ${input.tree}, on top of ${input.base}. Commit there, then end with one JSON block: {"head": "<commit sha>", "lesson": "<one line>"}.`;
}

async function explore(host: Host, input: ImplementRequest, signal: AbortSignal): Promise<Done> {
  const tag = tagOfTree(input.tree);
  const name = implementerName(tag, input.round, input.idea.id);
  return host.stagger(tag)(input.round, async (responded) => {
    await spawnOrJoin(host, name, host.options.profiles.implementer, input.tree, implementBrief(input));
    await untilResponded(host, name, responded, signal);
    return { name, ...(await awaitAgent(host.chat, name, signal)) };
  });
}

/** The winner's agent resumes in its own cwd, so the idea tree, already at the ratchet head, is moved there for the turn and back after. */
async function exploit(host: Host, input: ImplementRequest & { resumeFrom: string }, signal: AbortSignal): Promise<Done> {
  const name = input.resumeFrom;
  const home = (await rosterRow(host.chat, name))?.cwd;
  if (home === undefined) throw new Error(`[resume] ${name} is not on the roster`);
  if (existsSync(input.tree)) {
    if (existsSync(home)) throw new Error(`[tree-occupied] ${home} exists, so ${name}'s tree cannot be re-created there`);
    await execGit(["worktree", "move", input.tree, home], host.options.clone);
  }
  try {
    const from = await host.stagger(tagOfTree(input.tree))(input.round, async (responded) => {
      const at = await resumeOrJoin(host, name, host.options.profiles.implementer, implementBrief(input));
      await untilResponded(host, name, responded, signal);
      return at;
    });
    return { name, ...(await awaitAgent(host.chat, name, signal, from)) };
  } finally {
    if (existsSync(home) && !existsSync(input.tree)) await execGit(["worktree", "move", home, input.tree], host.options.clone);
  }
}

async function implement(host: Host, input: ImplementRequest, signal: AbortSignal) {
  const resumeFrom = input.fork === "exploit" ? input.resumeFrom : undefined;
  const done = resumeFrom === undefined ? await explore(host, input, signal) : await exploit(host, { ...input, resumeFrom }, signal);
  const usage = done.usage;
  return {
    ...FinalImplementSchema.parse(done.final),
    agent: done.name,
    ...(done.row.sessionId === "" ? {} : { sessionId: done.row.sessionId }),
    mode: resumeFrom === undefined ? ("spawn" as const) : ("resume" as const),
    ...(resumeFrom === undefined ? {} : { resumedFrom: resumeFrom }),
    account: host.options.account,
    usd: usage.usd,
    usage,
  };
}

/** Round 1 spawns the planner; later rounds resume the same agent so its prompt prefix is read from cache. */
async function plan(host: Host, input: Parameters<ArPorts["plan"]>[0], signal: AbortSignal): Promise<unknown> {
  const name = plannerName(input.runId);
  const { profiles, plannerCwd } = host.options;
  const brief = JSON.stringify({ round: input.round, digest: input.digest, violations: input.violations });
  let from: From = { offset: 0 };
  if (input.mode === "spawn") await spawnOrJoin(host, name, profiles.planner, plannerCwd, brief);
  else from = await resumeOrJoin(host, name, profiles.planner, brief);
  return (await awaitAgent(host.chat, name, signal, from)).final;
}

async function allocTree(host: Host, input: Parameters<ArPorts["allocTree"]>[0]) {
  const allocation = await host.allocator.allocate({ agentName: treeName(input.runId, input.ideaId), baseCwd: host.options.clone });
  const { worktree, branch } = allocation.ref;
  if (!worktree || !branch) throw new Error(`[alloc] the allocator returned no tree for ${input.ideaId}`);
  if (allocation.ref.reused !== "true") await execGit(["reset", "--quiet", "--hard", input.base], worktree);
  return { tree: worktree, branch };
}

/** Parks the tree: never while a live agent works in it, and the branch is always kept. */
async function releaseTree(host: Host, tree: string): Promise<void> {
  const holder = (await listAgents(host.chat.bin, host.chat.timeoutMs)).find((row) => row.presence !== "exited" && inside(row.cwd, tree));
  if (holder !== undefined) throw new Error(`[tree-live] ${tree} is the cwd of live agent ${holder.name}`);
  const { clone } = host.options;
  if (existsSync(tree)) await execGit(["worktree", "remove", tree], clone);
  const ref = { branch: `${BRANCH_PREFIX}${basename(tree)}`, worktree: tree, gitRoot: await execGit(["rev-parse", "--show-toplevel"], clone) };
  const released = await host.allocator.release({}, { ref }, { keepBranch: true });
  if (!released.released) throw new Error(`[release] ${released.refusal}`);
}

function staggers(chat: AgentChat): Host["stagger"] {
  const latches = new Map<string, ReturnType<typeof staggerLatch>>();
  return (tag) => {
    const started = async (round: number) => (await listAgents(chat.bin, chat.timeoutMs)).some((row) => row.name.startsWith(`ar-${tag}-r${round}-`));
    const latch = latches.get(tag) ?? staggerLatch(started);
    latches.set(tag, latch);
    return latch;
  };
}

/** The agent-side ports: idea trees, the planner and implementers on the agents account, and the load gate. */
export function arAgentPorts(options: ArAgentsOptions): AgentPorts {
  const allocator = createWorktreeAllocator({ basePath: ".worktrees/autoresearch", budget: 4, allocationGroup: () => "autoresearch", branchPrefix: BRANCH_PREFIX, skipSetup: true });
  const host: Host = { options, chat: options.agentChat, allocator, stagger: staggers(options.agentChat) };
  return {
    allocTree: (input) => allocTree(host, input),
    releaseTree: ({ tree }) => releaseTree(host, tree),
    implement: (input, signal) => implement(host, input, signal),
    plan: (input, signal) => plan(host, input, signal),
    loadWait: loadWaitPort(options.load),
  };
}
