import { gateMigration, gateResolverMigration, SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { workflowMigration, workflowOwnershipMigration } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import type { ReviewBodyPorts } from "./bodies.js";
import { reviewRunner } from "./definition.js";
import { fakeWorld, merges, name, POLICY, request, TIMING } from "./review-world.test-helpers.js";
import { DEFAULT_REVIEW_STEP_IDS } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

const runnerFor = (db: Db, ports: ReviewBodyPorts, version?: string) =>
  reviewRunner({ ports, policy: { plan: POLICY, timing: TIMING }, ...(version !== undefined && { version }), runtime: { db, gates: new SqliteGateStore(db, { migrate: false }) } });

/** Starts a review and stops its process once both members are dispatched and the first await is in flight. */
async function interruptedAtAwait(db: Db, world: ReturnType<typeof fakeWorld>, version?: string): Promise<string> {
  world.world.readsHang = true;
  const first = runnerFor(db, world.ports, version);
  const runId = first.start(request);
  const awaiting = (): string[] => Object.keys(first.runtime.status(runId)?.activeSteps ?? {});
  await vi.waitFor(() => expect(awaiting().some((step) => step.startsWith(DEFAULT_REVIEW_STEP_IDS.await))).toBe(true));
  first.runtime.shutdown();
  world.world.readsHang = false;
  return runId;
}

describe("reviewRunner", () => {
  it("resumes a run interrupted between member dispatch and await with no second spawn", async () => {
    const db = makeDb();
    const world = fakeWorld(merges);
    const runId = await interruptedAtAwait(db, world);

    const second = runnerFor(db, world.ports);
    await second.hydrate();

    expect(await second.outcome(runId)).toMatchObject({ kind: "MERGE" });
    expect(world.world.spawns).toEqual([name("correctness"), name("adversary")]);
  });

  it("parks a run pinned to an older definition version as recovery_required and never replays it", async () => {
    const db = makeDb();
    const world = fakeWorld(merges);
    const runId = await interruptedAtAwait(db, world, "0");

    const second = runnerFor(db, world.ports);
    await second.hydrate();

    expect(second.runtime.status(runId)).toMatchObject({ status: "recovery_required", definitionVersion: "0" });
    expect(world.world.spawns).toEqual([name("correctness"), name("adversary")]);
  });

  it("parks a run on its fingerprint and reviews it again as a fresh run once the fingerprint resolves", async () => {
    const db = makeDb();
    const world = fakeWorld(merges);
    world.world.installed = false;
    const runner = runnerFor(db, world.ports);
    const parked = await runner.outcome(runner.start(request));
    if (parked.kind !== "needs-fixer") throw new Error(`expected needs-fixer, got ${parked.kind}`);

    world.world.installed = true;
    const resumed = await runner.resolve(parked.fingerprint);

    expect([world.world.fixers.length, resumed.map((run) => ("outcome" in run ? run.outcome.kind : run.error))]).toEqual([1, ["MERGE"]]);
  });
});
