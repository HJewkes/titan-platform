import type { RepoSlug } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { appendEvent, SHEPHERD_ACTOR } from "./events.js";

/** The freeze-event reason that claims an episode's one rerun; a check run id follows. */
const rerunPrefix = (episode: number): string => `main rerun: episode ${episode} after `;
/** The thaw-event reason of a thaw on Shepherd's own green rerun; the failing tests follow as JSON. */
const RERUN_THAW = "rerun-green (flake suspected):";
/** The thaw-event reason of `shepherd thaw`; the caller's own reason follows. */
const HAND_THAW = "hand thaw:";

/** The freeze-event reasons of a new episode; only the freeze that opens one writes them. */
export const EPISODE_OPENED = { red: "main red", cancelOnly: "main red from cancelled runs only" } as const;

const ReasonRow = z.object({ run_id: z.string().nullable(), reason: z.string() });
const ShaRow = z.object({ head_sha: z.string() });

/** What the episode records need of their freeze store: the live episode and its red sha, and the one thaw path. */
interface EpisodeFreezes {
  live(repo: RepoSlug, episode: number): { redSha: string } | undefined;
  get(repo: RepoSlug): { redSha: string; episode: number; fixTask: string | null } | undefined;
  release(repo: RepoSlug, episode: number, actor: string, reason: string): boolean;
}

/** A hand thaw's outcome: `red-moved` names the red sha the episode holds now, which the caller did not name. */
type HandThaw = { outcome: "thawed"; episode: number; fixTask: string | null } | { outcome: "red-moved"; episode: number; redSha: string } | { outcome: "not-frozen" };

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
   * The red sha that opened live `episode`, which names its one fixer. A later red in the episode moves only the row's
   * red sha, so every run that reaches the spawn agrees on this one. Undefined when `episode` is not live.
   */
  firstRed(repo: RepoSlug, episode: number): string | undefined;
  /**
   * Claims live `episode`'s one rerun of the red sha's failed jobs for `runId`, recording `after`, the newest check run
   * id at the red sha before the rerun, so only runs past it count as the rerun. The same run gets its own claim back
   * after a restart, not `fresh`, so it waits on the rerun it queued; any other run, or a thawed episode, gets undefined.
   */
  claimRerun(repo: RepoSlug, episode: number, runId: string, after: number): { after: number; fresh: boolean } | undefined;
  /** `episode`'s rerun claim, if one was made: the run that made it and the check run id it recorded. */
  rerunClaim(repo: RepoSlug, episode: number): { runId: string | null; after: number } | undefined;
  /**
   * Thaws live `episode` on Shepherd's own green rerun at `redSha`, recording the failing tests `rerunThawedTests` reads.
   * A later red in the episode moves its red sha, and a green rerun of the earlier one must not thaw that.
   */
  thawOnRerun(repo: RepoSlug, episode: number, redSha: string, tests: readonly string[]): "thawed" | "red-moved" | "not-live";
  /** The failing tests of each rerun thaw of `repo` at or after `since` (ISO time). */
  rerunThawedTests(repo: RepoSlug, since: string): string[];
  /**
   * Thaws `repo`'s live episode by hand, only while its red sha is still `redSha`, so a red that moved since the caller
   * read it is never thawed blind. The thaw event names `actor` and `reason`; the episode's fix task is left as it is.
   */
  thawByHand(repo: RepoSlug, redSha: string, actor: string, reason: string): HandThaw;
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

/** The newest opening freeze event is the live episode's, since only a new episode writes one; a row with no event falls back to its red sha. */
function firstRed({ db, freezes, repoKey }: Records, repo: RepoSlug, episode: number): string | undefined {
  const live = freezes.live(repo, episode);
  if (!live) return undefined;
  const row = db.prepare("SELECT head_sha FROM shepherd_event WHERE repo = ? AND kind = 'freeze' AND pr IS NULL AND head_sha IS NOT NULL AND reason IN (?, ?) ORDER BY id DESC LIMIT 1").get(repoKey(repo), EPISODE_OPENED.red, EPISODE_OPENED.cancelOnly);
  return row === undefined ? live.redSha : ShaRow.parse(row).head_sha;
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

function thawOnRerun({ db, freezes }: Records, repo: RepoSlug, episode: number, redSha: string, tests: readonly string[]): "thawed" | "red-moved" | "not-live" {
  return db.transaction(() => {
    const live = freezes.live(repo, episode);
    if (!live) return "not-live";
    if (live.redSha !== redSha) return "red-moved";
    return freezes.release(repo, episode, SHEPHERD_ACTOR, `${RERUN_THAW} ${JSON.stringify(tests)}`) ? "thawed" : "not-live";
  }).immediate();
}

function thawByHand({ db, freezes }: Records, repo: RepoSlug, redSha: string, actor: string, reason: string): HandThaw {
  return db.transaction((): HandThaw => {
    const live = freezes.get(repo);
    if (!live) return { outcome: "not-frozen" };
    if (live.redSha.toLowerCase() !== redSha.toLowerCase()) return { outcome: "red-moved", episode: live.episode, redSha: live.redSha };
    return freezes.release(repo, live.episode, actor, `${HAND_THAW} ${reason}`) ? { outcome: "thawed", episode: live.episode, fixTask: live.fixTask } : { outcome: "not-frozen" };
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
    firstRed: (repo, episode) => firstRed(records, repo, episode),
    rerunClaim: (repo, episode) => rerunClaim(records, repo, episode),
    claimRerun: (repo, episode, runId, after) => claimRerun(records, repo, episode, runId, after),
    thawOnRerun: (repo, episode, redSha, tests) => thawOnRerun(records, repo, episode, redSha, tests),
    rerunThawedTests: (repo, since) => rerunThawedTests(records, repo, since),
    thawByHand: (repo, redSha, actor, reason) => thawByHand(records, repo, redSha, actor, reason),
  };
}
