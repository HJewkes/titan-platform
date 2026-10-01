import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { appliedVersions, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { factoryRoutesFor } from "../workflows.js";
import { FREEZE_RECHECK_MS, FreezeStore, freezeGuard, freezeMigration, freezeStoreRef } from "./freeze.js";
import { MergeHeldError, heldCheck, holdingPort, waitWhileHeld } from "./hold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, lineageMigration, shepherdMigration, shepherdStoreRef } from "./store.js";

const RED = fakeSha("red");
const GREEN = fakeSha("green");
const A = "octo/a";
const B = "octo/b";

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  guarded: GitHubPort;
  freezes: FreezeStore;
  registrations: ShepherdStore;
  clock: { at: number };
}

function rig(): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), freezeMigration(6)]);
  const clock = { at: 0 };
  const freezes = new FreezeStore(db, () => clock.at);
  const registrations = new ShepherdStore(db, () => clock.at);
  const fake = fakeGitHub();
  const port = githubPort(fake.wire);
  const guard = freezeGuard({
    freezes: () => freezes,
    registrations: () => registrations,
    now: () => clock.at,
  });
  return {
    fake,
    port,
    guarded: holdingPort(port, () => registrations, guard),
    freezes,
    registrations,
    clock,
  };
}

function openPr(r: Rig, repo: string, task?: string): { repo: string; pr: number; sha: string } {
  const sha = fakeSha(`head-${repo}-${r.fake.calls.length}-${Math.random()}`);
  const { number } = r.fake.addPr({ headSha: sha });
  if (task)
    r.registrations.register({
      repo,
      pr: number,
      runId: `run-${repo}-${number}`,
      task,
      implementer: "impl",
      policy: OWNER_GATE_POLICY,
    });
  return { repo, pr: number, sha };
}

const land = (r: Rig, { repo, pr, sha }: { repo: string; pr: number; sha: string }) => r.guarded.merge(repo, pr, sha, "squash");

describe("the frozen-merge guard", () => {
  it("blocks every PR of the frozen repo and merges a PR of another repo", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    const inA = openPr(r, A, "demo/1");
    const inB = openPr(r, B, "demo/2");

    await expect(land(r, inA)).rejects.toBeInstanceOf(MergeHeldError);
    const merged = await land(r, inB);

    expect(merged).toMatchObject({ done: true });
    expect(r.fake.effects.merge).toBe(1);
  });

  it("blocks an unregistered PR of the frozen repo", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);

    await expect(land(r, openPr(r, A))).rejects.toThrow(/frozen/);
    expect(r.fake.effects.merge).toBe(0);
  });

  it("blocks a frozen repo's PR whatever its spelling", async () => {
    const r = rig();
    r.freezes.freeze("Octo/A", RED);

    await expect(land(r, openPr(r, "octo/a"))).rejects.toThrow(/frozen/);
  });

  it("lets only the fix task's PR through a freeze", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    r.freezes.setFixTask(A, "demo/fix");
    const fix = openPr(r, A, "demo/fix");
    const other = openPr(r, A, "demo/other");

    const merged = await land(r, fix);
    await expect(land(r, other)).rejects.toThrow(/frozen/);

    expect(merged).toMatchObject({ done: true });
    expect(r.fake.effects.merge).toBe(1);
  });

  it("exempts nobody while the freeze has no fix task yet", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);

    await expect(land(r, openPr(r, A, "demo/fix"))).rejects.toThrow(/frozen/);
  });

  it("clears the freeze when main moves to an all-green head, and merges", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    const pr = openPr(r, A, "demo/1");
    await expect(land(r, pr)).rejects.toThrow(/frozen/);

    r.fake.refs.set("main", GREEN);
    r.fake.setRuns(GREEN, [successRun("validate", 1), successRun("dag-check", 2)]);
    r.clock.at += FREEZE_RECHECK_MS;
    const merged = await land(r, pr);

    expect(merged).toMatchObject({ done: true });
    expect(r.freezes.isFrozen(A)).toBe(false);
  });

  it("keeps the freeze when green runs sit on the red sha itself", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    r.fake.refs.set("main", RED);
    r.fake.setRuns(RED, [successRun("validate", 1)]);

    await expect(land(r, openPr(r, A))).rejects.toThrow(/frozen/);
    expect(r.freezes.isFrozen(A)).toBe(true);
  });

  it("keeps the freeze while a run on the new head is red or unfinished", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    r.fake.refs.set("main", GREEN);
    r.fake.setRuns(GREEN, [
      successRun("validate", 1),
      {
        ...successRun("dag-check", 2),
        status: "in_progress",
        conclusion: null,
      },
    ]);

    await expect(land(r, openPr(r, A))).rejects.toThrow(/frozen/);
    r.fake.setRuns(GREEN, [successRun("validate", 1, undefined, "failure")]);
    r.clock.at += FREEZE_RECHECK_MS;
    await expect(land(r, openPr(r, A))).rejects.toThrow(/frozen/);
    expect(r.freezes.isFrozen(A)).toBe(true);
  });

  it("re-reads main at most once per five minutes", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    const pr = openPr(r, A);
    await expect(land(r, pr)).rejects.toThrow();
    r.fake.refs.set("main", GREEN);
    r.fake.setRuns(GREEN, [successRun("validate", 1)]);

    await expect(land(r, pr)).rejects.toThrow(/frozen/);
    r.clock.at += FREEZE_RECHECK_MS;

    await expect(land(r, pr)).resolves.toMatchObject({ done: true });
  });

  it("refuses the merge, never passes it, when the freeze store is not bound", async () => {
    const r = rig();
    const unbound = freezeGuard({
      freezes: () => freezeStoreRef().get(),
      registrations: () => r.registrations,
    });
    const port = holdingPort(r.port, () => r.registrations, unbound);

    await expect(port.merge(A, openPr(r, A).pr, RED, "squash")).rejects.toThrow(/not bound/);
    expect(r.fake.effects.merge).toBe(0);
  });

  it("refuses the merge, never passes it, when the PR read fails", async () => {
    const r = rig();
    let merged = 0;
    const failing = {
      ...r.port,
      getPr: async () => {
        throw new Error("github unavailable");
      },
      merge: async () => {
        merged += 1;
        return { merged: true };
      },
    } as unknown as GitHubPort;
    const port = holdingPort(failing, () => r.registrations);

    await expect(port.merge(A, 1, RED, "squash")).rejects.toThrow(/github unavailable/);
    expect(merged).toBe(0);
  });

  it("stops waiting on a frozen repo when the run is aborted, without merging", async () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    const { pr } = openPr(r, A);
    const control = new AbortController();
    let ran = false;
    const route = {
      match: "merge",
      runner: {
        run: async () => ((ran = true), { ok: true as const, output: "{}" }),
      },
    };
    const held = heldCheck(
      r.port,
      () => r.registrations,
      freezeGuard({
        freezes: () => r.freezes,
        registrations: () => r.registrations,
        now: () => r.clock.at,
      }),
    );
    const waiting = waitWhileHeld(route as never, held, {
      sleep: async () => control.abort(),
    });

    const result = await (waiting.runner.run as (i: unknown) => Promise<{ ok: boolean }>)({ prompt: JSON.stringify({ repo: A, pr }), signal: control.signal });

    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
  });
});

