import { openDatabase } from "@titan-design/store-sqlite";
import { ownerFriction, type FrictionDay } from "../shepherd/owner-friction.js";
import { readAllGates } from "../shepherd/owner-friction-read.js";

/** Today's row (UTC), an empty one when no gate touched the owner today; opens the store read-only so a running serve is never disturbed. */
export function readFriction(dbPath: string, now: Date): FrictionDay {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const today = now.toISOString().slice(0, 10);
    return ownerFriction(readAllGates(db), now.getTime(), { from: today, to: today })[0] ?? { day: today, ownerTouches: 0, kinds: [] };
  } finally {
    db.close();
  }
}
