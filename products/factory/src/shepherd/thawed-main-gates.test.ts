import { tmpdir } from "node:os";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { appendEvent, eventsSince, gateCancelKindMigration, reclassMarkMigration, shepherdEventMigration, widenEventKinds } from "./events.js";
import { freezeStoreRef } from "./freeze.js";
import type { MainRedWiring } from "./main-red.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { resyncShepherd } from "./resync.js";
import { shepherdStoreRef } from "./store.js";

const RED_SHA = fakeSha("earlier-red");
const FIXER = "fix-widget-aaaaaaa";
const FIXER_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const mainRed: Omit<MainRedWiring, "freezes"> = {
  tasks: { findByTag: async () => undefined, add: async () => "FX-9" },
  fixers: { roster: async () => [], spawn: async () => undefined },
  checkoutFor: () => tmpdir(),
};

/** PR 1 merges onto a main that is red at the merge sha. */
function redMainWorld() {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const red = [successRun("validate", 5, undefined, "failure"), successRun("dag-check", 6)];
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, red), base.checkRuns(repo, sha)) };
  let clock = 0;
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port, store, freeze, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)), mainRed });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, store, services: routes.shepherd!, freezes: () => freeze.get() };
}

type World = ReturnType<typeof redMainWorld>;

/** The repo is already frozen with a fixer, so a red at PR 1's merge asks main-red-again. */
function frozenWithFixer(w: World): void {
  const freezes = w.freezes();
  freezes.freeze(REPO, RED_SHA);
  freezes.setFixTask(REPO, 1, "demo/FX-1");
  freezes.setFixer(REPO, 1, FIXER);
}

/** A PR into a frozen repo merges only as the freeze's fix, so the main-red-again case registers as the fixer. */
async function mergedOnto(w: World, policy: EffectivePolicy, gate: string, as = { task: "demo/TP-1", implementer: "impl-a" }): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  w.store.get().register({ repo: REPO, pr: 1, runId, ...as, policy });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await gateOpened(w.host, gateId(runId, gate));
  return runId;
}

const stepIds = (w: World, runId: string): string[] => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const gateCancels = (w: World, runId: string) => w.store.get().eventsOf(runId).filter((event) => event.kind === "gate-cancel");

describe("a main gate on a merged PR once its freeze episode thawed", () => {
  it.each([
    ["main-red-again", FIXER_POLICY, frozenWithFixer, { task: "demo/FX-1", implementer: FIXER }],
    ["main-frozen", OWNER_GATE_POLICY, () => undefined, undefined],
  ] as const)("cancels the %s gate with a gate-cancel event, and the run cleans up without thawing", async (gate, policy, before, as) => {
    const w = redMainWorld();
    before(w);
    const runId = await mergedOnto(w, policy, gate, as);
    w.freezes().release(REPO, w.freezes().get(REPO)!.episode, "owner");

    const report = await resyncShepherd(w.host, w.services);

    expect(w.host.gates.get(gateId(runId, gate))?.status).toBe("cancelled");
    await w.host.runtime.wait(runId);
    expect(report.closedMainGates).toEqual([{ runId, gateId: gateId(runId, gate), episode: 1 }]);
    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(stepIds(w, runId)).toContain("sh-cleanup");
    expect(stepIds(w, runId)).not.toContain("sh-thaw");
    expect(gateCancels(w, runId)).toEqual([expect.objectContaining({ runId, pr: 1, reason: expect.stringContaining(`${gate} gate`) })]);
  });

  it("cancels an earlier episode's main-frozen gate once a later red froze the repo again, and leaves the new freeze", async () => {
    const w = redMainWorld();
    const runId = await mergedOnto(w, OWNER_GATE_POLICY, "main-frozen");
    const freezes = w.freezes();
    freezes.unfreeze(REPO, fakeSha("hand-fix"));
    freezes.freeze(REPO, RED_SHA);

    await resyncShepherd(w.host, w.services);

    expect(w.host.gates.get(gateId(runId, "main-frozen"))?.status).toBe("cancelled");
    await w.host.runtime.wait(runId);
    expect(freezes.get(REPO)).toMatchObject({ episode: 2, redSha: RED_SHA });
  });

  it("keeps the gate while the episode it asked about is still frozen", async () => {
    const w = redMainWorld();
    const runId = await mergedOnto(w, OWNER_GATE_POLICY, "main-frozen");

    const report = await resyncShepherd(w.host, w.services);

    expect(w.host.gates.get(gateId(runId, "main-frozen"))?.status).toBe("pending");
    expect(report.closedMainGates).toEqual([]);
    expect(gateCancels(w, runId)).toEqual([]);
  });

  it("a dry run lists the gate it would cancel and cancels nothing", async () => {
    const w = redMainWorld();
    const runId = await mergedOnto(w, OWNER_GATE_POLICY, "main-frozen");
    w.freezes().release(REPO, 1, "owner");

    const report = await resyncShepherd(w.host, w.services, { dryRun: true });

    expect(report.closedMainGates).toEqual([{ runId, gateId: gateId(runId, "main-frozen"), episode: 1 }]);
    expect(w.host.gates.get(gateId(runId, "main-frozen"))?.status).toBe("pending");
    expect(gateCancels(w, runId)).toEqual([]);
  });
});

describe("a main gate cancelled for another reason", () => {
  it("still fails the run, and records no gate-cancel event", async () => {
    const w = redMainWorld();
    const runId = await mergedOnto(w, OWNER_GATE_POLICY, "main-frozen");

    w.host.gates.cancel(gateId(runId, "main-frozen"), "abandoned by hand");
    await w.host.runtime.wait(runId).catch(() => undefined);

    expect(w.host.runtime.status(runId)!.status).toBe("failed");
    expect(stepIds(w, runId)).not.toContain("sh-cleanup");
    expect(gateCancels(w, runId)).toEqual([]);
  });
});

describe("gateCancelKindMigration", () => {
  it("keeps every earlier event row and takes the gate-cancel kind", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdEventMigration(16), reclassMarkMigration(25), { version: 31, name: "repair-stop kinds", up: widenEventKinds }]);
    appendEvent(db, { repo: REPO, kind: "repair-go", at: "2026-01-01T00:00:00.000Z" });

    runMigrations(db, [gateCancelKindMigration(39)]);
    appendEvent(db, { runId: "run-1", repo: REPO, pr: 1, kind: "gate-cancel", reason: "thawed: test", at: "2026-01-02T00:00:00.000Z" });

    expect(eventsSince(db).map((event) => event.kind)).toEqual(["repair-go", "gate-cancel"]);
    db.close();
  });
});
