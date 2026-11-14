import type { Bet, Task } from "@titan-design/pm";
import type { StopRules } from "./shadow/rule-file.js";

/*
 * The stop rules (operating model PROPOSAL 2.4, TP-5755 S6): when a task, a bet or a programme has spent enough that the
 * dispatcher stops feeding it. Pure and deterministic; the reads live in stop-signals.ts.
 */

type StopCode = "task-fix-cap" | "task-spend-cap" | "bet-parked" | "bet-followups" | "programme-checkpoint";

/** One Shepherd run of a task, reduced to what the stop rules read. */
export interface TaskRun {
  /** The task's `initiative/ID` key, as the run was registered. */
  task: string;
  /** `owner/repo#n`, or the run id while the run has no PR, so two runs of one PR count once. */
  pr: string;
  createdAt: string;
  outcome: "merged" | "stopped" | null;
  fixRounds: number;
}

/** Spend per task key in USD; a null value is a scorecard row that priced nothing. */
export type SpendRead = { ok: true; usd: ReadonlyMap<string, number | null> } | { ok: false; why: string };

export interface StopMarks {
  /** Task keys a planner has already looked at once after their fix cap. */
  plannerLooked: ReadonlySet<string>;
  /** Per bet id, the merged-PR counts at which a checkpoint was read. */
  checkpoints: ReadonlyMap<string, ReadonlySet<number>>;
}

export interface StopSignals {
  /** Every task of the lane's initiative, open or done, for estimates and follow-up provenance. */
  tasks: readonly Task[];
  runs: readonly TaskRun[];
  spend: SpendRead;
  marks: StopMarks;
}

export interface StopHold {
  task: string;
  stage: "stop";
  codes: StopCode[];
  details: string[];
  numbers: Record<string, number>;
  next?: "planner-once" | "park";
  would_ask?: true;
}

type BetHold = Omit<StopHold, "task">;

interface StopInput {
  initiative: string;
  /** The lane's eligible tasks, each with the selected bet that admitted it. */
  candidates: readonly { task: Task; bet: Bet }[];
  signals: StopSignals;
  rules: StopRules;
}

/** A programme is judged only once it has this many merged PRs. */
const PROGRAMME_MIN_PRS = 5;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const estimateOf = (task: Task): number => task.estimate ?? 0;

