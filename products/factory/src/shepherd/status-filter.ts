import { PhaseSchema, type Phase } from "./step-phase.js";
import type { WatchRow } from "./view.js";

/** The phases a run never leaves; `--active` drops them. */
const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(["done", "failed", "cancelled"]);

/** The `shepherd status` filters as commander parses them onto the verb's options. */
export interface StatusFilter {
  active?: boolean;
  phase?: readonly Phase[];
  branchPrefix?: string;
  task?: string;
}

const AGENT_CHAT_BRANCH = "agent-chat/";

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

export function filterRows<Row extends Pick<WatchRow, "phase" | "branch" | "task">>(rows: readonly Row[], filter: StatusFilter): Row[] {
  return rows.filter((row) => keeps(row, filter));
}

function keeps(row: Pick<WatchRow, "phase" | "branch" | "task">, { active, phase, branchPrefix, task }: StatusFilter): boolean {
  if (active && TERMINAL_PHASES.has(row.phase)) return false;
  if (phase && !phase.includes(row.phase)) return false;
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
