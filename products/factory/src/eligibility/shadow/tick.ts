import { buildSha } from "../../build-info.js";
import type { Verbs } from "../../cli-types.js";
import { configPath, loadConfig } from "../../config.js";
import { errorMessage } from "../../narrow.js";
import { activeWorkOrigin } from "../../shepherd/cleanup-ports.js";
import { isoWeek } from "../../shepherd/stats.js";
import { readLaneTasks, readShadowEligibility } from "../active-work.js";
import { admitLane, holdsFor, type Admission, type BackPressureLimits, type LaneSignals } from "../back-pressure.js";
import { limitsOf } from "../command.js";
import { laneComponents } from "../lane-components.js";
import { liveLaneSignals } from "../lane-signals.js";
import type { Eligibility } from "../rules.js";
import { policyFor, tickPorts, type TickPorts } from "./tick-ports.js";
import { HOLD_PROVIDERS, type HoldProvider, type TaskHold } from "./providers.js";
import type { LoadedRules, ShadowLane } from "./rule-file.js";
import type { RefusedRow, ShadowRow, WouldDispatchRow } from "./row.js";

/*
 * One shadow wake (TP-5755 S2): every configured lane judged by the same eligibility and admission `dispatch eligible`
 * uses, written as rows. It reads only; nothing here can start, message or spawn an agent.
 */

interface TickInput {
  loaded: LoadedRules;
  verbs: Verbs;
  now: Date;
  wake: string;
  providers?: readonly HoldProvider[];
  ports?: Partial<TickPorts>;
}

interface TickResult {
  rows: ShadowRow[];
  /** Lanes whose tasks or plan could not be read from active-work; each wrote one fail-closed row. */
  unreadLanes: number;
}

interface LaneRead {
  result: Eligibility;
  admission: Admission;
  signals: LaneSignals;
  limits: BackPressureLimits;
  planRead: "rpc" | "file";
}

type LaneBase = Omit<RefusedRow, "kind" | "task" | "stage" | "codes">;

type Eligible = Eligibility["eligible"][number];

const mergeNumbers = (all: readonly Record<string, number>[]): Record<string, number> => all.reduce<Record<string, number>>((merged, numbers) => ({ ...merged, ...numbers }), {});

async function readLane(lane: ShadowLane, input: TickInput, ports: TickPorts): Promise<LaneRead> {
  const { verbs, now } = input;
  const source = { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) };
  const scope = { initiative: lane.initiative, ...(lane.tag !== null && { tag: lane.tag }) };
  const query = { ...scope, week: isoWeek(now.getTime()), today: now.toISOString().slice(0, 10) };
  const context = { activeRoot: ports.activeRoot, policyFor: policyFor(input.loaded.rules, query.today, ports.stoppedPrs) };
  const [{ result, planRead }, laneTasks] = await Promise.all([readShadowEligibility(source, query, context), readLaneTasks(source, scope)]);
  const limits = limitsOf(loadConfig(configPath(verbs.io.env)));
  const signals = await (verbs.deps.laneSignals ?? liveLaneSignals(verbs))({ inLane: (key) => laneTasks.keys.has(key) });
  return { result, admission: admitLane(signals, limits, laneComponents(scope)), signals, limits, planRead };
}

/** Slots left under the lane's PR limit; a held lane has none, and an unread count reads as none. */
function freeSlots({ admission, signals, limits }: LaneRead): number {
  if (admission.decision === "hold" || signals.openPrs === undefined) return 0;
  return Math.max(0, limits.laneOpenPrs - signals.openPrs - (signals.mergedNotDeployed ?? 0));
}

