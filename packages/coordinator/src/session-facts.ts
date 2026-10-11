import { z } from "zod";
import type { SeatState } from "./seat-state.js";

const taskId = z.string().min(1);

export const sessionFactsPrSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  taskId,
});

/** One generated session record: a seat generation's work inside a single initiative. */
export const sessionFactsSchema = z.object({
  scope: z.string().min(1),
  generation: z.number().int().nonnegative(),
  mergedPrs: z.array(sessionFactsPrSchema),
  closedTasks: z.array(taskId),
  filedTasks: z.array(taskId),
});

export type SessionFacts = z.infer<typeof sessionFactsSchema>;

/** What the seat did in one generation; SeatState itself carries no PR or task outcomes. */
export interface SeatGenerationActivity {
  mergedPrs: readonly { repo: string; number: number; agent: string }[];
  closedTasks: readonly string[];
  filedTasks: readonly string[];
}

/** Task-id prefix (`TP`) to initiative scope. */
export type PrefixScopes = Readonly<Record<string, string>>;

const prefixOfTask = (id: string): string => id.replace(/-\d+$/, "").toUpperCase();

const emptyFacts = (scope: string, generation: number): SessionFacts => ({
  scope,
  generation,
  mergedPrs: [],
  closedTasks: [],
  filedTasks: [],
});

// PRs carry no task id of their own; the agent that opened one is named after its task.
function taskIdInAgent(agent: string, prefixes: readonly string[]): string | undefined {
  for (const prefix of prefixes) {
    const match = new RegExp(`(?:^|-)${prefix}-(\\d+)(?:-|$)`, "i").exec(agent);
    if (match) return `${prefix.toUpperCase()}-${match[1]}`;
  }
  return undefined;
}

function addTask(
  records: Map<string, SessionFacts>,
  generation: number,
  scopes: PrefixScopes,
  id: string,
  field: "closedTasks" | "filedTasks",
): void {
  const scope = scopes[prefixOfTask(id)];
  if (scope === undefined) return;
  const record = records.get(scope) ?? emptyFacts(scope, generation);
  records.set(scope, { ...record, [field]: [...record[field], id] });
}

function addPr(
  records: Map<string, SessionFacts>,
  generation: number,
  scopes: PrefixScopes,
  pr: SeatGenerationActivity["mergedPrs"][number],
): void {
  const id = taskIdInAgent(pr.agent, Object.keys(scopes));
  if (id === undefined) return;
  const scope = scopes[prefixOfTask(id)]!;
  const record = records.get(scope) ?? emptyFacts(scope, generation);
  const entry = { repo: pr.repo, number: pr.number, taskId: id };
  records.set(scope, { ...record, mergedPrs: [...record.mergedPrs, entry] });
}

/**
 * Projects one seat generation to a record per initiative it touched, sorted by scope. Work whose
 * prefix or agent name maps to no scope is dropped. Pure: no I/O.
 */
export function projectSeatGeneration(
  state: SeatState,
  activity: SeatGenerationActivity,
  scopes: PrefixScopes,
): SessionFacts[] {
  const records = new Map<string, SessionFacts>();
  const { generation } = state;
  activity.mergedPrs.forEach((pr) => addPr(records, generation, scopes, pr));
  activity.closedTasks.forEach((id) => addTask(records, generation, scopes, id, "closedTasks"));
  activity.filedTasks.forEach((id) => addTask(records, generation, scopes, id, "filedTasks"));
  return [...records.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}
