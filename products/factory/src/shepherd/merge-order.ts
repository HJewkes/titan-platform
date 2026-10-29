import type { RepoSlug } from "@titan-design/github";
import { compileGlobs } from "@titan-design/fix-proof";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import { appendEvent } from "./events.js";
import generatedPathsJson from "./generated-paths.json" with { type: "json" };
import mergeOrderJson from "./merge-order.json" with { type: "json" };
import type { Registration } from "./store.js";

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

/** Who ended a reservation and why: the run itself when it ends, or a seat's break-glass `shepherd order clear`. */
interface OrderRelease {
  at: string;
  actor?: string;
  reason?: string;
}

export class MergeOrder {
  private readonly runs: WorkflowRunStore;

  constructor(private readonly db: Db) {
    this.runs = new WorkflowRunStore(db);
  }

  /** A repeat for the same run replaces its row; each write is logged as an `order-reserve` event in the same transaction. */
  reserve(reservation: Reservation): void {
    const { repo, runId, pr, headSha, baseSha, paths, ahead, since, reason } = reservation;
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO shepherd_merge_order (repo, run_id, pr, head_sha, base_sha, paths, ahead, since, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(repo.toLowerCase(), runId, pr, headSha, baseSha, JSON.stringify(paths), JSON.stringify(ahead), since, reason);
      appendEvent(this.db, { runId, repo, pr, kind: "order-reserve", reason: `${reason}: ${paths.length} path(s), ${ahead.length} run(s) merging ahead`, at: since, headSha });
    })();
  }

  /** False, writing nothing, when the run held no reservation. */
  release(repo: RepoSlug, runId: string, by: OrderRelease): boolean {
    return this.drop(repo, runId, undefined, (own) => ({ kind: "order-release", reason: by.reason ?? "the run ended", at: by.at, actor: by.actor, headSha: own.headSha }));
  }

  /** Ends the reservation taken at `since` once, logging `order-expired`; false when it is gone or was taken again since. */
  expire(repo: RepoSlug, runId: string, since: string, at: string): boolean {
    return this.drop(repo, runId, since, (own) => ({ kind: "order-expired", reason: `unlanded past its TTL; reserved ${own.since}`, at, headSha: own.headSha }));
  }

  private drop(repo: RepoSlug, runId: string, since: string | undefined, event: (own: Reservation) => Omit<Parameters<typeof appendEvent>[1], "repo">): boolean {
    const own = this.list(repo).find((reservation) => reservation.runId === runId && (since === undefined || reservation.since === since));
    if (own === undefined) return false;
    return this.db.transaction(() => {
      const gone = this.db.prepare("DELETE FROM shepherd_merge_order WHERE repo = ? AND run_id = ? AND since = ?").run(repo.toLowerCase(), runId, own.since).changes > 0;
      if (gone) appendEvent(this.db, { repo, runId, pr: own.pr, ...event(own) });
      return gone;
    })();
  }

  list(repo: RepoSlug): Reservation[] {
    return z.array(Row).parse(this.db.prepare("SELECT * FROM shepherd_merge_order WHERE repo = ? ORDER BY since, run_id").all(repo.toLowerCase())).map(fromRow);
  }

  listAll(): Reservation[] {
    return z.array(Row).parse(this.db.prepare("SELECT * FROM shepherd_merge_order ORDER BY repo, since, run_id").all()).map(fromRow);
  }

  isDriving(runId: string): boolean {
    const run = this.runs.get(runId);
    return run !== undefined && DRIVING.has(run.status);
  }

  /** Every running run, of any workflow and repo; the reserve step narrows them to the repo's shepherd-pr runs. */
  driving(): WorkflowRun[] {
    return this.runs.listByStatus(["running"]);
  }

  /** Logs the wait a merge step's guard just started reading, so `shepherd timeline` shows what the merge waits on. */
  noteWait(runId: string, wait: OrderWait, at: string, headSha: string | undefined): void {
    appendEvent(this.db, { runId, repo: wait.repo, pr: wait.pr, kind: "order-wait", reason: wait.reason, at, headSha });
  }
}

/** The registration facts that say a person holds a run. */
export interface RunHolds {
  byRun(runId: string): Pick<Registration, "held" | "holdSatisfied" | "ownerHold"> | undefined;
}

/** An owner hold, or a hold no reviewer has satisfied; a satisfied hold lets the run merge at that head, so it still drives. */
const registrationHeld = (registration: ReturnType<RunHolds["byRun"]>): boolean => registration?.held === true && (registration.ownerHold !== null || registration.holdSatisfied === null);

/**
 * Driving, and not held by its registration. A held reserver waits on a person, so its reservation stops ordering peers
 * while the hold lasts instead of until its TTL (TP-4133). Only the registration is read, never the merge guard, which
 * reads this predicate.
 */
export function orderDriving(order: MergeOrder, holds: RunHolds): (runId: string) => boolean {
  return (runId) => order.isDriving(runId) && !registrationHeld(holds.byRun(runId));
}

/** A store bound to whichever factory database the host opened; reading it unbound throws, so a merge fails closed. */
interface MergeOrderRef {
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

export const withinTtl = (reservation: Reservation, rule: MergeOrderRule, now: number): boolean => now - Date.parse(reservation.since) < rule.ttlMinutes * 60_000;

/**
 * The reservations `self` must wait behind: live (driving and younger than the TTL), not its own, overlapping, taken
 * before self's own reservation when it holds one, and not one self was already merging ahead of (`ahead`). Whether
 * each blocker's PR is still open is read after this.
 */
export function blockers(self: OrderSelf, reservations: readonly Reservation[], rule: MergeOrderRule, now: number, driving: (runId: string) => boolean): Blocker[] {
  const own = reservations.find((reservation) => reservation.runId === self.runId);
  const live = (reservation: Reservation): boolean => withinTtl(reservation, rule, now) && driving(reservation.runId);
  return reservations
    .filter((reservation) => reservation.runId !== self.runId && !reservation.ahead.includes(self.runId) && (own === undefined || before(reservation, own)) && live(reservation))
    .map((reservation) => ({ reservation, shared: self.unread ? [] : overlapping(self.repo, self.paths, reservation.paths, rule) }))
    .filter((blocker) => self.unread === true || blocker.shared.length > 0);
}

/** The merge-order wait a run's merge step read last; kept in serve's memory, for `shepherd status` and `shepherd order`. */
export interface OrderWait {
  repo: string;
  pr: number;
  behind: number;
  reason: string;
}

/** Keyed by run id; a merge step that reads no blocker drops its run's entry. */
export type OrderWaits = Map<string, OrderWait>;
