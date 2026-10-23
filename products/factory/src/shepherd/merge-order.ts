import type { RepoSlug } from "@titan-design/github";
import { compileGlobs } from "@titan-design/fix-proof";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import generatedPathsJson from "./generated-paths.json" with { type: "json" };
import mergeOrderJson from "./merge-order.json" with { type: "json" };

/**
 * A conflicted PR's reservation of the paths it changes, so an overlapping PR waits at its merge until the conflicted
 * one lands, instead of moving the base under it again (TP-4098). One row per reserving run.
 */
const MERGE_ORDER_DDL = `
  CREATE TABLE shepherd_merge_order (
    repo     TEXT NOT NULL,
    run_id   TEXT NOT NULL,
    pr       INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    paths    TEXT NOT NULL,
    ahead    TEXT NOT NULL,
    since    TEXT NOT NULL,
    reason   TEXT NOT NULL,
    PRIMARY KEY (repo, run_id)
  );`;

export function mergeOrderMigration(version = 40): Migration {
  return { version, name: "factory:shepherd_merge_order", up: (db) => db.exec(MERGE_ORDER_DDL) };
}

export interface Reservation {
  repo: RepoSlug;
  runId: string;
  pr: number;
  headSha: string;
  baseSha: string;
  paths: string[];
  /** Runs already in their merge step when the reservation was taken; they land first. */
  ahead: string[];
  since: string;
  reason: string;
}

const Row = z.object({ repo: z.string(), run_id: z.string(), pr: z.number(), head_sha: z.string(), base_sha: z.string(), paths: z.string(), ahead: z.string(), since: z.string(), reason: z.string() });
const Strings = z.array(z.string());

const fromRow = (row: z.infer<typeof Row>): Reservation => ({
  ...{ repo: row.repo, runId: row.run_id, pr: row.pr, headSha: row.head_sha, baseSha: row.base_sha },
  ...{ paths: Strings.parse(JSON.parse(row.paths)), ahead: Strings.parse(JSON.parse(row.ahead)), since: row.since, reason: row.reason },
});

/** A paused, parked or finished run no longer drives its PR, so its reservation stops blocking, as the train judges its holder. */
const DRIVING: ReadonlySet<WorkflowStatus> = new Set(["running", "cancelling"]);

export class MergeOrder {
  private readonly runs: WorkflowRunStore;

  constructor(private readonly db: Db) {
    this.runs = new WorkflowRunStore(db);
  }

  /** A repeat for the same run replaces its row. */
  reserve(reservation: Reservation): void {
    const { repo, runId, pr, headSha, baseSha, paths, ahead, since, reason } = reservation;
    this.db.prepare("INSERT OR REPLACE INTO shepherd_merge_order (repo, run_id, pr, head_sha, base_sha, paths, ahead, since, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(repo.toLowerCase(), runId, pr, headSha, baseSha, JSON.stringify(paths), JSON.stringify(ahead), since, reason);
  }

  /** False, writing nothing, when the run held no reservation. */
  release(repo: RepoSlug, runId: string): boolean {
    return this.db.prepare("DELETE FROM shepherd_merge_order WHERE repo = ? AND run_id = ?").run(repo.toLowerCase(), runId).changes > 0;
  }

  list(repo: RepoSlug): Reservation[] {
    return z.array(Row).parse(this.db.prepare("SELECT * FROM shepherd_merge_order WHERE repo = ? ORDER BY since, run_id").all(repo.toLowerCase())).map(fromRow);
  }

  isDriving(runId: string): boolean {
    const run = this.runs.get(runId);
    return run !== undefined && DRIVING.has(run.status);
  }
}

/** A store bound to whichever factory database the host opened; reading it unbound throws, so a merge fails closed. */
export interface MergeOrderRef {
  get(): MergeOrder;
  bind(db: Db): () => void;
}

export function mergeOrderRef(): MergeOrderRef {
  let order: MergeOrder | undefined;
  return {
    get() {
      if (!order) throw new Error("the merge order is not bound to an open factory database");
      return order;
    },
    bind(db) {
      if (order) throw new Error("the merge order is already bound to an open factory database");
      const bound = new MergeOrder(db);
      order = bound;
      return () => void (order === bound && (order = undefined));
    },
  };
}

const MergeOrderRule = z.object({ enabled: z.boolean(), ttlMinutes: z.number().positive(), ignore: z.array(z.string()) });
export type MergeOrderRule = z.infer<typeof MergeOrderRule>;

/** Per repo, lowercased; a repo with no entry is never ordered. */
const RULES: Readonly<Record<string, MergeOrderRule>> = z.record(z.string(), MergeOrderRule).parse(mergeOrderJson);

export type MergeOrderRules = (repo: RepoSlug) => MergeOrderRule | undefined;

export const fileRules: MergeOrderRules = (repo) => RULES[repo.toLowerCase()];

/** Generated files and ignored globs never order two PRs: a tool rewrites the one and the other never conflicts for long. */
function counted(repo: RepoSlug, rule: MergeOrderRule): (path: string) => boolean {
  const generated: Readonly<Record<string, readonly string[]>> = generatedPathsJson;
  const skip = compileGlobs([...(generated[repo.toLowerCase()] ?? []), ...rule.ignore]);
  return (path) => !skip(path);
}

/** The paths both sides change that the rule counts, sorted; empty means the two PRs never wait on each other. */
export function overlapping(repo: RepoSlug, a: readonly string[], b: readonly string[], rule: MergeOrderRule): string[] {
  const theirs = new Set(b);
  return [...new Set(a)].filter((path) => theirs.has(path)).filter(counted(repo, rule)).sort();
}

/** The PR waiting at its merge: its run, and its changed paths, or `unread` when they could not be read at its head. */
export interface OrderSelf {
  repo: RepoSlug;
  runId: string;
  paths: readonly string[];
  unread?: boolean;
}

export interface Blocker {
  reservation: Reservation;
  /** Empty when self's paths are unread: an unknown list overlaps every reservation. */
  shared: string[];
}

/** Reserved earlier, the run id breaking a tie: the one order two reservations can stand in, so they never wait on each other. */
const before = (a: Reservation, b: Reservation): boolean => a.since < b.since || (a.since === b.since && a.runId < b.runId);

/**
 * The reservations `self` must wait behind: live (driving and younger than the TTL), not its own, overlapping, and
 * taken before self's own reservation when it holds one. Whether each blocker's PR is still open is read after this.
 */
export function blockers(self: OrderSelf, reservations: readonly Reservation[], rule: MergeOrderRule, now: number, driving: (runId: string) => boolean): Blocker[] {
  const own = reservations.find((reservation) => reservation.runId === self.runId);
  const live = (reservation: Reservation): boolean => now - Date.parse(reservation.since) < rule.ttlMinutes * 60_000 && driving(reservation.runId);
  return reservations
    .filter((reservation) => reservation.runId !== self.runId && (own === undefined || before(reservation, own)) && live(reservation))
    .map((reservation) => ({ reservation, shared: self.unread ? [] : overlapping(self.repo, self.paths, reservation.paths, rule) }))
    .filter((blocker) => self.unread === true || blocker.shared.length > 0);
}
