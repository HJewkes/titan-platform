import type { RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { appendEvent } from "./events.js";

/**
 * A coordinator's freeze on every merge into one repo, set by `shepherd freeze`. It is apart from the main-red freeze:
 * a green main never lifts it, and `shepherd unfreeze` never thaws a red main.
 */
const REPO_FREEZE_DDL = `
  CREATE TABLE shepherd_repo_freeze (
    repo   TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    actor  TEXT NOT NULL,
    since  TEXT NOT NULL
  );`;

export function repoFreezeMigration(version = 33): Migration {
  return { version, name: "factory:shepherd_repo_freeze", up: (db) => db.exec(REPO_FREEZE_DDL) };
}

const RepoFreezeRow = z.object({ repo: z.string(), reason: z.string(), actor: z.string(), since: z.string() });
export type RepoFreeze = z.infer<typeof RepoFreezeRow>;

export interface RepoFreezes {
  /** A repeat on a frozen repo replaces the reason and who set it, and keeps `since`. */
  freeze(repo: RepoSlug, reason: string, actor: string): RepoFreeze;
  /** False, writing nothing, when the repo is not frozen. */
  unfreeze(repo: RepoSlug, actor?: string): boolean;
  get(repo: RepoSlug): RepoFreeze | undefined;
  list(): RepoFreeze[];
}

export function repoFreezes(db: Db, now: () => number): RepoFreezes {
  const get = (repo: RepoSlug): RepoFreeze | undefined => {
    const row = db.prepare("SELECT * FROM shepherd_repo_freeze WHERE repo = ?").get(repo.toLowerCase());
    return row === undefined ? undefined : RepoFreezeRow.parse(row);
  };
  return {
    freeze: (repo, reason, actor) => {
      if (reason.trim() === "") throw new Error("a repo freeze needs a reason");
      const at = new Date(now()).toISOString();
      db.prepare("INSERT INTO shepherd_repo_freeze (repo, reason, actor, since) VALUES (?, ?, ?, ?) ON CONFLICT (repo) DO UPDATE SET reason = excluded.reason, actor = excluded.actor").run(repo.toLowerCase(), reason, actor, at);
      appendEvent(db, { repo, kind: "repo-freeze", at, actor, reason });
      return get(repo)!;
    },
    unfreeze: (repo, actor) => {
      const lifted = get(repo);
      const changed = db.prepare("DELETE FROM shepherd_repo_freeze WHERE repo = ?").run(repo.toLowerCase()).changes > 0;
      if (changed) appendEvent(db, { repo, kind: "repo-unfreeze", at: new Date(now()).toISOString(), actor, reason: lifted?.reason });
      return changed;
    },
    get,
    list: () => z.array(RepoFreezeRow).parse(db.prepare("SELECT * FROM shepherd_repo_freeze ORDER BY repo").all()),
  };
}