/** A provider that cannot answer holds every eligible task, so an outage never reads as permission. */
async function providerHolds(providers: readonly HoldProvider[], lane: ShadowLane, input: TickInput, eligible: Eligible[]): Promise<TaskHold[]> {
  const ctx = { lane, week: isoWeek(input.now.getTime()), rules: input.loaded.rules, eligible, verbs: input.verbs };
  const holds: TaskHold[] = [];
  for (const provider of providers) {
    try {
      holds.push(...(await provider(ctx)).holds);
    } catch (error) {
      const detail = `hold provider ${provider.name || "(anonymous)"}: ${errorMessage(error)}`;
      holds.push(...eligible.map((entry): TaskHold => ({ task: `${lane.initiative}/${entry.task.id}`, stage: "admission", codes: ["signal-unreadable"], details: [detail] })));
    }
  }
  return holds;
}

function admissionHold(admission: Admission, entry: Eligible, key: string): TaskHold | undefined {
  const holds = holdsFor(admission, entry.task.owner_steps);
  if (holds.length === 0) return undefined;
  const numbers = mergeNumbers(holds.map((hold) => hold.numbers));
  return { task: key, stage: "admission", codes: [...new Set(holds.map((hold) => hold.code))], details: holds.map((hold) => hold.detail), numbers };
}

/** One row per held task: the first stage that held it, with every code from every stage. */
function heldRow(base: LaneBase, key: string, rank: number, holds: TaskHold[]): RefusedRow {
  const details = holds.flatMap((hold) => hold.details ?? []);
  const numbers = mergeNumbers(holds.map((hold) => hold.numbers ?? {}));
  const row: RefusedRow = { ...base, kind: "refused", task: key, stage: holds[0]!.stage, rank, codes: [...new Set(holds.flatMap((hold) => hold.codes))] };
  const next = holds.find((hold) => hold.next !== undefined)?.next;
  const ask = holds.some((hold) => hold.would_ask === true);
  return { ...row, ...(details.length > 0 && { details }), ...(Object.keys(numbers).length > 0 && { numbers }), ...(next && { next }), ...(ask && { would_ask: true }) };
}

function eligibilityRows(base: LaneBase, result: Eligibility): RefusedRow[] {
  return result.refused.map(({ id, refusals }) => ({
    ...base,
    kind: "refused",
    task: `${base.lane.initiative}/${id}`,
    stage: "eligibility",
    codes: [...new Set(refusals.map((refusal) => refusal.code))],
    details: refusals.map((refusal) => refusal.detail),
  }));
}

function candidateRows(base: LaneBase, read: LaneRead, extra: TaskHold[]): ShadowRow[] {
  const free = freeSlots(read);
  const numbers = { open: read.signals.openPrs ?? 0, mergedNotDeployed: read.signals.mergedNotDeployed ?? 0, limit: read.limits.laneOpenPrs, free };
  let slot = 0;
  return read.result.eligible.map((entry, at): ShadowRow => {
    const key = `${base.lane.initiative}/${entry.task.id}`;
    const relaxed = entry.relaxed === undefined ? {} : { relaxed: entry.relaxed, strict_codes: entry.strictCodes ?? [] };
    const holds = [admissionHold(read.admission, entry, key), ...extra.filter((hold) => hold.task === key)].filter((hold) => hold !== undefined);
    if (holds.length > 0) return { ...heldRow(base, key, at + 1, holds), ...relaxed };
    if (slot >= free) return { ...base, kind: "refused", task: key, stage: "admission", rank: at + 1, codes: ["lane-open-prs"], numbers, ...relaxed };
    slot += 1;
    const row: WouldDispatchRow = { ...base, kind: "would-dispatch", task: key, bet: entry.bet.id, rank: at + 1, slot, free, class: entry.task.class ?? null, ...relaxed };
    return row;
  });
}

function laneHoldRow(base: LaneBase, admission: Admission): RefusedRow {
  const holds = admission.holds.filter((hold) => hold.scope === "lane");
  const numbers = mergeNumbers(holds.map((hold) => hold.numbers));
  return { ...base, kind: "refused", task: null, stage: "admission", codes: [...new Set(holds.map((hold) => hold.code))], details: holds.map((hold) => hold.detail), numbers };
}

