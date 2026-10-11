import type { GateRecord } from "@titan-design/hitl";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import type { Db } from "@titan-design/store-sqlite";

/** Every gate in the factory store, hydrated through the gate store. `db` may be read-only: the factory sets no gate expiry, so the store never writes on a read. */
export function readAllGates(db: Db): GateRecord[] {
  const gates = new SqliteGateStore(db, { migrate: false });
  const ids = db.prepare("SELECT id FROM hitl_gate ORDER BY created_at").all() as { id: string }[];
  return ids.flatMap(({ id }) => gates.get(id) ?? []);
}
