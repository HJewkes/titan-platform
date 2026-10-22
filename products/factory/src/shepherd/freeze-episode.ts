import type { RepoSlug } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { appendEvent, SHEPHERD_ACTOR } from "./events.js";

/** The freeze-event reason that claims an episode's one rerun; a check run id follows. */
const rerunPrefix = (episode: number): string => `main rerun: episode ${episode} after `;
/** The thaw-event reason of a thaw on Shepherd's own green rerun; the failing tests follow as JSON. */
const RERUN_THAW = "rerun-green (flake suspected):";

const ReasonRow = z.object({ run_id: z.string().nullable(), reason: z.string() });

/** What the episode records need of their freeze store: the live episode's red sha, and the one thaw path. */
interface EpisodeFreezes {
  live(repo: RepoSlug, episode: number): { redSha: string } | undefined;
  release(repo: RepoSlug, episode: number, actor: string, reason: string): boolean;
}

/**
 * Episode writes past the freeze row's own setters: who may be linked as its fixer, and Shepherd's one rerun per episode
 * (decision 525), kept as freeze and thaw events so no table changes.
 */
export interface EpisodeRecords {
  /**
   * Hands live `episode` a standing fixer and its task only while it has no fixer, fix task or marked fix PR, so a fixer
   * already exempt keeps its exemption for the rest of the episode.
   */
  linkFix(repo: RepoSlug, episode: number, task: string, fixer: string): "linked" | "kept" | "not-live";
  /**
   * Claims live `episode`'s one rerun of the red sha's failed jobs for `runId`, recording `after`, the newest check run
   * id at the red sha before the rerun, so only runs past it count as the rerun. The same run gets its own claim back
   * after a restart, not `fresh`, so it waits on the rerun it queued; any other run, or a thawed episode, gets undefined.
   */
  claimRerun(repo: RepoSlug, episode: number, runId: string, after: number): { after: number; fresh: boolean } | undefined;
  /** `episode`'s rerun claim, if one was made: the run that made it and the check run id it recorded. */
  rerunClaim(repo: RepoSlug, episode: number): { runId: string | null; after: number } | undefined;
  /** Thaws live `episode` on Shepherd's own green rerun at the red sha, recording the failing tests `rerunThawedTests` reads. */
  thawOnRerun(repo: RepoSlug, episode: number, tests: readonly string[]): boolean;
  /** The failing tests of each rerun thaw of `repo` at or after `since` (ISO time). */
  rerunThawedTests(repo: RepoSlug, since: string): string[];
}

/** An unreadable list names no test, which leaves the 24 h guard as if no thaw had happened. */
function testsOf(reason: string): string[] {
  try {
    return z.array(z.string()).catch([]).parse(JSON.parse(reason.slice(RERUN_THAW.length + 1)));
  } catch {
    return [];
  }
}

interface Records {
  db: Db;
  now: () => number;
  freezes: EpisodeFreezes;
  repoKey: (repo: RepoSlug) => string;
}

const LINK_FIX = "UPDATE shepherd_freeze SET fix_task = ?, fixer = ? WHERE repo = ? AND episode = ? AND thawed_at IS NULL AND fix_task IS NULL AND fixer IS NULL AND fix_pr IS NULL";

function linkFix({ db, freezes, repoKey }: Records, repo: RepoSlug, episode: number, task: string, fixer: string): "linked" | "kept" | "not-live" {
  if (db.prepare(LINK_FIX).run(task, fixer, repoKey(repo), episode).changes > 0) return "linked";
  return freezes.live(repo, episode) ? "kept" : "not-live";
}

function rerunClaim({ db, repoKey }: Records, repo: RepoSlug, episode: number): { runId: string | null; after: number } | undefined {
  const prefix = rerunPrefix(episode);
  const row = db.prepare("SELECT run_id, reason FROM shepherd_event WHERE repo = ? AND kind = 'freeze' AND reason LIKE ? ORDER BY id LIMIT 1").get(repoKey(repo), `${prefix}%`);
  if (row === undefined) return undefined;
  const claimed = ReasonRow.parse(row);
  return { runId: claimed.run_id, after: Number(claimed.reason.slice(prefix.length)) };
}

function claimRerun(records: Records, repo: RepoSlug, episode: number, runId: string, after: number): { after: number; fresh: boolean } | undefined {
  const { db, now, freezes } = records;
  return db.transaction(() => {
    const live = freezes.live(repo, episode);
    if (!live) return undefined;
    const claimed = rerunClaim(records, repo, episode);
    if (claimed !== undefined) return claimed.runId === runId ? { after: claimed.after, fresh: false } : undefined;
    appendEvent(db, { repo, runId, kind: "freeze", at: new Date(now()).toISOString(), headSha: live.redSha, reason: `${rerunPrefix(episode)}${after}` });
    return { after, fresh: true };
  }).immediate();
}

function rerunThawedTests({ db, repoKey }: Records, repo: RepoSlug, since: string): string[] {
  const rows = db.prepare("SELECT run_id, reason FROM shepherd_event WHERE repo = ? AND kind = 'thaw' AND at >= ? AND reason LIKE ?").all(repoKey(repo), since, `${RERUN_THAW} %`);
  return rows.flatMap((row) => testsOf(ReasonRow.parse(row).reason));
}

export function episodeRecords(db: Db, now: () => number, freezes: EpisodeFreezes, repoKey: (repo: RepoSlug) => string): EpisodeRecords {
  const records: Records = { db, now, freezes, repoKey };
  return {
    linkFix: (repo, episode, task, fixer) => linkFix(records, repo, episode, task, fixer),
    rerunClaim: (repo, episode) => rerunClaim(records, repo, episode),
    claimRerun: (repo, episode, runId, after) => claimRerun(records, repo, episode, runId, after),
    thawOnRerun: (repo, episode, tests) => freezes.release(repo, episode, SHEPHERD_ACTOR, `${RERUN_THAW} ${JSON.stringify(tests)}`),
    rerunThawedTests: (repo, since) => rerunThawedTests(records, repo, since),
  };
}
