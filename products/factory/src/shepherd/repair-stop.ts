import { compileGlobs } from "@titan-design/fix-proof";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { appendEvent, type EventContext } from "./events.js";
import { pinnedPaths } from "./pr-changed-paths.js";

/**
 * A seat's stop on fixer dispatch, for one PR (`#N`) or for every PR whose changed files match a path glob. It is not a
 * hold and not the main-red freeze: it gates no merge and lifts nothing, and only stops Shepherd waking or resuming a fixer.
 */
const RepairStopRow = z.object({ repo: z.string(), scope: z.string(), reason: z.string(), actor: z.string(), at: z.string() });
export type RepairStop = z.infer<typeof RepairStopRow>;

export const REPAIR_STOP_DDL = `
  CREATE TABLE shepherd_repair_stop (
    repo   TEXT NOT NULL,
    scope  TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor  TEXT NOT NULL,
    at     TEXT NOT NULL,
    PRIMARY KEY (repo, scope)
  );`;

export interface RepairStopTarget {
  repo: RepoSlug;
  /** `#N` for one PR, else a path glob such as `packages/tool-guard/**`. */
  scope: string;
  /** The run a `#N` stop names, so `shepherd timeline` shows the stop on that run; a glob stop shows on every run of its repo. */
  runId?: string;
}

const prOfScope = (scope: string): number | null => (/^#\d+$/.test(scope) ? Number(scope.slice(1)) : null);

/** `owner/repo#N` or `owner/repo:<glob>`; undefined for anything else. */
export function parseStopRef(ref: string): { repo: string; scope: string } | undefined {
  const match = /^([\w.-]+\/[\w.-]+)(#\d+)$/.exec(ref) ?? /^([\w.-]+\/[\w.-]+):(\S+)$/.exec(ref);
  return match ? { repo: match[1]!, scope: match[2]! } : undefined;
}

export interface RepairStopTable {
  set(target: RepairStopTarget, reason: string, by?: EventContext): RepairStop;
  /** False, writing nothing, when no such stop is set. */
  clear(target: RepairStopTarget, by?: EventContext): boolean;
  list(repo?: RepoSlug): RepairStop[];
}

/** Each write records a `repair-stop` or `repair-go` event in the same transaction, so the history never misses a change. */
export function repairStopTable(db: Db, stamp: () => string): RepairStopTable {
  const record = (target: RepairStopTarget, kind: "repair-stop" | "repair-go", reason: string, at: string, by: EventContext) =>
    appendEvent(db, { runId: target.runId ?? null, repo: target.repo, pr: prOfScope(target.scope), kind, reason: `${target.scope}: ${reason}`, at, ...by });
  const list = (repo?: RepoSlug): RepairStop[] =>
    z.array(RepairStopRow).parse(repo === undefined ? db.prepare("SELECT * FROM shepherd_repair_stop ORDER BY repo, scope").all() : db.prepare("SELECT * FROM shepherd_repair_stop WHERE repo = ? ORDER BY scope").all(repo.toLowerCase()));
  return {
    set: (target, reason, by = {}) => {
      const stop: RepairStop = { repo: target.repo.toLowerCase(), scope: target.scope, reason, actor: by.actor ?? "unknown", at: stamp() };
      db.transaction(() => {
        db.prepare("INSERT OR REPLACE INTO shepherd_repair_stop (repo, scope, reason, actor, at) VALUES (?, ?, ?, ?, ?)").run(stop.repo, stop.scope, stop.reason, stop.actor, stop.at);
        record(target, "repair-stop", reason, stop.at, by);
      })();
      return stop;
    },
    clear: (target, by = {}) =>
      db.transaction(() => {
        const gone = db.prepare("DELETE FROM shepherd_repair_stop WHERE repo = ? AND scope = ?").run(target.repo.toLowerCase(), target.scope).changes > 0;
        if (gone) record(target, "repair-go", "cleared", stamp(), by);
        return gone;
      })(),
    list,
  };
}

interface StopTarget {
  repo: RepoSlug;
  pr: number;
  headSha: string;
}

/**
 * The stop that covers this PR at this head: its own `#N` stop first, else the first glob any changed file matches. A
 * file list that cannot be read counts as matching, because a seat that stopped a path would rather wait than see a push.
 */
export async function stopCovering(port: GitHubPort, stops: readonly RepairStop[], target: StopTarget): Promise<RepairStop | undefined> {
  const own = stops.find((stop) => prOfScope(stop.scope) === target.pr);
  const globs = stops.filter((stop) => prOfScope(stop.scope) === null);
  if (own || globs.length === 0) return own;
  const read = await pinnedPaths(port, { repo: target.repo, pr: target.pr, head: target.headSha }, target.headSha);
  if (read.unread !== undefined) return globs[0];
  return globs.find((stop) => read.paths.some(compileGlobs([stop.scope])));
}
