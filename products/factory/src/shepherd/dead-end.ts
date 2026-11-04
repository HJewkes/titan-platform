import type { AgentRow } from "@titan-design/agent-dispatch";
import { RESOLVER_CLASSES } from "@titan-design/authority";
import type { GateRule } from "@titan-design/hitl";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { DEAD_END_GATE } from "../coordinator-evidence.js";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { WAIVE_PROOF, deadEndDecision, type DeadEndAnswer } from "../gate-brief.js";
import { readPath } from "../narrow.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import { awaitNewHead } from "./gates.js";
import { waiveProof } from "./proof-waiver.js";
import type { ShepherdDeps } from "./phases.js";
import { REPLAN_STEPS, requestReplan, type FailedSession } from "./replan.js";
import { registrantSeat, spawnerSeat, storedLineage } from "./registrant.js";
import type { Escalated } from "./route-table.js";
import type { GateRun } from "./run-state.js";
import { askAtHead } from "./stale-gates.js";
import { noticeHeldSeat } from "./gate-route.js";

/**
 * TP-4759 (owner decision 552): a run that reaches one of these ends asks the seat that registered its PR, not the owner.
 * `GATE_DEMOTIONS.deadEndSeat` routes them here.
 */
export const DEAD_END_KINDS = ["exited-without-push", "fix-first-runaway", "failed-rounds"] as const;
type DeadEndKind = (typeof DEAD_END_KINDS)[number];

const ADDRESS_STEP = "sh-dead-end-address";
export const DEAD_END_STEPS: readonly StepDeclaration[] = [
  { id: ADDRESS_STEP, kind: "dispatch" },
  { id: DEAD_END_GATE, kind: "assisted" },
  ...REPLAN_STEPS,
];

/** The table a dead-end gate's rule names; the owner inbox leaves its gates to the seat. Not `shepherd-seat`, the seat policy's own table. */
export const DEAD_END_TABLE = "shepherd-dead-end";

/** Respawns a run may take before the gate stops offering one: a worker that keeps exiting needs another answer. */
const RESPAWN_CAP = 2;

/**
 * hitl lets only the owner classes, read at open time, or a coordinator answer, and the factory's `authorize` admits the
 * coordinator only on seat-dead-end evidence.
 */
export function deadEndRule(kind: DeadEndKind): GateRule {
  return { table: DEAD_END_TABLE, version: "1", ruleId: `dead-end/${kind}`, resolvers: [...RESOLVER_CLASSES], delegates: ["coordinator"] };
}

type Lineage = Parameters<typeof registrantSeat>[0];

/** The registrant (or its fixer lineage's live seat), else the live seat that spawned it, else the repo's one seat. */
function deadEndSeat(lineage: Lineage | undefined, roster: readonly AgentRow[] | undefined, repoSeat: string | undefined): string | undefined {
  return (lineage && (registrantSeat(lineage, roster) ?? spawnerSeat(lineage, roster))) ?? repoSeat;
}

/** What the address step reads; a lineage that cannot be read throws, and the run then takes the owner gate. */
interface DeadEndPorts {
  lineage(target: { repo: string; pr: number }): Lineage | undefined;
  roster(): Promise<readonly AgentRow[]>;
  repoSeat(repo: string): string | undefined;
}

const AddressInput = z.object({ repo: z.string().min(1), pr: z.number().int().positive(), kind: z.enum(DEAD_END_KINDS), headSha: z.string().min(1) });
const AddressResult = z.looseObject({ seat: z.string().nullable(), kind: z.enum(DEAD_END_KINDS), headSha: z.string() });

async function address(ports: DeadEndPorts | undefined, target: { repo: string; pr: number }): Promise<string | undefined> {
  if (ports === undefined) return undefined;
  const lineage = ports.lineage(target);
  return deadEndSeat(lineage, lineage?.registrant ? await ports.roster() : undefined, ports.repoSeat(target.repo));
}

/** Serve's ports: the run's stored lineage, serve's roster and the exit notice's seat book. With neither wired, no seat. */
function deadEndPorts({ store, roster, exitNotice }: Pick<ShepherdDeps, "store" | "roster" | "exitNotice">): DeadEndPorts | undefined {
  if (roster === undefined || exitNotice === undefined) return undefined;
  return { lineage: (target) => storedLineage(store, target), roster: () => roster.rows(), repoSeat: (repo) => exitNotice.seatFor(repo) };
}

export const deadEndAddressRoute = (now: () => number, ports: DeadEndPorts | undefined): StepRoute =>
  codeRoute(ADDRESS_STEP, now, async (raw: unknown) => {
    const input = AddressInput.parse(raw);
    const seat = await address(ports, input).catch(() => undefined);
    return { seat: seat ?? null, kind: input.kind, headSha: input.headSha };
  });

export const deadEndRoute = (deps: Pick<ShepherdDeps, "now" | "store" | "roster" | "exitNotice">): StepRoute => deadEndAddressRoute(deps.now, deadEndPorts(deps));

/** The seat the run addressed its dead-end gate at `headSha` to, from its own record; the evidence reader's source. */
export function addressedSeat(run: WorkflowRun, headSha: string): string | undefined {
  const addresses = Object.values(run.stepResults).filter((result) => stepIdMatches(ADDRESS_STEP, result.stepId));
  const recorded = addresses.map((result) => AddressResult.safeParse(readPath(result.data, "result"))).flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  return recorded.filter((entry) => entry.headSha === headSha).at(-1)?.seat ?? undefined;
}

