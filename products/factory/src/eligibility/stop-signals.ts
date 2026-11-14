import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TaskSchema, type Task } from "@titan-design/pm";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { readTaskRows } from "@titan-design/session-analytics";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { Verbs } from "../cli-types.js";
import { stepIdMatches } from "../definition.js";
import { EXIT } from "../exit-codes.js";
import { errorMessage } from "../narrow.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { ShepherdStore, type Registration } from "../shepherd/store.js";
import { watchRow } from "../shepherd/view.js";
import { AWAIT_NEW_HEAD_STEP } from "../shepherd/wake.js";
import type { Eligibility } from "./rules.js";
import type { RuleFile } from "./shadow/rule-file.js";
import { stopRuleHolds, type SpendRead, type StopHold, type StopMarks, type StopSignals, type TaskRun } from "./stop-rules.js";

/*
 * What the stop rules read (TP-5755 S6): Shepherd's runs, the initiative's tasks, the ticket scorecard's spend and the
 * shadow's stop marks. Every read is read-only; this module has no writer, so a shadow tick cannot record a stop.
 */

interface StopQuery {
  initiative: string;
  /** Task keys whose Shepherd runs the rules need: the candidates and every task of their bets. */
  wanted: ReadonlySet<string>;
  /** `<shadow.dir>/../state/stops.json`; undefined when the rule file names no shadow dir. */
  marksFile: string | undefined;
  verbs: Verbs;
}

export type StopSignalRead = (query: StopQuery) => Promise<StopSignals>;

interface StopContext {
  lane: { initiative: string };
  rules: RuleFile;
  eligible: Eligibility["eligible"];
  verbs: Verbs;
}

const NewHead = z.looseObject({ result: z.looseObject({ state: z.literal("open"), exited: z.literal(true).optional(), green: z.literal(true).optional() }) });

/** Stack-cascade's own count, kept private there; a cross-check test pins the two to the same answer on one fixture. */
export function fixRoundsOf(run: Pick<WorkflowRun, "stepResults">): number {
  return Object.values(run.stepResults).filter((result) => {
    if (!stepIdMatches(AWAIT_NEW_HEAD_STEP, result.stepId)) return false;
    const parsed = NewHead.safeParse(result.data);
    return parsed.success && parsed.data.result.exited !== true && parsed.data.result.green !== true;
  }).length;
}

function taskRun(registration: Registration, run: WorkflowRun): TaskRun {
  const pr = registration.pr === null ? registration.runId : `${registration.repo}#${registration.pr}`;
  return { task: registration.task, pr, createdAt: registration.createdAt, outcome: watchRow({ registration, run }).outcome?.kind ?? null, fixRounds: fixRoundsOf(run) };
}

/** A factory database Shepherd's routes never opened has no registration table, and so no runs. */
const hasShepherdStore = (db: Db): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shepherd_registration'").get() !== undefined;

/** Read from the factory's own store, not Shepherd's routes, so a host opened without them still answers. */
async function readTaskRuns({ verbs, wanted }: StopQuery): Promise<TaskRun[]> {
  let runs: TaskRun[] = [];
  await verbs.withHost((host) => {
    if (!hasShepherdStore(host.db)) return EXIT.OK;
    runs = new ShepherdStore(host.db).all().flatMap((registration) => {
      if (!wanted.has(registration.task)) return [];
      const run = host.runtime.status(registration.runId);
      return run ? [taskRun(registration, run)] : [];
    });
    return EXIT.OK;
  });
  return runs;
}

type TaskCommands = { "task.list": { args: { slug: string; status: "all" }; result: { tasks: unknown[] } } };

async function readInitiativeTasks({ verbs, initiative }: StopQuery): Promise<Task[]> {
  const source = { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) };
  const { tasks } = await createRpcClient<TaskCommands>(liveSource(source)).call("task.list", { slug: initiative, status: "all" });
  return tasks.flatMap((row) => TaskSchema.safeParse(row).data ?? []);
}

/** The ticket scorecard's store, where session-miner writes it: `TITAN_SCORECARD_STORE`, else under the XDG data home. */
function scorecardStore(env: NodeJS.ProcessEnv): string {
  return env.TITAN_SCORECARD_STORE ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "titan-scorecard", "scorecard.sqlite3");
}

/** Spend per task from the scorecard, opened read-only; any failure reads as unread so it never holds. */
export function readScorecardSpend(env: NodeJS.ProcessEnv): SpendRead {
  const file = scorecardStore(env);
  if (!existsSync(file)) return { ok: false, why: "no ticket-scorecard store" };
  try {
    const db = openDatabase(file, { readonly: true });
    try {
      return { ok: true, usd: new Map(readTaskRows(db).map((row) => [`${row.initiative}/${row.taskId}`, row.usd])) };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, why: `ticket-scorecard store: ${errorMessage(error)}` };
  }
}

const StopMarksFile = z.object({
  planner_looked: z.array(z.string()).default([]),
  checkpoints: z.record(z.string(), z.array(z.number().int().positive())).default({}),
});

/** An absent file is no marks; a file that does not parse throws, so the provider holds rather than guesses. */
export function readStopMarks(file: string | undefined): StopMarks {
  if (file === undefined || !existsSync(file)) return { plannerLooked: new Set(), checkpoints: new Map() };
  let parsed: z.infer<typeof StopMarksFile>;
  try {
    parsed = StopMarksFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`state/stops.json: ${errorMessage(error)}`);
  }
  return { plannerLooked: new Set(parsed.planner_looked), checkpoints: new Map(Object.entries(parsed.checkpoints).map(([bet, counts]) => [bet, new Set(counts)])) };
}

export const liveStopSignals: StopSignalRead = async (query) => {
  const [tasks, runs] = await Promise.all([readInitiativeTasks(query), readTaskRuns(query)]);
  return { tasks, runs, spend: readScorecardSpend(query.verbs.io.env), marks: readStopMarks(query.marksFile) };
};

/** The stop rules as a hold provider over `read`; a lane with no candidate reads nothing. */
export function stopProvider(read: StopSignalRead): (ctx: StopContext) => Promise<{ holds: StopHold[] }> {
  return async function stopHolds(ctx) {
    if (ctx.eligible.length === 0) return { holds: [] };
    const { initiative } = ctx.lane;
    const wanted = new Set(ctx.eligible.flatMap(({ task, bet }) => [`${initiative}/${task.id}`, ...(bet.tasks ?? [])]));
    const dir = ctx.rules.shadow.dir;
    const signals = await read({ initiative, wanted, verbs: ctx.verbs, marksFile: dir === undefined ? undefined : join(dir, "..", "state", "stops.json") });
    return { holds: stopRuleHolds({ initiative, candidates: ctx.eligible, signals, rules: ctx.rules.stop }) };
  };
}

export const stopHolds = stopProvider(liveStopSignals);