describe("the freeze store", () => {
  it("keeps one row and one episode when the same red sha is frozen twice", () => {
    const r = rig();

    r.freezes.freeze(A, RED);
    const again = r.freezes.freeze(A, RED);

    expect(again).toMatchObject({ redSha: RED, redCount: 1, episode: 1 });
  });

  it("counts a later red sha in a live freeze and starts a new episode after a thaw", () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    r.freezes.setFixTask(A, "demo/fix");

    const second = r.freezes.freeze(A, fakeSha("red2"));
    r.freezes.unfreeze(A, GREEN);
    const next = r.freezes.freeze(A, fakeSha("red3"));

    expect(second).toMatchObject({
      redCount: 2,
      episode: 1,
      fixTask: "demo/fix",
    });
    expect(next).toMatchObject({
      redCount: 1,
      episode: 2,
      fixTask: null,
      fixer: null,
    });
  });

  it("refuses to unfreeze at the red sha and reports the fix task and fixer", () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    r.freezes.setFixTask(A, "demo/fix");
    r.freezes.setFixer(A, "fixer-1");

    expect(r.freezes.unfreeze(A, RED)).toBe(false);
    expect(r.freezes.exemptTask(A)).toBe("demo/fix");
    expect(r.freezes.get(A)).toMatchObject({ fixer: "fixer-1" });
    expect(r.freezes.unfreeze(A, GREEN)).toBe(true);
    expect(r.freezes.isFrozen(A)).toBe(false);
    expect(r.freezes.exemptTask(A)).toBeUndefined();
  });

  it("refuses to name a fix task for a repo that is not frozen", () => {
    expect(() => rig().freezes.setFixTask(A, "demo/fix")).toThrow(/not frozen/);
  });
});

describe("the freeze migration", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("creates the freeze table in a database that already has migrations 1 to 5", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-"));
    dirs.push(dir);
    const path = join(dir, "factory.db");
    const first = openDatabase(path);
    runMigrations(first, [
      { version: 1, name: "t:one", up: (db) => db.exec("CREATE TABLE t1 (x)") },
      { version: 2, name: "t:two", up: (db) => db.exec("CREATE TABLE t2 (x)") },
      {
        version: 3,
        name: "t:three",
        up: (db) => db.exec("CREATE TABLE t3 (x)"),
      },
      shepherdMigration(4),
      lineageMigration(5),
    ]);
    first.close();

    const db = openDatabase(path);
    const tenant = factoryRoutesFor({
      port: githubPort(fakeGitHub().wire),
      store: shepherdStoreRef(),
    }).database!;
    const applied = runMigrations(db, [
      { version: 1, name: "t:one", up: () => undefined },
      { version: 2, name: "t:two", up: () => undefined },
      { version: 3, name: "t:three", up: () => undefined },
      ...tenant.extraMigrations,
    ]);

    expect(applied).toEqual([6]);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => new FreezeStore(db).freeze(A, RED)).not.toThrow();
    db.close();
  });
});