interface DeadEnd {
  kind: DeadEndKind;
  headSha: string;
  situation: string;
  /** A fix-proof exit, where the owner may still waive the proof. */
  waivable?: boolean;
  /** What a replan brief names: the run's task, the worker sessions that ended here, and the FIX_FIRST trail. */
  task?: string;
  sessions?: readonly FailedSession[];
  trail?: readonly string[];
}

type DeadEndRun = GateRun & { escalations?: Map<string, Escalated> };

/** Respawns answered per run; a replay of the run's answers rebuilds the count. */
const respawns = new WeakMap<object, number>();

function offered(run: DeadEndRun, end: DeadEnd): DeadEndAnswer[] {
  const respawn: DeadEndAnswer[] = (respawns.get(run.ctx) ?? 0) < RESPAWN_CAP ? ["respawn"] : [];
  // Only an exit is waivable and only a route kind merges, so the menu stays within hitl's four options.
  const waive: DeadEndAnswer[] = end.waivable && end.kind === "exited-without-push" ? [WAIVE_PROOF] : [];
  const merge: DeadEndAnswer[] = end.kind === "exited-without-push" ? [] : ["owner-merge"];
  const owner = [...waive, ...merge];
  return [...respawn, "replan", "abandon", ...owner];
}

/** Respawn while the cap allows, then replan; a refused replan spawn recommends neither again at this head. */
function recommended(answers: readonly DeadEndAnswer[], replanRefused: boolean): DeadEndAnswer | undefined {
  if (answers.includes("respawn")) return "respawn";
  return replanRefused ? undefined : "replan";
}

interface Addressed {
  seat: string;
  situation: string;
}

async function askSeat(run: DeadEndRun, end: DeadEnd, { seat, situation }: Addressed, replanRefused: boolean): Promise<DeadEndAnswer | undefined> {
  const { headSha, kind } = end;
  const answers = offered(run, end);
  const { schema, brief } = deadEndDecision({ ...run.target, headSha, situation: end.situation, seat, offered: answers, recommend: recommended(answers, replanRefused) });
  const prompt = `PR #${run.target.pr} in ${run.target.repo} at head ${headSha} reached a dead end (${kind}): ${situation}. Seat ${seat} answers: ${answers.join(", ")}?`;
  const answered = await askAtHead(run.ctx, DEAD_END_GATE, prompt, { schema, brief, rule: deadEndRule(kind) });
  return answered && schema.parse(answered.data).decision;
}

/** True once the planner is spawned; a refused spawn tells the seat why, so its next answer is an informed one. */
async function replanned(run: DeadEndRun, end: DeadEnd, { seat, situation }: Addressed, attempt: number): Promise<boolean> {
  const { headSha, kind, task, sessions, trail } = end;
  const replan = await requestReplan(run, { headSha, kind, situation, seat, ...(task !== undefined && { task }), ...(sessions && { sessions }), ...(trail && { trail }) });
  if (replan.spawned) return true;
  const why = `${situation}; the replan planner ${replan.agent} was not spawned (${replan.reason ?? "no reason given"}), so Shepherd asks again`;
  await noticeHeldSeat(run, JSON.stringify(["sh-replan-refused", headSha, attempt]), { headSha, why, seat, gate: "dead-end" });
  return false;
}

/**
 * Records the addressee, then asks it at the head. With no seat, `ownerGate` opens today's owner gate unchanged. Undefined
 * lands the next round: after a respawn or a spawned replan once a new head shows, after an owner answer at once, and
 * after a moved head. A refused replan asks again at the same head.
 */
export async function deadEndGate(run: DeadEndRun, end: DeadEnd, ownerGate: () => Promise<LandOutcome | undefined>): Promise<LandOutcome | undefined> {
  const { headSha, kind } = end;
  const { seat } = await step(run.ctx, ADDRESS_STEP, { ...run.target, kind, headSha }, AddressResult);
  if (seat === null) return ownerGate();
  const addressed = { seat, situation: end.situation.replace(/[.\s]+$/, "") };
  await noticeHeldSeat(run, JSON.stringify([DEAD_END_GATE, headSha]), { headSha, why: addressed.situation, seat, gate: "dead-end" });
  for (let attempt = 0; ; attempt += 1) {
    const decision = await askSeat(run, end, addressed, attempt > 0);
    if (decision !== "replan") return decision && onAnswer(run, headSha, decision);
    if (await replanned(run, end, addressed, attempt)) return awaitNewHead(run, headSha);
  }
}

async function onAnswer(run: DeadEndRun, headSha: string, decision: DeadEndAnswer): Promise<LandOutcome | undefined> {
  if (decision === "abandon") return { kind: "stopped", reason: "abandoned", headSha, detail: `the dead-end gate at ${headSha} was answered abandon` };
  if (decision === WAIVE_PROOF) {
    await waiveProof(run.ctx, headSha);
    run.reviews?.delete(headSha);
    return undefined;
  }
  if (decision === "owner-merge") {
    run.carried = undefined;
    run.escalations?.delete(headSha);
    return undefined;
  }
  respawns.set(run.ctx, (respawns.get(run.ctx) ?? 0) + 1);
  return awaitNewHead(run, headSha);
}
