import type { Db } from "@titan-design/store-sqlite";
import type { RegistrationRow } from "./registration-row.js";

/** What a registering caller read itself; with both, Shepherd diffs the PR in its git cache instead of asking GitHub. */
export interface RegistrationFactsInput {
  /** The PR's head as the registering caller saw it. */
  headSha?: string;
  /** The PR's base branch name. */
  base?: string;
}

/** The head and base branch the latest registration named; null when it named none. */
export interface RegistrationFacts {
  headSha: string | null;
  base: string | null;
}

/** A fact the caller omits keeps the stored one; a store opened without the facts migration is written only when one is given. */
export function writeRegistrationFacts(db: Db, runId: string, facts: RegistrationFactsInput): void {
  if (facts.headSha === undefined && facts.base === undefined) return;
  db.prepare("UPDATE shepherd_registration SET head_sha = COALESCE(?, head_sha), base = COALESCE(?, base) WHERE run_id = ?").run(facts.headSha ?? null, facts.base ?? null, runId);
}

/**
 * The first registrant stays, so a successor's repeat registration never moves the run's notices to itself (`registrantSeat`).
 * Whether it was the implementer is kept with it, since a later registration may name another implementer.
 */
export function writeRegistrant(db: Db, runId: string, registrant: string | undefined, implementer: string): void {
  if (registrant === undefined) return;
  const first = "UPDATE shepherd_registration SET registrant = ?, registrant_fixer = ? WHERE run_id = ? AND registrant IS NULL";
  db.prepare(first).run(registrant, registrant === implementer ? 1 : 0, runId);
}

/** The columns read as null on a row from before the facts migration. */
export function registrationFactsOf(row: RegistrationRow): RegistrationFacts {
  return { headSha: row.head_sha ?? null, base: row.base ?? null };
}
