import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type StepRoute, type WorkflowContext, type WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import { redactForEvidence } from "../redact.js";
import { codeRoute, step } from "../workflows/land.js";
import { HOLD_POLL_MS, type HeldCheck, type HoldTiming } from "./hold.js";

/** Only shepherd-pr runs ride the train; they are the runs that leave it again after every land round. */
export const TRAIN_WORKFLOW = "shepherd-pr";

const TRAIN_DDL = `
  CREATE TABLE shepherd_train (
    repo   TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    pr     INTEGER NOT NULL,
    since  TEXT NOT NULL
  );`;

/** One row per repo: the shepherd-pr run in that repo's land sequence now. */
export function trainMigration(version = 10): Migration {
  return { version, name: "factory:shepherd_train", up: (db) => db.exec(TRAIN_DDL) };
}

export interface TrainHolder {
  repo: RepoSlug;
  runId: string;
  pr: number;
  since: string;
}

interface Row {
  repo: string;
  run_id: string;
  pr: number;
  since: string;
}

/** A run paused on a gate, parked for recovery, or finished no longer drives its land sequence, so it gives the train up. */
const DRIVING: ReadonlySet<WorkflowStatus> = new Set(["running", "cancelling"]);

const repoKey = (repo: RepoSlug): string => repo.toLowerCase();

/** The per-repo merge train in the factory database; the table comes from `trainMigration`. */
export class MergeTrain {
  private readonly runs: WorkflowRunStore;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.runs = new WorkflowRunStore(db);
  }

  holder(repo: RepoSlug): TrainHolder | undefined {
    const row = this.db.prepare("SELECT * FROM shepherd_train WHERE repo = ?").get(repoKey(repo)) as Row | undefined;
    return row && { repo: row.repo, runId: row.run_id, pr: row.pr, since: row.since };
  }

  /** Takes the train from `from`, the holder read before, or from nobody when `from` is null; false when another run got there first. */
  take(repo: RepoSlug, runId: string, pr: number, from: string | null): boolean {
    const at = new Date(this.now()).toISOString();
    if (from === null) return this.db.prepare("INSERT INTO shepherd_train (repo, run_id, pr, since) VALUES (?, ?, ?, ?) ON CONFLICT (repo) DO NOTHING").run(repoKey(repo), runId, pr, at).changes === 1;
    return this.db.prepare("UPDATE shepherd_train SET run_id = ?, pr = ?, since = ? WHERE repo = ? AND run_id = ?").run(runId, pr, at, repoKey(repo), from).changes === 1;
  }

  /** True when `runId` held the train and now does not. */
  leave(repo: RepoSlug, runId: string): boolean {
    return this.db.prepare("DELETE FROM shepherd_train WHERE repo = ? AND run_id = ?").run(repoKey(repo), runId).changes === 1;
  }

  isDriving(runId: string): boolean {
    const run = this.runs.get(runId);
    return run !== undefined && DRIVING.has(run.status);
  }
}

/** A train bound to whichever factory database the host opened; reading it unbound throws, so a merge fails closed. */
export interface MergeTrainRef {
  get(): MergeTrain;
  bind(db: Db): () => void;
}

export function mergeTrainRef(now: () => number = Date.now): MergeTrainRef {
  let train: MergeTrain | undefined;
  return {
    get() {
      if (!train) throw new Error("the merge train is not bound to an open factory database");
      return train;
    },
    bind(db) {
      if (train) throw new Error("the merge train is already bound to an open factory database");
      const bound = new MergeTrain(db, now);
      train = bound;
      return () => void (train === bound && (train = undefined));
    },
  };
}

export interface TrainDeps {
  train: MergeTrainRef;
  port: GitHubPort;
  /** Why a PR's merge must wait; a holder whose merge waits gives the train up, so a hold or a freeze never wedges the repo. */
  held: HeldCheck;
  timing: HoldTiming;
}

