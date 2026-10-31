import { FAILURE_CLASSES, type ParkedRun, type ParkingPort } from "@titan-design/review-workflow";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/** The runs `review resolve` re-reviews; a resolve runs in a later process than the review that parked them, so they live on disk. */
export const reviewParkingMigration = (version: number): Migration => ({
  version,
  name: "review-parking",
  up: (db) => {
    db.exec("CREATE TABLE review_parked (run_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run_json TEXT NOT NULL)");
    db.exec("CREATE INDEX review_parked_fingerprint ON review_parked (fingerprint)");
    db.exec("CREATE TABLE review_fingerprint_round (fingerprint TEXT PRIMARY KEY, round INTEGER NOT NULL)");
  },
});

const ParkedRunSchema = z.object({
  runId: z.string(),
  target: z.object({ repo: z.string(), pr: z.number(), head: z.string() }),
  fingerprint: z.string(),
  failure: z.enum(FAILURE_CLASSES),
});
const RowsSchema = z.array(z.object({ run_json: z.string().transform((text): unknown => JSON.parse(text)).pipe(ParkedRunSchema) }));
const RoundSchema = z.object({ round: z.number() }).optional();

export function sqliteParking(db: Db): ParkingPort {
  const select = (fingerprint: string): ParkedRun[] =>
    RowsSchema.parse(db.prepare("SELECT run_json FROM review_parked WHERE fingerprint = ? ORDER BY rowid").all(fingerprint)).map((row) => row.run_json);
  const round = (fingerprint: string): number => RoundSchema.parse(db.prepare("SELECT round FROM review_fingerprint_round WHERE fingerprint = ?").get(fingerprint))?.round ?? 0;
  const release = db.transaction((fingerprint: string): ParkedRun[] => {
    const runs = select(fingerprint);
    db.prepare("DELETE FROM review_parked WHERE fingerprint = ?").run(fingerprint);
    db.prepare("INSERT INTO review_fingerprint_round (fingerprint, round) VALUES (?, 1) ON CONFLICT (fingerprint) DO UPDATE SET round = round + 1").run(fingerprint);
    return runs;
  });
  return {
    park: async (run) => void db.prepare("INSERT OR IGNORE INTO review_parked (run_id, fingerprint, run_json) VALUES (?, ?, ?)").run(run.runId, run.fingerprint, JSON.stringify(run)),
    parked: async (fingerprint) => select(fingerprint),
    release: async (fingerprint) => release(fingerprint),
    round: async (fingerprint) => round(fingerprint),
  };
}
