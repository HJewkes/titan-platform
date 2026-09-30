import {
  GITHUB_ACTIONS_APP_ID,
  headCheckFindings,
  type GitHubPort,
  type RepoSlug,
} from "@titan-design/github";
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
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** A repeat of the same red sha changes nothing; a later red sha in a live freeze counts up; a thawed repo starts a new episode. */
  freeze(repo: RepoSlug, redSha: string): Freeze {
    const row = this.row(repo);
    if (row && row.thawed_at === null) {
      if (row.red_sha !== redSha)
        this.db
          .prepare(
            "UPDATE shepherd_freeze SET red_sha = ?, red_count = red_count + 1 WHERE repo = ?"
          )
          .run(redSha, repoKey(repo));
    } else {
      this.db
        .prepare(
          `INSERT INTO shepherd_freeze (repo, red_sha, red_count, frozen_at, episode) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (repo) DO UPDATE SET red_sha = excluded.red_sha, fix_task = NULL, fixer = NULL, red_count = 1, frozen_at = excluded.frozen_at, episode = excluded.episode, thawed_at = NULL`
        )
        .run(
          repoKey(repo),
          redSha,
          new Date(this.now()).toISOString(),
          (row?.episode ?? 0) + 1
        );
    }
    return this.active(repo)!;
  }

  setFixTask(repo: RepoSlug, id: string): void {
    this.setField(repo, "fix_task", id);
  }

  setFixer(repo: RepoSlug, name: string): void {
    this.setField(repo, "fixer", name);
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
    this.db
      .prepare("UPDATE shepherd_freeze SET thawed_at = ? WHERE repo = ?")
      .run(new Date(this.now()).toISOString(), repoKey(repo));
    return true;
  }

  private setField(
    repo: RepoSlug,
    column: "fix_task" | "fixer",
    value: string
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE shepherd_freeze SET ${column} = ? WHERE repo = ? AND thawed_at IS NULL`
      )
      .run(value, repoKey(repo)).changes;
    if (changed === 0) throw new Error(`${repo} is not frozen`);
  }

  private row(repo: RepoSlug): Row | undefined {
    return this.db
      .prepare("SELECT * FROM shepherd_freeze WHERE repo = ?")
      .get(repoKey(repo)) as Row | undefined;
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
}

export function freezeStoreRef(now: () => number = Date.now): FreezeStoreRef {
  let store: FreezeStore | undefined;
  return {
    get() {
      if (!store)
        throw new Error(
          "the freeze store is not bound to an open factory database"
        );
      return store;
    },
    bind(db) {
      if (store)
        throw new Error(
          "the freeze store is already bound to an open factory database"
        );
      const bound = new FreezeStore(db, now);
      store = bound;
      return () => void (store === bound && (store = undefined));
    },
  };
}

/** The repo's default-branch head, when every run from Actions on it is complete and green and it is not the red sha. */
export async function greenHead(
  port: GitHubPort,
  repo: RepoSlug,
  baseRef: string,
  redSha: string
): Promise<string | undefined> {
  const head = await port.getHeadSha(repo, baseRef);
  if (head === null || head === redSha) return undefined;
  const runs = (await port.latestCheckRuns(repo, head)).filter(
    (run) => run.headSha === head && run.appId === GITHUB_ACTIONS_APP_ID
  );
  if (runs.length === 0) return undefined;
  return headCheckFindings({
    headSha: head,
    contexts: [],
    runs,
    requiredApps: [GITHUB_ACTIONS_APP_ID],
  }).length === 0
    ? head
    : undefined;
}

export interface RegistrationTasks {
  byPr(repo: RepoSlug, pr: number): { task: string } | undefined;
}

export interface FreezeGuardDeps {
  freezes: () => FreezeStore;
  registrations: () => RegistrationTasks;
  now?: () => number;
}

/** Why a merge of `repo#pr` waits on a frozen repo; a blocked read also re-reads the default branch, at most every five minutes per repo. */
export interface FreezeGuard {
  reason(
    port: GitHubPort,
    repo: RepoSlug,
    pr: number,
    baseRef: string
  ): Promise<string | undefined>;
}

export function freezeGuard(deps: FreezeGuardDeps): FreezeGuard {
  const now = deps.now ?? Date.now;
  const lastRead = new Map<string, number>();
  return {
    async reason(port, repo, pr, baseRef) {
      const freezes = deps.freezes();
      const freeze = freezes.get(repo);
      if (!freeze) return undefined;
      if (
        freeze.fixTask !== null &&
        deps.registrations().byPr(repo, pr)?.task === freeze.fixTask
      )
        return undefined;
      if (await recheck(port, freezes, repo, baseRef, lastRead, now()))
        return undefined;
      return `${repo} is frozen: main is red at ${freeze.redSha}`;
    },
  };
}

/** A failed read leaves the freeze in place, because the merge it guards is already blocked. */
async function recheck(
  port: GitHubPort,
  freezes: FreezeStore,
  repo: RepoSlug,
  baseRef: string,
  lastRead: Map<string, number>,
  at: number
): Promise<boolean> {
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
