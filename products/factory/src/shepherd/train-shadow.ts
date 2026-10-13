import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type RoutedStepInput, type StepRoute, type WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { PrReads } from "../workflows/pr-snapshot.js";
import type { IsAdvisory } from "./advisory.js";
import type { HeldCheck } from "./hold.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { TRAIN_WORKFLOW } from "./train.js";
import { readDisjoint, type DisjointVerdict } from "./train-shadow-disjoint.js";
import { admitPeers, excludedReason, stageOf, type ShadowExcluded, type ShadowPeer } from "./train-shadow-peers.js";

const SHADOW_DDL = `
  CREATE TABLE shepherd_train_shadow (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL,
    step_id       TEXT NOT NULL,
    repo          TEXT NOT NULL,
    pr            INTEGER NOT NULL,
    head_sha      TEXT NOT NULL,
    at            TEXT NOT NULL,
    self_excluded TEXT,
    peers         TEXT NOT NULL,
    excluded      TEXT NOT NULL,
    disjoint      TEXT NOT NULL,
    UNIQUE (run_id, step_id)
  );
  CREATE INDEX shepherd_train_shadow_repo ON shepherd_train_shadow (repo, at);`;

/** One row per land-time refresh: what a merge-train batch sealed at that moment would have held. Measures only. */
export function trainShadowMigration(version = 26): Migration {
  return { version, name: "factory:shepherd_train_shadow", up: (db) => db.exec(SHADOW_DDL) };
}

export interface TrainShadow {
  runId: string;
  stepId: string;
  repo: string;
  pr: number;
  /** The approved head the refresh starts from. */
  headSha: string;
  at: string;
  /** Why a batch would refuse this run itself; undefined when it would take it. */
  selfExcluded?: ShadowExcluded["reason"];
  peers: ShadowPeer[];
  excluded: ShadowExcluded[];
  disjoint: DisjointVerdict;
}


const ExcludedReason = z.enum(["held", "stacked", "unread"]);
const Peers = z.array(z.object({ runId: z.string(), pr: z.number(), headSha: z.string(), stage: z.enum(["refresh", "refresh-ci", "train"]) }));
const Excluded = z.array(z.object({ runId: z.string(), pr: z.number(), headSha: z.string(), reason: ExcludedReason }));
const Verdict = z.enum(["units-disjoint", "overlap", "shared", "unknown"]);
const Rows = z.array(z.object({ run_id: z.string(), step_id: z.string(), repo: z.string(), pr: z.number(), head_sha: z.string(), at: z.string(), self_excluded: ExcludedReason.nullable(), peers: z.string(), excluded: z.string(), disjoint: Verdict }));

function fromRow(row: z.infer<typeof Rows>[number]): TrainShadow {
  const selfExcluded = row.self_excluded ?? undefined;
  return { runId: row.run_id, stepId: row.step_id, repo: row.repo, pr: row.pr, headSha: row.head_sha, at: row.at, ...(selfExcluded && { selfExcluded }), peers: Peers.parse(JSON.parse(row.peers)), excluded: Excluded.parse(JSON.parse(row.excluded)), disjoint: row.disjoint };
}

/** Every shadow row; none from a database the serve process has not yet migrated to the table. */
export function shadowsIn(db: Db): TrainShadow[] {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shepherd_train_shadow'").get() === undefined) return [];
  return Rows.parse(db.prepare("SELECT * FROM shepherd_train_shadow ORDER BY id").all()).map(fromRow);
}

class TrainShadowStore {
  private readonly runs: WorkflowRunStore;

  constructor(private readonly db: Db) {
    this.runs = new WorkflowRunStore(db);
  }

  /** A repeat of the same step after a crash keeps the first row. */
  append(shadow: TrainShadow): void {
    this.db
      .prepare("INSERT INTO shepherd_train_shadow (run_id, step_id, repo, pr, head_sha, at, self_excluded, peers, excluded, disjoint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, step_id) DO NOTHING")
      .run(shadow.runId, shadow.stepId, shadow.repo.toLowerCase(), shadow.pr, shadow.headSha, shadow.at, shadow.selfExcluded ?? null, JSON.stringify(shadow.peers), JSON.stringify(shadow.excluded), shadow.disjoint);
  }

  run(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  driving(): WorkflowRun[] {
    return this.runs.listByStatus(["running"]);
  }
}

interface TrainShadowRef {
  get(): TrainShadowStore;
  bind(db: Db): () => void;
}

export function trainShadowRef(): TrainShadowRef {
  let store: TrainShadowStore | undefined;
  return {
    get() {
      if (!store) throw new Error("the train shadow store is not bound to an open factory database");
      return store;
    },
    bind(db) {
      if (store) throw new Error("the train shadow store is already bound to an open factory database");
      const bound = new TrainShadowStore(db);
      store = bound;
      return () => void (store === bound && (store = undefined));
    },
  };
}

export interface ShadowDeps {
  shadow: TrainShadowRef;
  port: GitHubPort;
  reads: PrReads;
  held: HeldCheck;
  advisory: IsAdvisory;
  now: () => number;
}

const UpdateTarget = z.looseObject({ repo: z.string(), pr: z.number() });

/** The refresh this step makes, or undefined for any update that is not a land-time refresh of a shepherd-pr run. */
function refreshOf(deps: ShadowDeps, input: RoutedStepInput): { run: WorkflowRun; repo: RepoSlug; pr: number; headSha: string } | undefined {
  const target = UpdateTarget.parse(JSON.parse(input.prompt));
  const run = deps.shadow.get().run(input.runId);
  if (!run || deps.advisory(target.repo) || run.params.branch === VERSION_PACKAGES_BRANCH) return undefined;
  const stage = stageOf(run);
  return stage?.stage === "refresh" ? { run, repo: target.repo, pr: target.pr, headSha: stage.headSha } : undefined;
}

async function recordShadow(deps: ShadowDeps, input: RoutedStepInput): Promise<void> {
  const refresh = refreshOf(deps, input);
  if (!refresh) return;
  const { run, repo, pr, headSha } = refresh;
  const defaultBranch = await deps.port.defaultBranch(repo);
  const reads = { held: deps.held, defaultBranch, baseOf: async (slug: RepoSlug, n: number) => (await deps.reads.getPr(slug, n)).baseRef };
  const selfExcluded = await excludedReason(reads, repo, { pr, headSha });
  const { peers, excluded } = await admitPeers(deps.shadow.get().driving(), repo, run.id, reads);
  const disjoint = await readDisjoint(deps.port, repo, pr, headSha, defaultBranch).catch((): DisjointVerdict => "unknown");
  const at = new Date(deps.now()).toISOString();
  deps.shadow.get().append({ runId: run.id, stepId: input.stepId, repo, pr, headSha, at, ...(selfExcluded && { selfExcluded }), peers, excluded, disjoint });
}

/**
 * Wraps `update-branch` so each land-time refresh of a shepherd-pr run records what a merge-train batch would have
 * held. It runs beside the update and swallows its own failures, so the update itself is unchanged.
 */
export function shadowRefresh(route: StepRoute, deps: ShadowDeps): StepRoute {
  return {
    ...route,
    runner: {
      run: async (input) => {
        if (input.workflowName !== TRAIN_WORKFLOW) return route.runner.run(input);
        const shadow = recordShadow(deps, input).catch(() => undefined);
        const outcome = await route.runner.run(input);
        await shadow;
        return outcome;
      },
    },
  };
}
