import { readTaskRows, type TaskRow } from "@titan-design/session-analytics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTicketScorecard, type ScorecardRunResult } from "./run.js";
import { ScorecardWorld } from "./run.fixture.js";

const SPAWNED = "2026-11-10T09:00:00.000Z";
const NOW = "2026-11-11T12:00:00.000Z";

let world: ScorecardWorld;

beforeEach(() => {
  world = new ScorecardWorld();
  for (const id of ["AA-1", "AA-2", "AA-3"]) world.task(id);
});

afterEach(() => world.close());

/** A dry run's counts, and its task rows keyed by task id. */
async function dryRun(): Promise<{ result: ScorecardRunResult; rows: Map<string, TaskRow> }> {
  let rows: TaskRow[] = [];
  const options = world.options(NOW, { storeFile: ":memory:", weeksDir: null, lockFile: null, rebuild: true, inspect: (store) => (rows = readTaskRows(store)) });
  const result = await runTicketScorecard(options);
  if ("locked" in result) throw new Error("a dry run takes no lock");
  return { result, rows: new Map(rows.map((r) => [r.taskId, r])) };
}

describe("ticket-scorecard origin link fallback", () => {
  it("a spawn without meta task links through the session origin and is marked inferred", async () => {
    world.untaskedSpawn("session-1", SPAWNED);
    world.origin("session-1", ["AA-1"], "brief-anchor");

    const { result, rows } = await dryRun();

    expect(rows.get("AA-1")).toMatchObject({ firstDispatchTs: SPAWNED, dispatcher: "seat-one", provenance: { firstDispatchTs: "inferred:brief-anchor" } });
    expect(result.originLinks).toEqual({ linked: 1, several: 0, none: 0, noOrigin: 0 });
  });

  it("a recorded meta task wins over the origin link", async () => {
    world.spawn("AA-1", SPAWNED, "seat-one", undefined, "session-1");
    world.origin("session-1", ["AA-2"], "name");

    const { result, rows } = await dryRun();

    expect([...rows.keys()]).toEqual(["AA-1"]);
    expect(rows.get("AA-1")?.provenance.firstDispatchTs).toBeUndefined();
    expect(result.originLinks).toEqual({ linked: 0, several: 0, none: 0, noOrigin: 0 });
  });

  it("an origin naming several tasks is left unlinked", async () => {
    world.untaskedSpawn("session-1", SPAWNED);
    world.origin("session-1", ["AA-1", "AA-2"], "name");
    world.untaskedSpawn("session-2", SPAWNED);
    world.origin("session-2", [], "none");
    world.untaskedSpawn("session-3", SPAWNED);

    const { result, rows } = await dryRun();

    expect(rows.size).toBe(0);
    expect(result.originLinks).toEqual({ linked: 0, several: 1, none: 1, noOrigin: 1 });
  });
});
