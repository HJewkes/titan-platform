import type { Migration } from "@titan-design/store-sqlite";

const MERGE_LOG_TABLE = "merge_op";

/** The paths that merge; SQL leaves `path` unchecked because a CHECK cannot be altered without rebuilding the table. */
export const MERGE_PATHS = ["lander", "seat-merge", "shepherd-land-loop", "version-packages"] as const;

const MERGE_LOG_DDL = `
  CREATE TABLE ${MERGE_LOG_TABLE} (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL CHECK (kind IN ('intent', 'result')),
    intent_id    INTEGER REFERENCES ${MERGE_LOG_TABLE} (id),
    path         TEXT NOT NULL,
    drain        INTEGER NOT NULL DEFAULT 0 CHECK (drain IN (0, 1)),
    repo         TEXT NOT NULL,
    pr           INTEGER NOT NULL,
    head_sha     TEXT NOT NULL,
    reason_kind  TEXT NOT NULL CHECK (reason_kind IN ('item', 'gate', 'decision')),
    reason_id    TEXT NOT NULL,
    actor        TEXT NOT NULL,
    github_login TEXT,
    at           TEXT NOT NULL,
    outcome      TEXT CHECK (outcome IN ('merged', 'failed', 'unknown')),
    merge_commit TEXT,
    CHECK (
      (kind = 'intent' AND intent_id IS NULL AND outcome IS NULL AND merge_commit IS NULL)
      OR (kind = 'result' AND intent_id IS NOT NULL AND outcome IS NOT NULL
          AND ((outcome = 'merged') = (merge_commit IS NOT NULL)))
    )
  );
  CREATE INDEX ${MERGE_LOG_TABLE}_commit ON ${MERGE_LOG_TABLE} (repo, merge_commit) WHERE merge_commit IS NOT NULL;
  CREATE INDEX ${MERGE_LOG_TABLE}_pr ON ${MERGE_LOG_TABLE} (repo, pr, id);
  CREATE UNIQUE INDEX ${MERGE_LOG_TABLE}_one_terminal ON ${MERGE_LOG_TABLE} (intent_id)
    WHERE kind = 'result' AND outcome IN ('merged', 'failed');
  CREATE TRIGGER ${MERGE_LOG_TABLE}_result_pairs BEFORE INSERT ON ${MERGE_LOG_TABLE} WHEN NEW.kind = 'result'
    BEGIN SELECT RAISE(ABORT, '${MERGE_LOG_TABLE} result must name an intent of the same path, repo, pr and head')
      WHERE NOT EXISTS (SELECT 1 FROM ${MERGE_LOG_TABLE} i WHERE i.id = NEW.intent_id AND i.kind = 'intent'
        AND i.path = NEW.path AND i.repo = NEW.repo AND i.pr = NEW.pr AND i.head_sha = NEW.head_sha); END;
  CREATE TRIGGER ${MERGE_LOG_TABLE}_no_update BEFORE UPDATE ON ${MERGE_LOG_TABLE}
    BEGIN SELECT RAISE(ABORT, '${MERGE_LOG_TABLE} is append-only'); END;
  CREATE TRIGGER ${MERGE_LOG_TABLE}_no_delete BEFORE DELETE ON ${MERGE_LOG_TABLE}
    BEGIN SELECT RAISE(ABORT, '${MERGE_LOG_TABLE} is append-only'); END;`;

/**
 * Every merge the system makes: an intent row committed before the call, then result rows after it, paired by trigger.
 * An `unknown` result may precede the one terminal result. Rows join the event log on `owner/name` repos, full 40-hex
 * shas and `nowIso()` times. Triggers refuse UPDATE and DELETE for any writer; nothing writes or reads it yet.
 */
export function mergeLogMigration(version = 29): Migration {
  return { version, name: `factory:${MERGE_LOG_TABLE}`, up: (db) => db.exec(MERGE_LOG_DDL) };
}