interface LaneJudged {
  rows: ShadowRow[];
  unread: boolean;
  planRead?: LaneRead["planRead"];
}

/** An initiative active-work withholds from agents is refused before any of its tasks is read, so not even a task key of it reaches a row. */
const ownerOnlyRow = (base: LaneBase): RefusedRow => ({
  ...base,
  kind: "refused",
  task: null,
  stage: "eligibility",
  codes: ["owner-only-initiative"],
  details: ["the initiative is not agent-visible"],
});

/** active-work's agent allow list, or why it could not be read; an unread list shows no lane. */
type AgentLanes = { read: ReadonlySet<string>; via?: "rpc" | "file" } | { unread: string };

async function readAgentLanes(ports: TickPorts, lanes: readonly ShadowLane[]): Promise<AgentLanes> {
  try {
    const { lanes: visible, read } = await ports.agentLanes(lanes.map((lane) => lane.initiative));
    return { read: visible, via: read };
  } catch (error) {
    return { unread: errorMessage(error) };
  }
}

const unreadRow = (base: LaneBase, detail: string): LaneJudged => {
  const row: RefusedRow = { ...base, kind: "refused", task: null, stage: "admission", codes: ["signal-unreadable"], details: [detail] };
  return { rows: [row], unread: true };
};

async function laneRows(lane: ShadowLane, input: TickInput, at: string, ports: TickPorts, agentLanes: AgentLanes): Promise<LaneJudged> {
  const base: LaneBase = { v: 1, wake: input.wake, at, lane: { initiative: lane.initiative, tag: lane.tag }, week: isoWeek(input.now.getTime()), basis: "selected" };
  if ("unread" in agentLanes) return unreadRow(base, `active-work inventory: ${agentLanes.unread}`);
  if (!agentLanes.read.has(lane.initiative)) return { rows: [ownerOnlyRow(base)], unread: false };
  let read: LaneRead;
  try {
    read = await readLane(lane, input, ports);
  } catch (error) {
    return unreadRow(base, `active-work: ${errorMessage(error)}`);
  }
  const extra = await providerHolds(input.providers ?? HOLD_PROVIDERS, lane, input, read.result.eligible);
  const rows: ShadowRow[] = [...eligibilityRows(base, read.result), ...candidateRows(base, read, extra)];
  if (read.admission.decision === "hold" && read.result.eligible.length === 0) rows.push(laneHoldRow(base, read.admission));
  return { rows, unread: false, planRead: read.planRead };
}

const wakePlanRead = (reads: readonly LaneJudged["planRead"][]): { plan_read?: "rpc" | "file" } =>
  reads.includes("file") ? { plan_read: "file" } : reads.includes("rpc") ? { plan_read: "rpc" } : {};

/** Every row of one wake, the wake row first; reads only and writes nothing. */
export async function shadowTick(input: TickInput): Promise<TickResult> {
  const at = input.now.toISOString();
  const { rules, hash } = input.loaded;
  const ports = tickPorts(input.verbs, input.ports);
  const agentLanes = rules.lanes.length === 0 ? { read: new Set<string>() } : await readAgentLanes(ports, rules.lanes);
  const judged: LaneJudged[] = [];
  for (const lane of rules.lanes) judged.push(await laneRows(lane, input, at, ports, agentLanes));
  const reads = { ...wakePlanRead(judged.map((lane) => lane.planRead)), ...("via" in agentLanes && { visibility_read: agentLanes.via }) };
  const wake: ShadowRow = { v: 1, kind: "wake", wake: input.wake, at, build: buildSha(), rule_hash: hash, lanes: rules.lanes.length, ...reads };
  return { rows: [wake, ...judged.flatMap((lane) => lane.rows)], unreadLanes: judged.filter((lane) => lane.unread).length };
}
