import { join } from "node:path";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { PrVisualFrames, VisualPacketPorts } from "./spawn-ports.js";
import { landGateHead } from "./approval-carry.js";
import type { GateRun } from "./run-state.js";
import type { OwnerGateReason } from "./policy-schema.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { visualAcceptHead } from "./visual-accept.js";
import { nothingToSee, routeEmptyVisualRun, visualRunFacts, type VisualRunFacts } from "./visual-run-empty.js";

const VISUAL_PACKET_STEP = "sh-visual-packet";
export const VISUAL_PACKET_STEPS: readonly StepDeclaration[] = [{ id: VISUAL_PACKET_STEP, kind: "dispatch" }];

export const DEFAULT_PACKAGER_PROFILE = "review-packager";

const PacketEvent = z.enum(["visual-packet-off", "visual-packet-would-spawn", "visual-packet-spawned", "visual-packet-spawn-failed", "visual-run-empty"]);
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

/**
 * A land approve-merge gate under the visual-path guard, any land gate of a run its seat registered for Gate 2 visual
 * sign-off, or the owner's ask to accept the baselines CI regenerated at a red head.
 */
export function isVisualGate(stepId: string, prompt: string, ownerGateReason: OwnerGateReason | undefined): string | undefined {
  const accept = visualAcceptHead(stepId, prompt);
  if (accept !== undefined) return accept;
  const head = landGateHead(stepId, prompt);
  return head !== undefined && (VISUAL_RULE.test(prompt) || ownerGateReason === "gate-2-visual") ? head : undefined;
}

/** What the trigger reads from the run: its target, the policy as narrowed so far, and the waits an empty run spends. */
export interface PacketRun extends GateRun {
  ownerGateReason: () => OwnerGateReason | undefined;
}

/**
 * Wraps `assisted` so a visual gate records its packet step first. The gate opens whatever the step recorded, unless
 * the step found the head's pr-visual run empty (TP-6776): then the seat hears and no owner gate opens.
 */
export function packetTriggering(run: PacketRun, assisted: WorkflowContext["assisted"]): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    const packet = await recordPacket(run, stepId, prompt);
    if (packet?.event !== "visual-run-empty" || packet.headSha === undefined) return assisted(stepId, prompt, options);
    return routeEmptyVisualRun(run, stepId, packet.headSha, packet.reason ?? "the pr-visual run was empty", (note) => assisted(stepId, `${prompt}${note}`, options));
  };
}

/** Records a visual gate's packet step; any other gate records nothing. */
export async function packetBeforeGate(run: Pick<PacketRun, "ctx" | "target" | "ownerGateReason">, stepId: string, prompt: string): Promise<void> {
  await recordPacket(run, stepId, prompt);
}

/** The packet step a visual gate recorded, with its head; any other gate, or a step skipped, records nothing. */
async function recordPacket(run: Pick<PacketRun, "ctx" | "target" | "ownerGateReason">, stepId: string, prompt: string): Promise<(PacketResult & { headSha?: string }) | undefined> {
  const headSha = isVisualGate(stepId, prompt, run.ownerGateReason());
  if (headSha === undefined) return undefined;
  const packet = await triggerPacket(run, stepId, headSha);
  return packet && { ...packet, headSha };
}

/**
 * One packet step per head, keyed by the head, so a second gate at it, a replay and a restart each find the record and
 * spawn nothing. A record that goes on to something else predates the step, and a run resumed on a pending gate opened
 * it before the step existed; neither records one now, as the replay would diverge.
 */
async function triggerPacket(run: Pick<PacketRun, "ctx" | "target">, gateStep: string, headSha: string): Promise<PacketResult | undefined> {
  const { ctx } = run;
  const stepId = `${VISUAL_PACKET_STEP}:${headSha}`;
  const next = ctx.historyNext();
  if (ctx.iteration(stepId) > 0 || (next !== undefined && next !== stepId)) return undefined;
  const resumed = ctx.resumedGate();
  if (next === undefined && resumed !== undefined && stepIdMatches(gateStep, resumed)) return undefined;
  const index = ctx.iteration(gateStep);
  const gateId = `${ctx.runId}/${index === 0 ? gateStep : `${gateStep}:${index}`}`;
  return step(ctx, stepId, { runId: ctx.runId, ...run.target, headSha, gateId } satisfies PacketInput, PacketResult);
}

