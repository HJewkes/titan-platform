import { buildSha } from "../../build-info.js";
import type { Verbs } from "../../cli-types.js";
import { configPath, loadConfig } from "../../config.js";
import { errorMessage } from "../../narrow.js";
import { activeWorkOrigin } from "../../shepherd/cleanup-ports.js";
import { isoWeek } from "../../shepherd/stats.js";
import { readEligibility, readLaneTasks } from "../active-work.js";
import { admitLane, holdsFor, type Admission, type BackPressureLimits, type LaneSignals } from "../back-pressure.js";
import { limitsOf } from "../command.js";
import { laneComponents } from "../lane-components.js";
import { liveLaneSignals } from "../lane-signals.js";
import type { Eligibility } from "../rules.js";
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
}

type LaneBase = Omit<RefusedRow, "kind" | "task" | "stage" | "codes">;

type Eligible = Eligibility["eligible"][number];

const mergeNumbers = (all: readonly Record<string, number>[]): Record<string, number> => all.reduce<Record<string, number>>((merged, numbers) => ({ ...merged, ...numbers }), {});

async function readLane(lane: ShadowLane, verbs: Verbs, now: Date): Promise<LaneRead> {
  const source = { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) };
  const scope = { initiative: lane.initiative, ...(lane.tag !== null && { tag: lane.tag }) };
  const query = { ...scope, week: isoWeek(now.getTime()), today: now.toISOString().slice(0, 10) };
  const [result, laneTasks] = await Promise.all([readEligibility(source, query), readLaneTasks(source, scope)]);
  const limits = limitsOf(loadConfig(configPath(verbs.io.env)));
  const signals = await (verbs.deps.laneSignals ?? liveLaneSignals(verbs))({ inLane: (key) => laneTasks.keys.has(key) });
  return { result, admission: admitLane(signals, limits, laneComponents(scope)), signals, limits };
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
  return { ...row, ...(details.length > 0 && { details }), ...(Object.keys(numbers).length > 0 && { numbers }) };
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
    const holds = [admissionHold(read.admission, entry, key), ...extra.filter((hold) => hold.task === key)].filter((hold) => hold !== undefined);
    if (holds.length > 0) return heldRow(base, key, at + 1, holds);
    if (slot >= free) return { ...base, kind: "refused", task: key, stage: "admission", rank: at + 1, codes: ["lane-open-prs"], numbers };
    slot += 1;
    const row: WouldDispatchRow = { ...base, kind: "would-dispatch", task: key, bet: entry.bet.id, rank: at + 1, slot, free, class: entry.task.class ?? null };
    return row;
  });
}

function laneHoldRow(base: LaneBase, admission: Admission): RefusedRow {
  const holds = admission.holds.filter((hold) => hold.scope === "lane");
  const numbers = mergeNumbers(holds.map((hold) => hold.numbers));
  return { ...base, kind: "refused", task: null, stage: "admission", codes: [...new Set(holds.map((hold) => hold.code))], details: holds.map((hold) => hold.detail), numbers };
}

async function laneRows(lane: ShadowLane, input: TickInput, at: string): Promise<{ rows: ShadowRow[]; unread: boolean }> {
  const base: LaneBase = { v: 1, wake: input.wake, at, lane: { initiative: lane.initiative, tag: lane.tag }, week: isoWeek(input.now.getTime()), basis: "selected" };
  let read: LaneRead;
  try {
    read = await readLane(lane, input.verbs, input.now);
  } catch (error) {
    return { rows: [{ ...base, kind: "refused", task: null, stage: "admission", codes: ["signal-unreadable"], details: [`active-work: ${errorMessage(error)}`] }], unread: true };
  }
  const extra = await providerHolds(input.providers ?? HOLD_PROVIDERS, lane, input, read.result.eligible);
  const rows: ShadowRow[] = [...eligibilityRows(base, read.result), ...candidateRows(base, read, extra)];
  if (read.admission.decision === "hold" && read.result.eligible.length === 0) rows.push(laneHoldRow(base, read.admission));
  return { rows, unread: false };
}

/** Every row of one wake, the wake row first; reads only and writes nothing. */
export async function shadowTick(input: TickInput): Promise<TickResult> {
  const at = input.now.toISOString();
  const { rules, hash } = input.loaded;
  const rows: ShadowRow[] = [{ v: 1, kind: "wake", wake: input.wake, at, build: buildSha(), rule_hash: hash, lanes: rules.lanes.length }];
  let unreadLanes = 0;
  for (const lane of rules.lanes) {
    const judged = await laneRows(lane, input, at);
    rows.push(...judged.rows);
    if (judged.unread) unreadLanes += 1;
  }
  return { rows, unreadLanes };
}
