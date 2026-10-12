import type { Db } from "@titan-design/store-sqlite";

/** One refused park: the run, the head it was refused at, and the agent whose tree stayed. */
export interface ParkKey {
  runId: string;
  headSha: string;
  agent: string;
}

export interface ParkSettle {
  parked: boolean;
  detail: string;
}

/** The first settle of a refusal wins, so a repeat cannot rewrite what the seat was told. */
export function settlePark(db: Db, key: ParkKey, outcome: ParkSettle, at: string): void {
  db.prepare("INSERT INTO shepherd_park_settled (run_id, head_sha, agent, parked, detail, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, head_sha, agent) DO NOTHING").run(key.runId, key.headSha, key.agent, outcome.parked ? 1 : 0, outcome.detail, at);
}

export function parkSettled(db: Db, key: ParkKey): boolean {
  return db.prepare("SELECT 1 FROM shepherd_park_settled WHERE run_id = ? AND head_sha = ? AND agent = ?").get(key.runId, key.headSha, key.agent) !== undefined;
}

/** A replacement run replays the failed run's park steps under its own id. */
export function repointParkSettled(db: Db, runId: string, newRunId: string): void {
  db.prepare("UPDATE shepherd_park_settled SET run_id = ? WHERE run_id = ?").run(newRunId, runId);
}
