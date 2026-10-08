import type { Migration } from "@titan-design/store-sqlite";

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
