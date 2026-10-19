import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { widenEventKinds } from "./events.js";
import { REPAIR_STOP_DDL } from "./repair-stop.js";

const TABLE_DDL = `
  CREATE TABLE shepherd_registration (
    repo        TEXT NOT NULL,
    pr          INTEGER,
    branch      TEXT,
    run_id      TEXT NOT NULL UNIQUE,
    task        TEXT NOT NULL,
    implementer TEXT NOT NULL,
    reviewer    TEXT,
    policy      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    held        INTEGER NOT NULL DEFAULT 0,
    hold_reason TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK (pr IS NOT NULL OR branch IS NOT NULL)
  );
  CREATE UNIQUE INDEX shepherd_registration_pr ON shepherd_registration (repo, pr) WHERE pr IS NOT NULL;
  CREATE UNIQUE INDEX shepherd_registration_branch ON shepherd_registration (repo, branch);`;

export function shepherdMigration(version = 4): Migration {
  return { version, name: "factory:shepherd_registration", up: (db) => db.exec(TABLE_DDL) };
}

export function sliceMigration(version = 8): Migration {
  return { version, name: "factory:shepherd_registration_slice", up: (db) => db.exec("ALTER TABLE shepherd_registration ADD COLUMN slice TEXT") };
}

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

const TP2383_DDL = `
  CREATE TABLE shepherd_park_settled (
    run_id   TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    agent    TEXT NOT NULL,
    parked   INTEGER NOT NULL,
    detail   TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (run_id, head_sha, agent)
  );`;

/** A park refusal whose exit retry settled, per run, head and agent, so a replay after a restart does not arm it again. */
export function parkSettledMigration(version = 21): Migration {
  return { version, name: "factory:shepherd_park_settled", up: (db) => db.exec(TP2383_DDL) };
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

const TP2556_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN head_sha TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN base TEXT;`;

/** The head and base branch a registration named, so Shepherd diffs the PR in its git cache instead of asking GitHub. */
export function registrationFactsMigration(version = 24): Migration {
  return { version, name: "factory:shepherd_registration_head_base", up: (db) => db.exec(TP2556_DDL) };
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

/** A seat's per-PR and per-path stops on fixer dispatch, and the event kinds that record setting and clearing them. */
export function repairStopMigration(version = 31): Migration {
  return { version, name: "factory:shepherd_repair_stop", up: (db) => {
    db.exec(REPAIR_STOP_DDL);
    widenEventKinds(db);
  } };
}
