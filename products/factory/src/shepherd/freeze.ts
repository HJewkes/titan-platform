import { GITHUB_ACTIONS_APP_ID, headCheckFindings, isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";

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

export interface Freeze {
  repo: RepoSlug;
  redSha: string;
  fixTask: string | null;
  fixer: string | null;
  redCount: number;
  frozenAt: string;
  episode: number;
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
}

/** GitHub treats repo names case-insensitively, so a freeze on one spelling must freeze every spelling. */
const repoKey = (repo: RepoSlug): string => repo.toLowerCase();

/** One freeze row per repo in the factory database; the table comes from `freezeMigration`. */
export class FreezeStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now, private readonly onThaw: (repo: RepoSlug) => void = () => undefined) {}

  /** A repeat of the same red sha changes nothing; a later red sha in a live freeze counts up; a thawed repo starts a new episode. */
  freeze(repo: RepoSlug, redSha: string): Freeze {
    const row = this.row(repo);
    if (row && row.thawed_at === null) {
      if (row.red_sha !== redSha) this.db.prepare("UPDATE shepherd_freeze SET red_sha = ?, red_count = red_count + 1 WHERE repo = ?").run(redSha, repoKey(repo));
    } else {
      this.db
        .prepare(
          `INSERT INTO shepherd_freeze (repo, red_sha, red_count, frozen_at, episode) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (repo) DO UPDATE SET red_sha = excluded.red_sha, fix_task = NULL, fixer = NULL, red_count = 1, frozen_at = excluded.frozen_at, episode = excluded.episode, thawed_at = NULL`,
        )
        .run(repoKey(repo), redSha, new Date(this.now()).toISOString(), (row?.episode ?? 0) + 1);
    }
    return this.active(repo)!;
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

  /** Refuses a green sha equal to the red sha, because a check that passed on the red commit proves nothing. */
  unfreeze(repo: RepoSlug, greenSha: string): boolean {
    const freeze = this.active(repo);
    if (!freeze || freeze.redSha === greenSha) return false;
    return this.release(repo, freeze.episode);
  }

  /** The owner's override from a frozen gate: thaws without a green sha, and only the episode that gate opened for. Every thaw, `unfreeze` included, ends here. */
  release(repo: RepoSlug, episode: number): boolean {
    const thawed = this.db
      .prepare("UPDATE shepherd_freeze SET thawed_at = ? WHERE repo = ? AND episode = ? AND thawed_at IS NULL")
      .run(new Date(this.now()).toISOString(), repoKey(repo), episode).changes > 0;
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

/** The repo's default-branch head, when `greenAfterRed` holds for it. */
export async function greenHead(port: GitHubPort, repo: RepoSlug, baseRef: string, redSha: string): Promise<string | undefined> {
  const head = await port.getHeadSha(repo, baseRef);
  if (head === null) return undefined;
  return (await greenAfterRed(port, repo, head, redSha)) ? head : undefined;
}

/** Every Actions run at `sha` is complete and green, and every check that was red at `redSha` ran green here, so a path-filtered head cannot clear it. */
export async function greenAfterRed(port: GitHubPort, repo: RepoSlug, sha: string, redSha: string): Promise<boolean> {
  if (sha === redSha) return false;
  const runs = await actionsRuns(port, repo, sha);
  if (runs.length === 0) return false;
  return headCheckFindings({ headSha: sha, contexts: await failingAt(port, repo, redSha), runs, requiredApps: [GITHUB_ACTIONS_APP_ID] }).length === 0;
}

/** The names of the Actions checks that completed red at `sha`. */
export async function failingAt(port: GitHubPort, repo: RepoSlug, sha: string): Promise<string[]> {
  return [...new Set((await actionsRuns(port, repo, sha)).filter((run) => run.status === "completed" && !isPassing(run)).map((run) => run.name))];
}

async function actionsRuns(port: GitHubPort, repo: RepoSlug, sha: string): Promise<CheckRun[]> {
  return (await port.latestCheckRuns(repo, sha)).filter((run) => run.headSha === sha && run.appId === GITHUB_ACTIONS_APP_ID);
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
  const lastRead = new Map<string, number>();
  return {
    async reason(port, repo, pr, baseRef) {
      const freezes = deps.freezes();
      const freeze = freezes.get(repo);
      if (!freeze) return undefined;
      if (isFixersPr(freeze, deps.registrations().byPr(repo, pr))) return undefined;
      if (await recheck(port, freezes, repo, baseRef, lastRead, now())) return undefined;
      return `${repo} is frozen: main is red at ${freeze.redSha}`;
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

/** Frozen for every PR in `repo` but the fixer's own, the one PR the freeze guard lets land, so merge policy agrees with it. */
export function frozenFor(freezes: FreezeStore, registrations: RegistrationTasks, repo: RepoSlug, pr: number): boolean {
  const freeze = freezes.get(repo);
  return freeze !== undefined && !isFixersPr(freeze, registrations.byPr(repo, pr));
}

/** A failed read leaves the freeze in place, because the merge it guards is already blocked. */
async function recheck(port: GitHubPort, freezes: FreezeStore, repo: RepoSlug, baseRef: string, lastRead: Map<string, number>, at: number): Promise<boolean> {
  const key = repoKey(repo);
  const previous = lastRead.get(key);
  if (previous !== undefined && at - previous < FREEZE_RECHECK_MS) return false;
  lastRead.set(key, at);
  const freeze = freezes.get(repo);
  if (!freeze) return true;
  try {
    const green = await greenHead(port, repo, baseRef, freeze.redSha);
    return green !== undefined && freezes.unfreeze(repo, green);
  } catch {
    return false;
  }
}
