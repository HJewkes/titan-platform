import type { Db, Migration } from "@titan-design/store-sqlite";

/** What the bot may write on GitHub. A merge's intent is the merge log's (`merge_op`); the others have rows here. */
export type BotActionKind = "review" | "merge" | "status" | "train-push";

type LoggedKind = Exclude<BotActionKind, "merge">;

const BOT_INTENT_DDL = `
  CREATE TABLE factory_bot_intent (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    repo    TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('review', 'status', 'train-push')),
    subject TEXT NOT NULL,
    at      TEXT NOT NULL
  );
  CREATE INDEX factory_bot_intent_subject ON factory_bot_intent (repo, kind, subject);
  CREATE TABLE factory_bot_unlogged (
    repo        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    action_id   TEXT NOT NULL,
    subject     TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (repo, kind, action_id)
  );
  CREATE TRIGGER factory_bot_intent_no_update BEFORE UPDATE ON factory_bot_intent
    BEGIN SELECT RAISE(ABORT, 'factory_bot_intent is append-only'); END;
  CREATE TRIGGER factory_bot_intent_no_delete BEFORE DELETE ON factory_bot_intent
    BEGIN SELECT RAISE(ABORT, 'factory_bot_intent is append-only'); END;
  CREATE TRIGGER factory_bot_unlogged_no_delete BEFORE DELETE ON factory_bot_unlogged
    BEGIN SELECT RAISE(ABORT, 'a not-factory mark is never cleared'); END;`;

/**
 * TP-3094 C7: the bot's intent rows for reviews, statuses and train pushes, written before the call as `merge_op`'s are,
 * and the marks the reconciler leaves on bot actions with none. 37 follows the reconciler cursor at 36.
 */
export function botIntentMigration(version = 37): Migration {
  return { version, name: "factory:bot_intent", up: (db) => db.exec(BOT_INTENT_DDL) };
}

/**
 * `subject` is what the writer knows before its call and the reconciler reads back after it: a review's `<pr>@<commit>`,
 * a status's `<sha>/<context>`, a train push's `<branch>@<sha>`.
 */
export function recordBotIntent(db: Db, intent: { repo: string; kind: LoggedKind; subject: string; at: string }): void {
  db.prepare("INSERT INTO factory_bot_intent (repo, kind, subject, at) VALUES (?, ?, ?, ?)").run(intent.repo, intent.kind, intent.subject, intent.at);
}

/** A merge's subject is its PR number, matched against any `merge_op` intent on that PR. */
export function hasBotIntent(db: Db, repo: string, kind: BotActionKind, subject: string): boolean {
  const row =
    kind === "merge"
      ? db.prepare("SELECT 1 FROM merge_op WHERE kind = 'intent' AND repo = ? AND pr = ? LIMIT 1").get(repo, Number(subject))
      : db.prepare("SELECT 1 FROM factory_bot_intent WHERE repo = ? AND kind = ? AND subject = ? LIMIT 1").get(repo, kind, subject);
  return row !== undefined;
}

/** True only the first time an action is marked, so its alarm is raised once however many passes re-read it. */
export function markNotFactory(db: Db, action: { repo: string; kind: BotActionKind; id: string; subject: string; observedAt: string }): boolean {
  const insert = db.prepare("INSERT OR IGNORE INTO factory_bot_unlogged (repo, kind, action_id, subject, observed_at) VALUES (?, ?, ?, ?, ?)");
  return insert.run(action.repo, action.kind, action.id, action.subject, action.observedAt).changes === 1;
}

/** What any count of the factory's approvals must exclude: a bot review the reconciler found with no intent row. */
export function isNotFactory(db: Db, repo: string, kind: BotActionKind, id: string): boolean {
  return db.prepare("SELECT 1 FROM factory_bot_unlogged WHERE repo = ? AND kind = ? AND action_id = ?").get(repo, kind, id) !== undefined;
}
