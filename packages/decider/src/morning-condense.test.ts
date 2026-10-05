import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlaybookStore, memoryMigration } from "@titan-design/memory";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { condense, condenseWatermarks, type CondenseStore, type Reflector, type ReflectorInput } from "./condense.js";
import { extractSource } from "./extract.js";
import { POLICY } from "./fixtures.js";
import { initiativesOfTaskIds, morningSource } from "./morning.js";
import { principleBullet } from "./principles.js";
import { LedgerStore } from "./store.js";

/** Synthetic pair: ws12 names one widgets task, ws13 a human-only one, ws14 two initiatives, ws15 none. */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "morning-initiatives");
const NOW = new Date("2026-10-02T00:00:00Z");
const CLAIMED = "morning:2026-10-01/ws12";
const prefixes = new Map([["WG", ["widgets"]], ["GD", ["garden-diary"]], ["WS", ["workspace"]]]);
const resolveInitiatives = initiativesOfTaskIds((id) => prefixes.get(id.split("-")[0] ?? "") ?? []);

function recording(principleId: string): Reflector & { calls: ReflectorInput[] } {
  const calls: ReflectorInput[] = [];
  const reflector: Reflector = async (input) => {
    calls.push(input);
    return [{ type: "cite", rowKey: CLAIMED, principleId, verdict: "agrees" }];
  };
  return Object.assign(reflector, { calls });
}

describe("a Morning owner answer through extract and condense", () => {
  let db: Db;
  let ledger: LedgerStore;
  let store: CondenseStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    ledger = new LedgerStore(db);
    store = { playbook: new PlaybookStore(db, { now: () => NOW }), watermarks: condenseWatermarks(db) };
  });

  afterEach(() => db.close());

  async function run() {
    const principle = store.playbook.add(principleBullet({ rule: "Keep retry defaults conservative", domain: "tech_design", citedKeys: ["queue:seed"] }));
    const reflector = recording(principle.id);
    await extractSource(ledger, morningSource({ dir: DIR, resolveInitiatives }), POLICY);
    await condense(store, ledger.entries(), reflector, { now: NOW });
    return { principle, reflector, keysSeen: reflector.calls.flatMap((c) => c.rows.map((r) => r.key)) };
  }

  it("hands the claimed answer to the tech_design reflector", async () => {
    const { reflector } = await run();

    const techDesign = reflector.calls.filter((c) => c.domain === "tech_design");
    expect(techDesign).toHaveLength(1);
    expect(techDesign[0]?.rows).toContainEqual(expect.objectContaining({ key: CLAIMED, initiative: "widgets", answer: "yes" }));
  });

  it("keeps the human-only item out of the ledger and every reflector call", async () => {
    const { keysSeen } = await run();

    expect(ledger.rows().map((r) => r.key)).not.toContain("morning:2026-10-01/ws13");
    expect(keysSeen).not.toContain("morning:2026-10-01/ws13");
  });

  it("stores the unresolved items unclaimed and never reflects on them", async () => {
    const { keysSeen } = await run();

    const rows = new Map(ledger.rows().map((r) => [r.key, r]));
    for (const id of ["ws14", "ws15"]) {
      expect(rows.get(`morning:2026-10-01/${id}`)).toMatchObject({ unclaimed: true });
      expect(keysSeen).not.toContain(`morning:2026-10-01/${id}`);
    }
  });

  it("records the cite on the Morning row as feedback on the principle", async () => {
    const { principle } = await run();

    expect(store.playbook.feedbackFor(principle.id).map((e) => e.sessionRef)).toEqual([`ledger:${CLAIMED}`]);
  });
});
