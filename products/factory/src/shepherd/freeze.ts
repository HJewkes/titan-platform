import { GITHUB_ACTIONS_APP_ID, headCheckFindings, isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { appendEvent } from "./events.js";
import { actionsRunsAt, judgeMain, readMainRules } from "./main-verdict.js";

export { actionsRunsAt, withoutSupersededCancels } from "./main-verdict.js";

export const FREEZE_RECHECK_MS = 5 * 60_000;

const FREEZE_DDL = `
  CREATE TABLE shepherd_freeze (
    repo       TEXT PRIMARY KEY,
    red_sha    TEXT NOT NULL,
    fix_task   TEXT,
    fixer      TEXT,
    red_count  INTEGER NOT NULL,
    frozen_at  TEXT NOT NULL,
    episode    INTEGER NOT NULL,
    thawed_at  TEXT
  );`;

export function freezeMigration(version = 6): Migration {
  return {
    version,
    name: "factory:shepherd_freeze",
    up: (db) => db.exec(FREEZE_DDL),
  };
}

/** Whether a freeze's red came only from cancelled runs, the one red a later green run at the same sha may clear. */
export function freezeCancelOnlyMigration(version = 12): Migration {
  return { version, name: "factory:shepherd_freeze_cancel_only", up: (db) => db.exec("ALTER TABLE shepherd_freeze ADD COLUMN cancel_only INTEGER NOT NULL DEFAULT 0") };
}

export interface Freeze {
  repo: RepoSlug;
  redSha: string;
  fixTask: string | null;
  fixer: string | null;
  redCount: number;
  frozenAt: string;
  episode: number;
  /** Every run red at `redSha` was cancelled, so a later green run of each at that same sha clears it. */
  cancelOnly: boolean;
}

interface Row {
  repo: string;
  red_sha: string;
  fix_task: string | null;
  fixer: string | null;
  red_count: number;
  frozen_at: string;
  episode: number;
  thawed_at: string | null;
  cancel_only: number;
}

/** GitHub treats repo names case-insensitively, so a freeze on one spelling must freeze every spelling. */
const repoKey = (repo: RepoSlug): string => repo.toLowerCase();

/** One freeze row per repo in the factory database; the table comes from `freezeMigration`. */
export class FreezeStore {
  private readonly rechecked = new Map<string, number>();

  constructor(private readonly db: Db, private readonly now: () => number = Date.now, private readonly onThaw: (repo: RepoSlug) => void = () => undefined) {}

  /** Claims `repo`'s re-read of its default branch at `at`; false within `FREEZE_RECHECK_MS` of the last claim, so every reader of this store shares one limit. */
  claimRecheck(repo: RepoSlug, at: number): boolean {
    const previous = this.rechecked.get(repoKey(repo));
    if (previous !== undefined && at - previous < FREEZE_RECHECK_MS) return false;
    this.rechecked.set(repoKey(repo), at);
    return true;
  }

  /** A repeat of the same red sha changes nothing; a later red sha in a live freeze counts up; a thawed repo starts a new episode. */
  freeze(repo: RepoSlug, redSha: string, cancelOnly = false): Freeze {
    // Immediate, because a deferred read-then-write fails with "database is locked" when the CLI's connection commits in between.
    this.db.transaction(() => this.freezeRow(repo, redSha, cancelOnly)).immediate();
    return this.active(repo)!;
  }

  private freezeRow(repo: RepoSlug, redSha: string, cancelOnly: boolean): void {
    const row = this.row(repo);
    const flag = cancelOnly ? 1 : 0;
    if (row && row.thawed_at === null) {
      if (row.red_sha !== redSha) this.db.prepare("UPDATE shepherd_freeze SET red_sha = ?, red_count = red_count + 1, cancel_only = ? WHERE repo = ?").run(redSha, flag, repoKey(repo));
      return;
    }
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO shepherd_freeze (repo, red_sha, red_count, frozen_at, episode, cancel_only) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET red_sha = excluded.red_sha, fix_task = NULL, fixer = NULL, red_count = 1, frozen_at = excluded.frozen_at, episode = excluded.episode, thawed_at = NULL, cancel_only = excluded.cancel_only`,
      )
      .run(repoKey(repo), redSha, at, (row?.episode ?? 0) + 1, flag);
    appendEvent(this.db, { repo, kind: "freeze", at, headSha: redSha, reason: cancelOnly ? "main red from cancelled runs only" : "main red" });
  }

  /** False when `episode` is no longer the live one, so a late step never writes into a later episode. */
  setFixTask(repo: RepoSlug, episode: number, id: string): boolean {
    return this.setField(repo, episode, "fix_task", id);
  }

  setFixer(repo: RepoSlug, episode: number, name: string): boolean {
    return this.setField(repo, episode, "fixer", name);
  }

  /** The live freeze, only while it is still `episode`. */
  live(repo: RepoSlug, episode: number | null): Freeze | undefined {
    const freeze = this.active(repo);
    return freeze?.episode === episode ? freeze : undefined;
  }

  isFrozen(repo: RepoSlug): boolean {
    return this.active(repo) !== undefined;
  }

  /** The task whose PRs may merge through the freeze; undefined while no fix task is filed or the repo is not frozen. */
  exemptTask(repo: RepoSlug): string | undefined {
    return this.active(repo)?.fixTask ?? undefined;
  }

  get(repo: RepoSlug): Freeze | undefined {
    return this.active(repo);
  }

  /** Refuses a green sha equal to the red sha, because a check that passed on the red commit proves nothing, unless that red was only cancels. */
  unfreeze(repo: RepoSlug, greenSha: string): boolean {
    const freeze = this.active(repo);
    if (!freeze || (freeze.redSha === greenSha && !freeze.cancelOnly)) return false;
    return this.release(repo, freeze.episode);
  }

  /** The owner's override from a frozen gate: thaws without a green sha, and only the episode that gate opened for. Every thaw, `unfreeze` included, ends here. */
  release(repo: RepoSlug, episode: number): boolean {
    const at = new Date(this.now()).toISOString();
    const thawed = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE shepherd_freeze SET thawed_at = ? WHERE repo = ? AND episode = ? AND thawed_at IS NULL").run(at, repoKey(repo), episode).changes > 0;
      if (changed) appendEvent(this.db, { repo, kind: "thaw", at, headSha: this.row(repo)?.red_sha });
      return changed;
    })();
    if (thawed) this.onThaw(repo);
    return thawed;
  }

  private setField(repo: RepoSlug, episode: number, column: "fix_task" | "fixer", value: string): boolean {
    return this.db.prepare(`UPDATE shepherd_freeze SET ${column} = ? WHERE repo = ? AND episode = ? AND thawed_at IS NULL`).run(value, repoKey(repo), episode).changes > 0;
  }

  private row(repo: RepoSlug): Row | undefined {
    return this.db.prepare("SELECT * FROM shepherd_freeze WHERE repo = ?").get(repoKey(repo)) as Row | undefined;
  }

  private active(repo: RepoSlug): Freeze | undefined {
    const row = this.row(repo);
    return row && row.thawed_at === null ? fromRow(row) : undefined;
  }
}

function fromRow(row: Row): Freeze {
  return {
    repo: row.repo,
    redSha: row.red_sha,
    fixTask: row.fix_task,
    fixer: row.fixer,
    redCount: row.red_count,
    frozenAt: row.frozen_at,
    episode: row.episode,
    cancelOnly: row.cancel_only === 1,
  };
}

/** A freeze store bound to whichever factory database the host opened; reading it unbound throws, so a merge guard fails closed. */
export interface FreezeStoreRef {
  get(): FreezeStore;
  /** Returns the unbind, which the host calls before it closes the database. */
  bind(db: Db): () => void;
  /** Calls `listener` with the repo each time a freeze thaws, whichever path thawed it; returns the unsubscribe. */
  onThaw(listener: (repo: RepoSlug) => void): () => void;
}

export function freezeStoreRef(now: () => number = Date.now): FreezeStoreRef {
  let store: FreezeStore | undefined;
  const listeners = new Set<(repo: RepoSlug) => void>();
  const thawed = (repo: RepoSlug) => listeners.forEach((listener) => listener(repo));
  return {
    get() {
      if (!store) throw new Error("the freeze store is not bound to an open factory database");
      return store;
    },
    bind(db) {
      if (store) throw new Error("the freeze store is already bound to an open factory database");
      const bound = new FreezeStore(db, now, thawed);
      store = bound;
      return () => void (store === bound && (store = undefined));
    },
    onThaw(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The red a freeze holds: its sha, and whether a later green run at that same sha may clear it. */
export type Red = Pick<Freeze, "redSha" | "cancelOnly">;

/** The repo's default-branch head, when `greenAfterRed` holds for it. */
export async function greenHead(port: GitHubPort, repo: RepoSlug, baseRef: string, red: Red): Promise<string | undefined> {
  const head = await port.getHeadSha(repo, baseRef);
  if (head === null) return undefined;
  return (await greenAfterRed(port, repo, head, red, baseRef)) ? head : undefined;
}

/**
 * Every check that judges main at `sha` is complete and green by its newest run: the base branch's required contexts when
 * it has them (`baseRef` given and readable), else every Actions check, which must also have run green where it was red
 * at the red sha, so a path-filtered head cannot clear it. The red sha itself qualifies only when its red was only cancels.
 */
export async function greenAfterRed(port: GitHubPort, repo: RepoSlug, sha: string, red: Red, baseRef?: string): Promise<boolean> {
  if (sha === red.redSha && !red.cancelOnly) return false;
  const runs = await actionsRuns(port, repo, sha);
  if (runs.length === 0) return false;
  const rules = baseRef === undefined ? undefined : (await readMainRules(port, repo, baseRef)).rules;
  if (rules !== undefined) return judgeMain(sha, await port.latestCheckRuns(repo, sha), rules).findings.length === 0;
  return headCheckFindings({ headSha: sha, contexts: await failingAt(port, repo, red.redSha), runs, requiredApps: [GITHUB_ACTIONS_APP_ID] }).length === 0;
}

/** The names of the Actions checks whose newest run completed red at `sha`. */
export async function failingAt(port: GitHubPort, repo: RepoSlug, sha: string): Promise<string[]> {
  return [...new Set((await actionsRuns(port, repo, sha)).filter((run) => run.status === "completed" && !isPassing(run)).map((run) => run.name))];
}

async function actionsRuns(port: GitHubPort, repo: RepoSlug, sha: string): Promise<CheckRun[]> {
  return actionsRunsAt(await port.latestCheckRuns(repo, sha), sha);
}

/** True when every Actions run that completed red at `sha`, superseded ones included, was cancelled. */
export async function redOnlyFromCancels(port: GitHubPort, repo: RepoSlug, sha: string): Promise<boolean> {
  const red = actionsRunsAt(await port.checkRuns(repo, sha), sha).filter((run) => run.status === "completed" && !isPassing(run));
  return red.length > 0 && red.every((run) => run.conclusion === "cancelled");
}

export interface RegistrationTasks {
  byPr(repo: RepoSlug, pr: number): { task: string; implementer: string } | undefined;
}

export interface FreezeGuardDeps {
  freezes: () => FreezeStore;
  registrations: () => RegistrationTasks;
  now?: () => number;
}

/** Why a merge of `repo#pr` waits on a frozen repo; a blocked read also re-reads the default branch, at most every five minutes per repo. */
export interface FreezeGuard {
  reason(port: GitHubPort, repo: RepoSlug, pr: number, baseRef: string): Promise<string | undefined>;
}

export function freezeGuard(deps: FreezeGuardDeps): FreezeGuard {
  const now = deps.now ?? Date.now;
  return {
    async reason(port, repo, pr, baseRef) {
      const freezes = deps.freezes();
      const freeze = freezes.get(repo);
      if (!freeze) return undefined;
      const frozen = await frozenAfterRecheck({ port, freezes, registrations: deps.registrations(), at: now() }, repo, pr, async () => baseRef);
      return frozen ? `${repo} is frozen: main is red at ${freeze.redSha}` : undefined;
    },
  };
}

/**
 * Both halves come from the freeze row, so only a registration naming this episode's fix task and its fixer passes.
 * `implementer` is caller-supplied, so this is no identity check: whoever can register can name the fixer, and still
 * gets only the exemption, never past the review and checks every merge needs.
 */
export function isFixersPr(freeze: Freeze, registration: { task: string; implementer: string } | undefined): boolean {
  if (freeze.fixTask === null || freeze.fixer === null || registration === undefined) return false;
  return registration.task === freeze.fixTask && registration.implementer === freeze.fixer;
}

/** Frozen for every PR in `repo` but the fixer's own, from the store alone with no re-read of main. */
export function frozenFor(freezes: FreezeStore, registrations: RegistrationTasks, repo: RepoSlug, pr: number): boolean {
  const freeze = freezes.get(repo);
  return freeze !== undefined && !isFixersPr(freeze, registrations.byPr(repo, pr));
}

interface FreezeRecheck {
  port: GitHubPort;
  freezes: FreezeStore;
  registrations: RegistrationTasks;
  at: number;
}

/**
 * Frozen for every PR in `repo` but the fixer's own, after re-reading the default branch at most every five minutes
 * per repo and thawing when it is green after the red. The freeze guard and merge policy both decide through this, so
 * a main fixed outside Shepherd thaws whichever reads it first.
 */
async function frozenAfterRecheck(read: FreezeRecheck, repo: RepoSlug, pr: number, baseRef: () => Promise<string>): Promise<boolean> {
  const freeze = read.freezes.get(repo);
  if (!freeze || isFixersPr(freeze, read.registrations.byPr(repo, pr))) return false;
  return !(await thawedByRecheck(read, repo, freeze, baseRef));
}

/** Merge policy's freeze read: the PR's base branch is read only when a recheck is due. */
export function recheckedFrozen(port: GitHubPort, freezes: () => FreezeStore, registrations: () => RegistrationTasks, now: () => number = Date.now) {
  return (repo: RepoSlug, pr: number): Promise<boolean> =>
    frozenAfterRecheck({ port, freezes: freezes(), registrations: registrations(), at: now() }, repo, pr, async () => (await port.getPr(repo, pr)).baseRef);
}

/** A failed read leaves the freeze in place, because the merge it guards is already blocked. */
async function thawedByRecheck({ port, freezes, at }: FreezeRecheck, repo: RepoSlug, red: Red, baseRef: () => Promise<string>): Promise<boolean> {
  if (!freezes.claimRecheck(repo, at)) return false;
  try {
    const green = await greenHead(port, repo, await baseRef(), red);
    return green !== undefined && freezes.unfreeze(repo, green);
  } catch {
    return false;
  }
}
