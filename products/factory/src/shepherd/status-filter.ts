import { PhaseSchema, type Phase } from "./step-phase.js";
import type { WatchRow } from "./view.js";

/** The phases a run never leaves; `--active` drops them. */
export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(["done", "failed", "cancelled"]);

export interface StatusFilter {
  active?: boolean;
  phases?: readonly Phase[];
  branchPrefix?: string;
  task?: string;
}

/** The `shepherd status` flags as commander parses them. */
export interface StatusFlags {
  active?: boolean;
  phase?: string;
  branchPrefix?: string;
  task?: string;
}

export type Narrow = (data: unknown) => unknown;
export const unfiltered: Narrow = (data) => data;

const AGENT_CHAT_BRANCH = "agent-chat/";

/** No flag leaves the data untouched, so a script reading plain `status` sees exactly what serve sent. */
export function statusNarrow({ active, phase, branchPrefix, task }: StatusFlags): Narrow {
  const filter: StatusFilter = { active, phases: phase === undefined ? undefined : parsePhases(phase), branchPrefix, task };
  if (Object.values(filter).every((value) => value === undefined)) return unfiltered;
  return (data) => (Array.isArray(data) ? filterRows(data, filter) : data);
}

/** Parses `--phase a,b`; an unknown phase throws naming the valid ones, so a typo never silently matches nothing. */
export function parsePhases(list: string): Phase[] {
  const names = list.split(",").map((name) => name.trim()).filter(Boolean);
  const phases = names.flatMap((name) => {
    const parsed = PhaseSchema.safeParse(name);
    return parsed.success ? [parsed.data] : [];
  });
  const unknown = names.filter((name) => !PhaseSchema.safeParse(name).success);
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(`unknown phase ${JSON.stringify(unknown.join(",") || list)}; expected one or more of ${PhaseSchema.options.join(", ")}`);
  }
  return phases;
}

/** Applied by the CLI after the rows come back, so an older serve that ignores unknown args still filters. */
export function filterRows<Row extends Pick<WatchRow, "phase" | "branch" | "task">>(rows: readonly Row[], filter: StatusFilter): Row[] {
  return rows.filter((row) => keeps(row, filter));
}

function keeps(row: Pick<WatchRow, "phase" | "branch" | "task">, { active, phases, branchPrefix, task }: StatusFilter): boolean {
  if (active && TERMINAL_PHASES.has(row.phase)) return false;
  if (phases && !phases.includes(row.phase)) return false;
  if (branchPrefix !== undefined && !branchMatches(row.branch, branchPrefix)) return false;
  return task === undefined || taskMatches(row.task, task);
}

function branchMatches(branch: string, prefix: string): boolean {
  const bare = branch.startsWith(AGENT_CHAT_BRANCH) ? branch.slice(AGENT_CHAT_BRANCH.length) : branch;
  return branch.startsWith(prefix) || bare.startsWith(prefix);
}

/** `TP-1` matches `titan-platform/TP-1`; a qualified `slug/ID` must match the whole task. */
function taskMatches(rowTask: string, wanted: string): boolean {
  const row = rowTask.toLowerCase();
  const want = wanted.toLowerCase();
  return want.includes("/") ? row === want : row === want || row.endsWith(`/${want}`);
}
