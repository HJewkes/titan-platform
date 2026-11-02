import type { Db } from "@titan-design/store-sqlite";

type IntentReader = (db: Db) => number;

/** An `unknown` result may precede the terminal one (merge-log.ts), so only `merged` or `failed` settles an intent. */
function openMergeIntents(db: Db): number {
  const open = db
    .prepare(
      `SELECT COUNT(*) FROM merge_op i WHERE i.kind = 'intent'
         AND NOT EXISTS (SELECT 1 FROM merge_op r WHERE r.kind = 'result' AND r.intent_id = i.id AND r.outcome IN ('merged', 'failed'))`,
    )
    .pluck()
    .get();
  return Number(open);
}

/** Per irreversible fact step, the count of its intents with no terminal result; the guard test keeps every such step covered. */
export const INTENT_READERS: Readonly<Record<string, IntentReader>> = { merge: openMergeIntents };

/** Throws for a step with no reader, so a deploy fails closed rather than reading it as settled. */
export function openIntentsIn(db: Db, steps: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    steps.map((step) => {
      const reader = INTENT_READERS[step];
      if (reader === undefined) throw new Error(`no intent reader for irreversible step ${step}`);
      return [step, reader(db)];
    }),
  );
}
