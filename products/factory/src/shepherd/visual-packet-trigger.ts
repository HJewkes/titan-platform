import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { AgentChatAgents } from "./agents.js";
import { landGateHead } from "./approval-carry.js";
import type { PrTarget } from "./gates.js";
import type { OwnerGateReason } from "./policy.js";
import { resolveCheckout } from "./reviewer-dispatch.js";

const VISUAL_PACKET_STEP = "sh-visual-packet";
export const VISUAL_PACKET_STEPS: readonly StepDeclaration[] = [{ id: VISUAL_PACKET_STEP, kind: "dispatch" }];

export type VisualPacketMode = "off" | "shadow" | "on";
export const DEFAULT_PACKAGER_PROFILE = "review-packager";

/** `shepherd.visualPacket` and what an `on` spawn needs; absent reads as `off`. */
export interface VisualPacketPorts {
  mode: VisualPacketMode;
  profile: string;
  /** The factory state dir; each packet goes under `<stateDir>/packets/<run id>/<head sha>`. */
  stateDir: string;
  /** Absent means no agent-chat is configured, so an `on` spawn is recorded as failed. */
  agents?: Pick<AgentChatAgents, "roster" | "spawn">;
  /** The repo's seat checkout: the packager starts in it, and from-ci and the lint read git objects from it. None spawns nothing. */
  cwdFor?: (repo: string) => string | undefined;
  /** `shepherd.titanReviewBin`; absent means `$HOME/.local/bin/titan-review`, named in full as `~/.local/bin` is not on every PATH. */
  titanReviewBin?: string;
}

const PacketEvent = z.enum(["visual-packet-off", "visual-packet-would-spawn", "visual-packet-spawned", "visual-packet-spawn-failed"]);
const PacketResult = z.looseObject({
  event: PacketEvent,
  packetDir: z.string().optional(),
  agent: z.string().optional(),
  profile: z.string().optional(),
  reason: z.string().optional(),
});
type PacketResult = z.infer<typeof PacketResult>;

export interface PacketInput {
  runId: string;
  repo: RepoSlug;
  pr: number;
  headSha: string;
  gateId: string;
}

const VISUAL_RULE = /\? CI is green\. Policy shepherd-merge-guard\/visual-path:/;

/** A land approve-merge gate under the visual-path guard, or any land gate of a run its seat registered for Gate 2 visual sign-off. */
export function isVisualGate(stepId: string, prompt: string, ownerGateReason: OwnerGateReason | undefined): string | undefined {
  const head = landGateHead(stepId, prompt);
  return head !== undefined && (VISUAL_RULE.test(prompt) || ownerGateReason === "gate-2-visual") ? head : undefined;
}

/** What the trigger reads from the run: its target and the policy as narrowed so far. */
interface PacketRun {
  ctx: WorkflowContext;
  target: PrTarget;
  ownerGateReason: () => OwnerGateReason | undefined;
}

/** Wraps `assisted` so a visual approve-merge gate records its packet step first; the gate opens whatever the step recorded. */
export function packetTriggering(run: PacketRun, assisted: WorkflowContext["assisted"]): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    const headSha = isVisualGate(stepId, prompt, run.ownerGateReason());
    if (headSha !== undefined) await triggerPacket(run, stepId, headSha);
    return assisted(stepId, prompt, options);
  };
}

/**
 * One packet step per head, keyed by the head, so a second gate at it, a replay and a restart each find the record and
 * spawn nothing. A record that goes on to something else predates the step, and a run resumed on a pending gate opened
 * it before the step existed; neither records one now, as the replay would diverge.
 */
async function triggerPacket(run: PacketRun, gateStep: string, headSha: string): Promise<void> {
  const { ctx } = run;
  const stepId = `${VISUAL_PACKET_STEP}:${headSha}`;
  const next = ctx.historyNext();
  if (ctx.iteration(stepId) > 0 || (next !== undefined && next !== stepId)) return;
  const resumed = ctx.resumedGate();
  if (next === undefined && resumed !== undefined && stepIdMatches(gateStep, resumed)) return;
  const index = ctx.iteration(gateStep);
  const gateId = `${ctx.runId}/${index === 0 ? gateStep : `${gateStep}:${index}`}`;
  await step(ctx, stepId, { runId: ctx.runId, ...run.target, headSha, gateId } satisfies PacketInput, PacketResult);
}

export const defaultTitanReviewBin = (): string => join(process.env.HOME || homedir(), ".local", "bin", "titan-review");

export function packetDirFor(stateDir: string, runId: string, headSha: string): string {
  return join(stateDir, "packets", runId, headSha);
}

