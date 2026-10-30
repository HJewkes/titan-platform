import { openDatabase, runMigrations, type Db, type Migration } from '@titan-design/store-sqlite'
import { memoryHost, type MemoryHost } from './memory-host.js'
import type { AgentJournal, JournalRow } from './ports.js'

// `seq` is the order of the fold: a timestamp can repeat or run backwards across rows, an autoincrement cannot.
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'dispatch_journal',
    up: (db) => {
      db.exec(`
        CREATE TABLE dispatch_journal (
          seq      INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT,
          kind     TEXT NOT NULL,
          ts       INTEGER NOT NULL,
          actor    TEXT NOT NULL,
          target   TEXT,
          msg_id   TEXT,
          ref      TEXT,
          body     TEXT,
          meta     TEXT NOT NULL
        );
        CREATE INDEX dispatch_journal_agent ON dispatch_journal (agent_id, seq);`)
    },
  },
]

interface StoredRow {
  kind: string
  ts: number
  actor: string
  target: string | null
  msg_id: string | null
  ref: string | null
  body: string | null
  meta: string
}

const COLUMNS = 'kind, ts, actor, target, msg_id, ref, body, meta'

const agentIdOf = (row: JournalRow): string | null => (row.kind === 'agent_spawned' ? row.msgId : row.ref)

const toRow = (stored: StoredRow): JournalRow => ({
  kind: stored.kind,
  ts: stored.ts,
  actor: stored.actor,
  target: stored.target,
  msgId: stored.msg_id,
  ref: stored.ref,
  body: stored.body,
  meta: JSON.parse(stored.meta) as Record<string, string>,
})

function sqliteJournal(db: Db): AgentJournal {
  const insert = db.prepare(
    `INSERT INTO dispatch_journal (agent_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const all = db.prepare(`SELECT ${COLUMNS} FROM dispatch_journal ORDER BY seq`)
  const forAgent = db.prepare(`SELECT ${COLUMNS} FROM dispatch_journal WHERE agent_id = ? ORDER BY seq`)
  return {
    append: (row) => {
      insert.run(
        agentIdOf(row),
        row.kind,
        row.ts,
        row.actor,
        row.target,
        row.msgId,
        row.ref,
        row.body,
        JSON.stringify(row.meta),
      )
    },
    rows: () => (all.all() as StoredRow[]).map(toRow),
    rowsFor: (agentId) => (forAgent.all(agentId) as StoredRow[]).map(toRow),
  }
}

export interface SqliteHost extends MemoryHost {
  close(): void
}

/**
 * The same ports as `memoryHost`, with the journal kept in a SQLite file so a restart folds the same rows.
 * Presence, admission and holds stay in memory: they die with the process by design.
 */
export function sqliteHost(dbPath: string): SqliteHost {
  const db = openDatabase(dbPath)
  runMigrations(db, MIGRATIONS)
  return { ...memoryHost(), journal: sqliteJournal(db), close: () => db.close() }
}