export function packetDirFor(stateDir: string, runId: string, headSha: string): string {
  return join(stateDir, "packets", runId, headSha);
}

/** Unique per run and head, and one argv word agent-chat takes as a name. */
export function packagerName(runId: string, headSha: string): string {
  return `packager-${headSha.slice(0, 8)}-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

interface PacketFacts extends VisualRunFacts {
  headTree?: string;
  ciRunId?: number;
}

/** Each read is best effort: a fact GitHub would not give is left out, and the packager looks it up. */
async function packetFacts(port: GitHubPort, input: PacketInput, frames?: PrVisualFrames): Promise<PacketFacts> {
  const tree = await port.getCommit(input.repo, input.headSha).then((commit) => commit.tree, () => undefined);
  const runs = await port.checkRuns(input.repo, input.headSha).catch(() => []);
  const ciRunId = runs.find((run) => /visual/i.test(run.name) && run.headSha === input.headSha && run.workflowRunId !== null)?.workflowRunId ?? undefined;
  const visualRun = await visualRunFacts(runs, input.repo, input.headSha, frames);
  return { ...(tree && { headTree: tree }), ...(ciRunId !== undefined && { ciRunId }), ...visualRun };
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
  const bin = ports.titanReviewBin;
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
  ports.makeDir(paths.packetDir);
  await ports.agents.spawn({ name: agent, profile: ports.profile, brief, cwd: paths.clone });
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Only an approve-merge gate can find its run empty: the regenerated-baselines ask stands at a red head by design, and
 * its packager reads that same failed pr-visual run.
 */
function emptyBeforeApproval(input: PacketInput, facts: VisualRunFacts): string | undefined {
  const gateStep = input.gateId.slice(input.runId.length + 1);
  return stepIdMatches("approve-merge", gateStep) ? nothingToSee(facts) : undefined;
}

/**
 * Never throws: a refused spawn or a missing profile is recorded as failed, and the gate it precedes opens as usual. An
 * empty pr-visual run before approve-merge is recorded whatever the mode, with no packager, as there is nothing to package.
 */
export async function visualPacket(port: GitHubPort, ports: VisualPacketPorts | undefined, input: PacketInput, frames?: PrVisualFrames): Promise<PacketResult> {
  const facts = await packetFacts(port, input, frames);
  const empty = emptyBeforeApproval(input, facts);
  if (empty !== undefined) return { event: "visual-run-empty", reason: empty, ...facts };
  if (ports === undefined || ports.mode === "off") return { event: "visual-packet-off" };
  const packetDir = packetDirFor(ports.stateDir, input.runId, input.headSha);
  const recorded = { packetDir, agent: packagerName(input.runId, input.headSha), profile: ports.profile };
  try {
    const paths = packagerPaths(ports, input, facts, packetDir);
    if (ports.mode === "shadow") return { event: "visual-packet-would-spawn", ...recorded, ...facts };
    await spawnPackager(ports, packagerBrief(input, facts, paths), paths, recorded.agent);
    return { event: "visual-packet-spawned", ...recorded, ...facts };
  } catch (error) {
    return { event: "visual-packet-spawn-failed", ...recorded, reason: messageOf(error) };
  }
}

export function visualPacketRoutes(deps: { port: GitHubPort; now: () => number; visualPacket?: VisualPacketPorts; prVisualFrames?: PrVisualFrames }): StepRoute[] {
  return [codeRoute(VISUAL_PACKET_STEP, deps.now, async (input: PacketInput) => visualPacket(deps.port, deps.visualPacket, input, deps.prVisualFrames))];
}
