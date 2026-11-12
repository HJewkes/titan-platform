import type { ScorecardActuals, ScorecardGate, ScorecardLabels, ScorecardPr, ScorecardRun, TaskRowInput } from "@titan-design/session-analytics";
import type { Indexes, RowSources } from "./load.js";
import { readGates, readRunSteps, readSuccessors, type Registration } from "./read-factory.js";
import { prKey, readActuals, readPrs } from "./read-graph.js";
import { labelsFor } from "./read-labels.js";
import type { TaskFacts } from "./read-tasks.js";
import { scorecardRun } from "./run-facts.js";

/** Follow-ups read from `follow-up:` tags; the tag is exact, but the backfill marks it inferred until F4 records `source_ref`. */
const FOLLOW_UP_ORIGIN = "inferred:follow-up-tag";

interface FactoryFacts {
  runs: Map<string, ScorecardRun>;
  gates: Map<string, ScorecardGate[]>;
}

function factoryFacts(s: RowSources, regs: readonly Registration[]): FactoryFacts {
  const runIds = [...new Set(regs.map((r) => r.runId))].sort();
  const steps = readRunSteps(s.factory, runIds);
  const successors = readSuccessors(s.factory, runIds);
  const runs = new Map<string, ScorecardRun>();
  for (const [runId, run] of steps) {
    const reviewRounds = s.perRun.get(runId)?.reviewRounds ?? 0;
    runs.set(runId, scorecardRun(runId, run, successors.get(runId) ?? [], reviewRounds));
  }
  return { runs, gates: readGates(s.factory, runIds) };
}

function labelsOf(s: RowSources, idx: Indexes, task: TaskFacts): ScorecardLabels {
  const children = (idx.childrenOf.get(task.id) ?? []).map((c) => ({ taskId: c.id, estimate: c.estimate }));
  return { ...labelsFor(s.labels, task.initiative, task.id), followUps: { value: children, origin: FOLLOW_UP_ORIGIN } };
}

interface Joined {
  factory: FactoryFacts;
  prs: Map<string, ScorecardPr>;
  actuals: Map<string, ScorecardActuals>;
}

function inputFor(s: RowSources, idx: Indexes, task: TaskFacts, joined: Joined): TaskRowInput {
  const regs = idx.regsByKey.get(task.key) ?? [];
  const prs = regs.flatMap((r) => (r.pr === null ? [] : [joined.prs.get(prKey(r.repo, r.pr))].filter((p): p is ScorecardPr => p !== undefined)));
  const actuals = joined.actuals.get(task.key);
  return {
    task: { initiative: task.initiative, taskId: task.id, createdAt: task.createdAt, doneAt: task.doneAt, estimate: task.estimate },
    spawns: idx.spawnsByKey.get(task.key) ?? [],
    registrations: regs.flatMap((r) => (r.pr === null ? [] : [{ repo: r.repo, pr: r.pr }])),
    runs: regs.flatMap((r) => [joined.factory.runs.get(r.runId)].filter((run): run is ScorecardRun => run !== undefined)),
    gates: regs.flatMap((r) => joined.factory.gates.get(r.runId) ?? []),
    prs,
    labels: labelsOf(s, idx, task),
    ...(actuals === undefined ? {} : { actuals }),
  };
}

/** The row inputs of each task named, read from every store in one batch per store. */
export function assembleInputs(s: RowSources, idx: Indexes, keys: ReadonlySet<string>): Map<string, TaskRowInput> {
  const tasks = [...keys].sort().flatMap((key) => [s.tasks.tasks.get(key)].filter((t): t is TaskFacts => t !== undefined));
  const regs = tasks.flatMap((t) => idx.regsByKey.get(t.key) ?? []);
  const initiatives = [...new Set(tasks.map((t) => t.initiative))];
  const joined: Joined = { factory: factoryFacts(s, regs), prs: readPrs(s.graph), actuals: readActuals(s.graph, tasks, initiatives) };
  return new Map(tasks.map((task) => [task.key, inputFor(s, idx, task, joined)]));
}
