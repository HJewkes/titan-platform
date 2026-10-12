import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

const TP734_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN hold_reviewer TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN release_ready_head TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN release_ready_at TEXT;`;

/** The hold's structured reviewer, and the head at which a Version Packages PR passed its release preflight. */
export function holdReviewerMigration(version = 9): Migration {
  return { version, name: "factory:shepherd_registration_hold_reviewer_release_ready", up: (db) => db.exec(TP734_DDL) };
}

const TP779_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN hold_satisfied_head TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN hold_satisfied_by TEXT;`;

/** The head at which a hold's named reviewer sent MERGE, and the verdict's author and locator. */
export function holdSatisfiedMigration(version = 11): Migration {
  return { version, name: "factory:shepherd_registration_hold_satisfied", up: (db) => db.exec(TP779_DDL) };
}

const TP2254_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN review_request_head TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN review_request_at TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN review_request_taken_at TEXT;`;

/** The head a seat asked Shepherd's own reviewer to review, when it asked, and when a run's review intent took the ask. */
export function reviewRequestMigration(version = 18): Migration {
  return { version, name: "factory:shepherd_registration_review_request", up: (db) => db.exec(TP2254_DDL) };
}

const TP2239_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN parked_reason TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN parked_reviewer TEXT;
  CREATE TABLE shepherd_vouch (
    run_id    TEXT NOT NULL,
    from_head TEXT NOT NULL,
    head      TEXT NOT NULL,
    base_ref  TEXT NOT NULL,
    base      TEXT NOT NULL,
    at        TEXT NOT NULL,
    PRIMARY KEY (run_id, from_head, head, base_ref)
  );`;

/** A hold kept under a run's `g10-adversary` hold, and the heads proven clean merge-ups of a head the seat released it at, per base branch. */
export function holdSlotsMigration(version = 19): Migration {
  return { version, name: "factory:shepherd_hold_slots_vouch", up: (db) => db.exec(TP2239_DDL) };
}

const OWNER_HOLD_COLUMNS = ["owner_hold_reason", "owner_hold_at", "owner_hold_asked_at"];

/** Adds only the columns a database lacks, so a store that already has them opens unchanged. */
function addOwnerHoldColumns(db: Db): void {
  const present = new Set(z.array(z.looseObject({ name: z.string() })).parse(db.prepare("PRAGMA table_info(shepherd_registration)").all()).map((column) => column.name));
  for (const column of OWNER_HOLD_COLUMNS.filter((name) => !present.has(name))) db.exec(`ALTER TABLE shepherd_registration ADD COLUMN ${column} TEXT`);
}

/** An owner-asked hold's own slot: its reason, when it was placed, and when the owner was last asked about it. */
export function ownerHoldMigration(version = 22): Migration {
  return { version, name: "factory:shepherd_registration_owner_hold", up: addOwnerHoldColumns };
}

const LINEAGE_DDL = `
  CREATE TABLE shepherd_lineage (
    run_id      TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('implementer', 'successor')),
    predecessor TEXT,
    at          TEXT NOT NULL,
    PRIMARY KEY (run_id, agent_id)
  );`;

export function lineageMigration(version = 5): Migration {
  return { version, name: "factory:shepherd_lineage", up: (db) => db.exec(LINEAGE_DDL) };
}