/** Unique per run and head, and one argv word agent-chat takes as a name. */
export function packagerName(runId: string, headSha: string): string {
  return `packager-${headSha.slice(0, 8)}-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

interface PacketFacts {
  headTree?: string;
  ciRunId?: number;
}

/** Each read is best effort: a fact GitHub would not give is left out, and the packager looks it up. */
async function packetFacts(port: GitHubPort, input: PacketInput): Promise<PacketFacts> {
  const tree = await port.getCommit(input.repo, input.headSha).then((commit) => commit.tree, () => undefined);
  const runs = await port.checkRuns(input.repo, input.headSha).catch(() => []);
  const ciRunId = runs.find((run) => /visual/i.test(run.name) && run.headSha === input.headSha && run.workflowRunId !== null)?.workflowRunId ?? undefined;
  return { ...(tree && { headTree: tree }), ...(ciRunId !== undefined && { ciRunId }) };
}

/** What the brief names on disk: the packet dir, the clone from-ci reads git from, and the titan-review binary. */
interface PackagerPaths {
  packetDir: string;
  clone: string;
  bin: string;
}

/**
 * A head with no visual CI run, or a repo with no usable checkout, spawns no packager: from-ci needs both, and the prompt
 * would only have the packager stop BLOCKED. The throw is recorded as a failed spawn.
 */
function packagerPaths(ports: VisualPacketPorts, input: PacketInput, facts: PacketFacts, packetDir: string): PackagerPaths & { ciRunId: number } {
  if (facts.ciRunId === undefined) throw new Error(`no visual CI run at ${input.headSha}; a packager could only stop BLOCKED`);
  const checkout = resolveCheckout(input.repo, ports.cwdFor?.(input.repo));
  if ("problem" in checkout) throw new Error(checkout.problem);
  const bin = ports.titanReviewBin ?? defaultTitanReviewBin();
  return { packetDir, clone: checkout.dir, bin, ciRunId: facts.ciRunId };
}

/** from-ci replaces the whole packet dir, so it runs once and first; a re-run after prose.json would delete it. */
function packagerBrief(input: PacketInput, facts: PacketFacts, paths: PackagerPaths & { ciRunId: number }): string {
  const { packetDir, clone, bin, ciRunId } = paths;
  return [
    `Build the visual review packet for ${input.repo}#${input.pr} at head ${input.headSha}.`,
    "",
    `Repo: ${input.repo}`,
    `PR: ${input.pr}`,
    `Head: ${input.headSha}`,
    `Head tree: ${facts.headTree ?? "unknown"}`,
    `Shepherd run: ${input.runId}`,
    `Gate: ${input.gateId}`,
    `Visual CI run: ${ciRunId}`,
    `Packet dir: ${packetDir}`,
    `Clone: ${clone}`,
    `titan-review: ${bin}`,
    "",
    "Run titan-review by the absolute path above only; it may not be on your PATH.",
    `1. First, once: \`${bin} packet from-ci --repo ${input.repo} --pr ${input.pr} --head ${input.headSha} --run ${ciRunId} --clone ${clone} --out ${packetDir}\`. If it fails, stop BLOCKED with its stderr.`,
    `2. Run \`${bin} packet prompt\` and follow it to write \`${packetDir}/prose.json\`.`,
    "3. Never run from-ci again: it replaces the whole packet dir, prose.json with it. If the packet needs rebuilding, stop BLOCKED.",
    `4. Finish with \`${bin} packet lint ${packetDir} --gate-head ${input.headSha} --require prose --clone ${clone}\`. It must exit 0: fix prose.json until it does, or stop BLOCKED with its output.`,
  ].join("\n");
}

/** An agent already on the roster under this name is this head's packager, started before a crash lost the record. */
async function spawnPackager(ports: VisualPacketPorts, brief: string, paths: PackagerPaths, agent: string): Promise<void> {
  if (!ports.agents) throw new Error("no agent-chat is configured");
  if ((await ports.agents.roster()).some((row) => row.name === agent)) return;
  mkdirSync(paths.packetDir, { recursive: true });
  await ports.agents.spawn({ name: agent, profile: ports.profile, brief, cwd: paths.clone });
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Never throws: a refused spawn or a missing profile is recorded as failed, and the gate it precedes opens as usual. */
export async function visualPacket(port: GitHubPort, ports: VisualPacketPorts | undefined, input: PacketInput): Promise<PacketResult> {
  if (ports === undefined || ports.mode === "off") return { event: "visual-packet-off" };
  const packetDir = packetDirFor(ports.stateDir, input.runId, input.headSha);
  const recorded = { packetDir, agent: packagerName(input.runId, input.headSha), profile: ports.profile };
  try {
    const facts = await packetFacts(port, input);
    const paths = packagerPaths(ports, input, facts, packetDir);
    if (ports.mode === "shadow") return { event: "visual-packet-would-spawn", ...recorded, ...facts };
    await spawnPackager(ports, packagerBrief(input, facts, paths), paths, recorded.agent);
    return { event: "visual-packet-spawned", ...recorded, ...facts };
  } catch (error) {
    return { event: "visual-packet-spawn-failed", ...recorded, reason: messageOf(error) };
  }
}

export function visualPacketRoutes(deps: { port: GitHubPort; now: () => number; visualPacket?: VisualPacketPorts }): StepRoute[] {
  return [codeRoute(VISUAL_PACKET_STEP, deps.now, async (input: PacketInput) => visualPacket(deps.port, deps.visualPacket, input))];
}