function latestRun(runs: readonly TaskRun[], key: string): TaskRun | undefined {
  return runs.filter((run) => run.task === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function fixCapHold(key: string, signals: StopSignals, rules: StopRules): StopHold | undefined {
  const fixRounds = latestRun(signals.runs, key)?.fixRounds ?? 0;
  if (fixRounds < rules.taskFixRounds) return undefined;
  const next = signals.marks.plannerLooked.has(key) ? "park" : "planner-once";
  const details = [`${fixRounds} fix rounds on its latest Shepherd run reach the cap of ${rules.taskFixRounds}`];
  return { task: key, stage: "stop", codes: ["task-fix-cap"], details, numbers: { fixRounds, cap: rules.taskFixRounds }, next };
}

/** A task with no estimate has no spend cap; spend that cannot be read is named and never holds. */
function spendVerdict(key: string, task: Task, spend: SpendRead, rules: StopRules): { hold?: StopHold; unread?: string } {
  if (task.estimate === undefined) return {};
  if (!spend.ok) return { unread: `task-spend-cap unread: ${spend.why}` };
  const usd = spend.usd.get(key);
  if (usd === undefined) return { unread: "task-spend-cap unread: the ticket scorecard has no row for the task" };
  if (usd === null) return { unread: "task-spend-cap unread: the task's scorecard row prices no spend" };
  const cap = rules.spendMultiple * task.estimate * rules.usdPerPoint;
  if (usd < cap) return {};
  const details = [`spent $${usd} against a cap of $${cap} (${rules.spendMultiple} x ${task.estimate} points x $${rules.usdPerPoint})`];
  return { hold: { task: key, stage: "stop", codes: ["task-spend-cap"], details, numbers: { spendUsd: usd, capUsd: cap } } };
}

function followUpOf(task: Task, initiative: string): string | undefined {
  if (task.source !== "follow-up" || typeof task.source_ref !== "object") return undefined;
  return `${initiative}/${task.source_ref.from_task}`;
}

interface BetTally {
  stoppedTasks: number;
  mergedPrs: number;
  ownEstimate: number;
  followupEstimate: number;
}

function betTally(bet: Bet, initiative: string, signals: StopSignals): BetTally {
  const members = new Set(bet.tasks ?? []);
  const runs = signals.runs.filter((run) => members.has(run.task));
  const own = signals.tasks.filter((task) => members.has(`${initiative}/${task.id}`));
  const followUps = signals.tasks.filter((task) => members.has(followUpOf(task, initiative) ?? ""));
  return {
    stoppedTasks: new Set(runs.filter((run) => run.outcome === "stopped").map((run) => run.task)).size,
    mergedPrs: new Set(runs.filter((run) => run.outcome === "merged").map((run) => run.pr)).size,
    ownEstimate: sum(own.map(estimateOf)),
    followupEstimate: sum(followUps.map(estimateOf)),
  };
}

function checkpointDue(merged: number, every: number, read: ReadonlySet<number> | undefined): boolean {
  return merged >= PROGRAMME_MIN_PRS && merged % every === 0 && read?.has(merged) !== true;
}

function betHolds(bet: Bet, tally: BetTally, rules: StopRules, marks: StopMarks): BetHold[] {
  const holds: BetHold[] = [];
  if (tally.stoppedTasks >= rules.betStoppedPrs) {
    const details = [`${tally.stoppedTasks} of ${bet.id}'s tasks have a stopped Shepherd PR`];
    holds.push({ stage: "stop", codes: ["bet-parked"], details, numbers: { stoppedPrs: tally.stoppedTasks }, would_ask: true });
  }
  if (tally.followupEstimate > rules.betFollowupMultiple * tally.ownEstimate) {
    const details = [`follow-ups of ${bet.id} estimate ${tally.followupEstimate} points against ${tally.ownEstimate} of its own`];
    holds.push({ stage: "stop", codes: ["bet-followups"], details, numbers: { followupEstimate: tally.followupEstimate, betEstimate: tally.ownEstimate } });
  }
  if (checkpointDue(tally.mergedPrs, rules.checkpointEvery, marks.checkpoints.get(bet.id))) {
    const details = [`${bet.id} reached ${tally.mergedPrs} merged PRs with no checkpoint read for that count`];
    holds.push({ stage: "stop", codes: ["programme-checkpoint"], details, numbers: { mergedPrs: tally.mergedPrs, checkpointEvery: rules.checkpointEvery } });
  }
  return holds;
}

/** Unread spend rides on the task's first stop hold, since a row is written only for a held task. */
function withUnread(holds: StopHold[], unread: string | undefined): StopHold[] {
  if (unread === undefined || holds.length === 0) return holds;
  const [first, ...rest] = holds;
  return [{ ...first!, details: [...first!.details, unread] }, ...rest];
}

/** Every stop hold on the lane's eligible tasks; a bet's holds apply to each of its candidates. */
export function stopRuleHolds({ initiative, candidates, signals, rules }: StopInput): StopHold[] {
  const byBet = new Map<string, BetHold[]>();
  const betLevel = (bet: Bet): BetHold[] => {
    if (!byBet.has(bet.id)) byBet.set(bet.id, betHolds(bet, betTally(bet, initiative, signals), rules, signals.marks));
    return byBet.get(bet.id)!;
  };
  return candidates.flatMap(({ task, bet }) => {
    const key = `${initiative}/${task.id}`;
    const spend = spendVerdict(key, task, signals.spend, rules);
    const holds = [fixCapHold(key, signals, rules), spend.hold, ...betLevel(bet).map((hold): StopHold => ({ ...hold, task: key }))];
    return withUnread(
      holds.filter((hold) => hold !== undefined),
      spend.unread,
    );
  });
}
