import type { Db } from "@titan-design/store-sqlite";
import type { RegistrationRow } from "./registration-row.js";

/** What a registering caller read itself; with both, Shepherd diffs the PR in its git cache instead of asking GitHub. */
export interface RegistrationFactsInput {
  /** The PR's head as the registering caller saw it. */
  headSha?: string;
  /** The PR's base branch name. */
  base?: string;
  /** The PR says it is its task's last slice (`register --last-slice`); absent keeps the stored answer. */
  lastSlice?: boolean;
  /** The merged PR a `revert` registration undoes (`register --reverts owner/repo#n`, TP-5446 F14); absent keeps the stored one. */
  reverts?: string;
}

/** The head and base branch the latest registration named; null when it named none. `lastSlice` is false or absent unless one was marked. */
export interface RegistrationFacts {
  headSha: string | null;
  base: string | null;
  lastSlice?: boolean;
  /** Present only on a registration that named the PR it reverts. */
  reverts?: string;
}

/** A fact the caller omits keeps the stored one; a store opened without the facts migration is written only when one is given. */
export function writeRegistrationFacts(db: Db, runId: string, facts: RegistrationFactsInput): void {
  if (facts.reverts !== undefined) db.prepare("UPDATE shepherd_registration SET reverts = ? WHERE run_id = ?").run(facts.reverts, runId);
  if (facts.lastSlice !== undefined) db.prepare("UPDATE shepherd_registration SET last_slice = ? WHERE run_id = ?").run(facts.lastSlice ? 1 : 0, runId);
  if (facts.headSha === undefined && facts.base === undefined) return;
  db.prepare("UPDATE shepherd_registration SET head_sha = COALESCE(?, head_sha), base = COALESCE(?, base) WHERE run_id = ?").run(facts.headSha ?? null, facts.base ?? null, runId);
}

/** Who registered from a terminal with no agent-chat name (TP-5446 F15); no session of that name can be messaged. */
export const OWNER_REGISTRANT = "owner";

/**
 * The first agent registrant stays, so a successor's repeat registration never moves the run's notices to itself
 * (`registrantSeat`). `owner` holds only until an agent registers, so the owner registering first still lets an agent's
 * repeat take the notices, as before the owner was recorded. Whether it was the implementer is kept with it, since a later
 * registration may name another implementer.
 */
export function writeRegistrant(db: Db, runId: string, registrant: string | undefined, implementer: string): void {
  if (registrant === undefined) return;
  const replaceable = registrant === OWNER_REGISTRANT ? "registrant IS NULL" : `(registrant IS NULL OR registrant = '${OWNER_REGISTRANT}')`;
  const first = `UPDATE shepherd_registration SET registrant = ?, registrant_fixer = ? WHERE run_id = ? AND ${replaceable}`;
  db.prepare(first).run(registrant, registrant === implementer ? 1 : 0, runId);
}

/** The columns read as null on a row from before the facts migration. */
export function registrationFactsOf(row: RegistrationRow): RegistrationFacts {
  return { headSha: row.head_sha ?? null, base: row.base ?? null, lastSlice: row.last_slice === 1, ...(row.reverts && { reverts: row.reverts }) };
}