interface MergeInput {
  repo: RepoSlug;
  pr: number;
  sha: string;
}

/** Boarding ends in the merge only for a run that already held the train; any other answer makes land read CI again. */
type Boarding = { kind: "riding" } | { kind: "boarded"; waitedBehind: string | null };

/**
 * Wraps the `merge` route so a shepherd-pr run merges only while it holds its repo's train. A run that has just boarded
 * merges at once only when its head is still the one named and not behind; otherwise land reads CI and updates first.
 */
export function rideTrain(route: StepRoute, deps: TrainDeps): StepRoute {
  const now = deps.timing.now ?? Date.now;
  return {
    ...route,
    runner: {
      run: async (input) => {
        if (input.workflowName !== TRAIN_WORKFLOW) return route.runner.run(input);
        const target = JSON.parse(input.prompt) as MergeInput;
        let wait: string | undefined;
        try {
          wait = await boardingWait(deps, target, input.runId, input.signal);
        } catch (error) {
          return { ok: false, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
        }
        if (wait === undefined) return route.runner.run(input);
        return codeRoute(route.match, now, async () => ({ done: false, skipped: "train", mergeSha: "", train: wait })).runner.run(input);
      },
    },
  };
}

/** Undefined means merge now; a string says why land must read CI first. */
async function boardingWait(deps: TrainDeps, target: MergeInput, runId: string, signal: AbortSignal): Promise<string | undefined> {
  const boarding = await untilBoarded(deps, target, runId, signal);
  if (boarding.kind === "riding") return undefined;
  const waited = boarding.waitedBehind === null ? "boarded a free train" : `boarded after run ${boarding.waitedBehind}`;
  const pr = await deps.port.getPr(target.repo, target.pr);
  if (pr.headSha !== target.sha) return `${waited}; the head moved`;
  if (pr.behind) return `${waited}; the branch is behind its base`;
  return boarding.waitedBehind === null ? undefined : `${waited}; the base may have moved`;
}

async function untilBoarded(deps: TrainDeps, target: MergeInput, runId: string, signal: AbortSignal): Promise<Boarding> {
  const train = deps.train.get();
  for (let waitedBehind: string | null = null; ; ) {
    signal.throwIfAborted();
    const holder = train.holder(target.repo);
    if (holder?.runId === runId) return waitedBehind === null ? { kind: "riding" } : { kind: "boarded", waitedBehind };
    if (holder === undefined || (await gaveUp(deps, holder))) {
      if (train.take(target.repo, runId, target.pr, holder?.runId ?? null)) return { kind: "boarded", waitedBehind: waitedBehind ?? holder?.runId ?? null };
      continue;
    }
    waitedBehind = holder.runId;
    await deps.timing.sleep(deps.timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}

/** A failed read of the holder's PR keeps the holder, so a GitHub outage never lets two runs in at once. */
async function gaveUp(deps: TrainDeps, holder: TrainHolder): Promise<boolean> {
  if (!deps.train.get().isDriving(holder.runId)) return true;
  return (await deps.held(holder.repo, holder.pr).catch(() => undefined)) !== undefined;
}

const TrainLeftResult = z.looseObject({ left: z.boolean() });

/** Every way out of a land round gives the train up before anything slow after it: a post-land wake, a gate, or main CI after the merge. Review and send-back wakes run inside land, with the train held. */
export async function leaveTrain(ctx: WorkflowContext, repo: RepoSlug, round: number): Promise<void> {
  await step(ctx, `sh-train-leave:${round}`, { repo, runId: ctx.runId }, TrainLeftResult);
}

/** `sh-train-leave` gives the repo's train up for the run, if it holds it; a repeat after a crash finds nothing to leave. */
export function trainLeaveRoute(train: MergeTrainRef, now: () => number): StepRoute {
  return codeRoute("sh-train-leave", now, async (input: { repo: RepoSlug; runId: string }) => ({ left: train.get().leave(input.repo, input.runId) }));
}
