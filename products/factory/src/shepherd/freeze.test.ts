import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdSlotsMigration } from "./store-migrations.js";
import { factoryRoutesFor } from "../workflows.js";
import { eventsSince, shepherdEventMigration } from "./events.js";
import { FREEZE_RECHECK_MS, FreezeStore, freezeCancelOnlyMigration, freezeFixPrMigration, freezeGuard, freezeMigration, freezeStoreRef, redOnlyFromCancels } from "./freeze.js";
import { MergeHeldError, heldCheck, holdingPort, openHeadRead, waitWhileHeld } from "./hold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";
import { repoFreezeMigration } from "./repo-freeze.js";
import { partialFake } from "@titan-design/test-kit";
import type { StepRoute } from "@titan-design/workflow";
import type { RoutedStepInput } from "@titan-design/workflow";

const RED = fakeSha("red");
const CANCELLED_AT = "2026-10-05T00:29:38Z";
const RERUN_AT = "2026-10-05T00:31:31Z";
const GREEN = fakeSha("green");
const A = "octo/a";
const B = "octo/b";

interface Rig {
  db: Db;
  fake: FakeGitHub;
  port: GitHubPort;
  guarded: GitHubPort;
  freezes: FreezeStore;
  registrations: ShepherdStore;
  clock: { at: number };
}

function rig(): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), freezeCancelOnlyMigration(12), shepherdEventMigration(16), holdSlotsMigration(19), freezeFixPrMigration(23), repoFreezeMigration(33)]);
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
    db,
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
    r.freezes.setFixTask(A, 1, "demo/fix");
    r.freezes.setFixer(A, 1, "impl");
    const fix = openPr(r, A, "demo/fix");
    const other = openPr(r, A, "demo/other");

    const merged = await land(r, fix);
    await expect(land(r, other)).rejects.toThrow(/frozen/);

    expect(merged).toMatchObject({ done: true });
    expect(r.fake.effects.merge).toBe(1);
  });

  it("lets a seat's marked fix PR through a freeze while another registered PR stays frozen", async () => {
    const r = rig();
    const { episode } = r.freezes.freeze(A, RED);
    const fix = openPr(r, A, "demo/seat-fix");
    const other = openPr(r, A, "demo/other");
    r.freezes.markFixPr(A, episode, fix.pr, "seat-a");

    const merged = await land(r, fix);
    await expect(land(r, other)).rejects.toThrow(/frozen/);

    expect(merged).toMatchObject({ done: true });
    expect(r.fake.effects.merge).toBe(1);
  });

  it("refuses an unregistered PR whose number is the marked fix PR", async () => {
    const r = rig();
    const { episode } = r.freezes.freeze(A, RED);
    const unregistered = openPr(r, A);
    r.freezes.markFixPr(A, episode, unregistered.pr, "seat-a");

    await expect(land(r, unregistered)).rejects.toThrow(/frozen/);
    expect(r.fake.effects.merge).toBe(0);
  });

  it("does not carry a marked fix PR into the next freeze episode", async () => {
    const r = rig();
    const fix = openPr(r, A, "demo/seat-fix");
    r.freezes.markFixPr(A, r.freezes.freeze(A, RED).episode, fix.pr, "seat-a");
    r.freezes.unfreeze(A, GREEN);

    const next = r.freezes.freeze(A, fakeSha("red2"));

    expect(next).toMatchObject({ episode: 2, fixPr: null, fixPrActor: null });
    await expect(land(r, fix)).rejects.toThrow(/frozen/);
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

  it("clears a freeze whose red was only cancels once the red sha itself re-ran each check green", async () => {
    const r = rig();
    r.freezes.freeze(A, RED, true);
    r.fake.refs.set("main", RED);
    r.fake.setRuns(RED, [successRun("validate", 2, RERUN_AT), successRun("validate", 1, CANCELLED_AT, "cancelled"), successRun("dag-check", 3)]);

    await expect(land(r, openPr(r, A))).resolves.toMatchObject({ done: true });
    expect(r.freezes.isFrozen(A)).toBe(false);
  });

  it("keeps a freeze whose red was only cancels while the cancelled check has no later run", async () => {
    const r = rig();
    r.freezes.freeze(A, RED, true);
    r.fake.refs.set("main", RED);
    r.fake.setRuns(RED, [successRun("validate", 1, CANCELLED_AT, "cancelled"), successRun("build", 2, CANCELLED_AT)]);

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
    r.fake.setRuns(GREEN, [successRun("validate", 1), successRun("dag-check", 2)]);

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
    const failing = Object.assign(partialFake<GitHubPort>(), {
      ...r.port,
      getPr: async () => {
        throw new Error("github unavailable");
      },
      merge: async () => {
        merged += 1;
        return { merged: true };
      },
    });
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
    const waiting = waitWhileHeld(
      partialFake<StepRoute>(route),
      held,
      {
        sleep: async () => control.abort(),
      },
      openHeadRead(r.port),
    );

    const result = await waiting.runner.run(partialFake<RoutedStepInput>({ prompt: JSON.stringify({ repo: A, pr }), signal: control.signal }));

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
    r.freezes.setFixTask(A, 1, "demo/fix");

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

  it("releases only the episode named, so an override for a thawed episode leaves a later one frozen", () => {
    const r = rig();
    const first = r.freezes.freeze(A, RED);
    r.freezes.unfreeze(A, GREEN);
    const second = r.freezes.freeze(A, fakeSha("red2"));

    const stale = r.freezes.release(A, first.episode);
    const current = r.freezes.release(A, second.episode);

    expect(stale).toBe(false);
    expect(current).toBe(true);
    expect(r.freezes.isFrozen(A)).toBe(false);
  });

  it("refuses to unfreeze at the red sha and reports the fix task and fixer", () => {
    const r = rig();
    r.freezes.freeze(A, RED);
    r.freezes.setFixTask(A, 1, "demo/fix");
    r.freezes.setFixer(A, 1, "fixer-1");

    expect(r.freezes.unfreeze(A, RED)).toBe(false);
    expect(r.freezes.exemptTask(A)).toBe("demo/fix");
    expect(r.freezes.get(A)).toMatchObject({ fixer: "fixer-1" });
    expect(r.freezes.unfreeze(A, GREEN)).toBe(true);
    expect(r.freezes.isFrozen(A)).toBe(false);
    expect(r.freezes.exemptTask(A)).toBeUndefined();
  });

  it("unfreezes at the red sha itself only when the freeze recorded its red as only cancels", () => {
    const r = rig();
    r.freezes.freeze(A, RED, true);
    r.freezes.freeze(B, RED);

    expect([r.freezes.unfreeze(A, RED), r.freezes.unfreeze(B, RED)]).toEqual([true, false]);
  });

  it("records the newest red sha's cancel-only flag when a live freeze counts up", () => {
    const r = rig();
    r.freezes.freeze(A, RED, true);

    const later = r.freezes.freeze(A, fakeSha("red2"));

    expect(later).toMatchObject({ redCount: 2, cancelOnly: false });
  });

  it("marks a fix PR on the live episode and records one freeze event naming the actor and the PR", () => {
    const r = rig();
    const { episode } = r.freezes.freeze(A, RED);

    const result = r.freezes.markFixPr(A, episode, 833, "seat-a", "run-1");

    expect(result).toBe("marked");
    expect(r.freezes.get(A)).toMatchObject({ fixPr: 833, fixPrActor: "seat-a" });
    expect(eventsSince(r.db).filter((event) => event.pr === 833)).toEqual([expect.objectContaining({ kind: "freeze", runId: "run-1", actor: "seat-a", headSha: RED, reason: "fix PR #833 marked" })]);
  });

  it("refuses a mark on a thawed repo or a stale episode and writes nothing", () => {
    const r = rig();
    const unfrozen = r.freezes.markFixPr(A, 1, 833, "seat-a");
    r.freezes.freeze(A, RED);
    r.freezes.unfreeze(A, GREEN);
    const thawed = r.freezes.markFixPr(A, 1, 833, "seat-a");
    const eventsBefore = eventsSince(r.db).length;
    r.freezes.freeze(A, fakeSha("red2"));

    const stale = r.freezes.markFixPr(A, 1, 833, "seat-a");

    expect([unfrozen, thawed, stale]).toEqual(["not-live", "not-live", "not-live"]);
    expect(r.freezes.get(A)).toMatchObject({ episode: 2, fixPr: null });
    expect(eventsSince(r.db).filter((event) => event.pr === 833)).toEqual([]);
    expect(eventsSince(r.db)).toHaveLength(eventsBefore + 1);
  });

  it("keeps the first marked fix PR, refuses a second and writes no event for a repeat", () => {
    const r = rig();
    const { episode } = r.freezes.freeze(A, RED);
    r.freezes.markFixPr(A, episode, 833, "seat-a");

    const second = r.freezes.markFixPr(A, episode, 834, "seat-b");
    const repeat = r.freezes.markFixPr(A, episode, 833, "seat-b");

    expect([second, repeat]).toEqual(["taken", "already"]);
    expect(r.freezes.get(A)).toMatchObject({ fixPr: 833, fixPrActor: "seat-a" });
    expect(eventsSince(r.db).filter((event) => event.pr !== null)).toHaveLength(1);
  });

  it("refuses to name a fix task for a repo that is not frozen, or for an episode that has thawed", () => {
    const r = rig();
    const unfrozen = r.freezes.setFixTask(A, 1, "demo/fix");
    r.freezes.freeze(A, RED);
    r.freezes.unfreeze(A, GREEN);
    r.freezes.freeze(A, fakeSha("red2"));

    const stale = r.freezes.setFixer(A, 1, "old-fixer");

    expect([unfrozen, stale]).toEqual([false, false]);
    expect(r.freezes.get(A)).toMatchObject({ episode: 2, fixTask: null, fixer: null });
  });

  it("setFixer does not overwrite an episode's fixer", () => {
    const r = rig();
    const { episode } = r.freezes.freeze(A, RED);
    r.freezes.setFixer(A, episode, "fix-a-aaaaaaa");

    const second = r.freezes.setFixer(A, episode, "fix-a-bbbbbbb");
    const repeat = r.freezes.setFixer(A, episode, "fix-a-aaaaaaa");

    expect([second, repeat]).toEqual([false, true]);
    expect(r.freezes.get(A)).toMatchObject({ fixer: "fix-a-aaaaaaa" });
  });

  it("names the sha that opened the live episode as its first red, not a later red in it", () => {
    const r = rig();
    r.freezes.freeze(A, fakeSha("old"));
    r.freezes.unfreeze(A, GREEN);
    const { episode } = r.freezes.freeze(A, RED);
    r.freezes.freeze(A, fakeSha("red2"));

    expect(r.freezes.episodes.firstRed(A, episode)).toBe(RED);
    expect(r.freezes.episodes.firstRed(A, episode - 1)).toBeUndefined();
  });
});

describe("redOnlyFromCancels", () => {
  const at = (runs: ReturnType<typeof successRun>[]) => {
    const fake = fakeGitHub();
    fake.setRuns(RED, runs);
    return redOnlyFromCancels(githubPort(fake.wire), A, RED);
  };

  it("is true when every red Actions run at the sha was cancelled, superseded or not", async () => {
    expect(await at([successRun("validate", 1, CANCELLED_AT, "cancelled"), successRun("validate", 2, RERUN_AT), successRun("build", 3, CANCELLED_AT, "cancelled")])).toBe(true);
  });

  it("is false when any red run failed, or when nothing at the sha is red", async () => {
    expect(await at([successRun("validate", 1, CANCELLED_AT, "cancelled"), successRun("build", 2, CANCELLED_AT, "failure")])).toBe(false);
    expect(await at([successRun("validate", 1)])).toBe(false);
  });
});

describe("thaw notice from the freeze store ref", () => {
  function boundRef(): { ref: ReturnType<typeof freezeStoreRef>; thawed: string[]; unsubscribe: () => void } {
    const db = openDatabase(":memory:");
    runMigrations(db, [freezeMigration(6), freezeCancelOnlyMigration(12), shepherdEventMigration(16), freezeFixPrMigration(23)]);
    const ref = freezeStoreRef(() => 0);
    ref.bind(db);
    const thawed: string[] = [];
    const unsubscribe = ref.onThaw((repo) => thawed.push(repo));
    return { ref, thawed, unsubscribe };
  }

  it("names the repo once for a green unfreeze and once for an owner release", () => {
    const { ref, thawed } = boundRef();
    ref.get().freeze(A, RED);
    ref.get().unfreeze(A, GREEN);
    const episode = ref.get().freeze(B, RED).episode;

    ref.get().release(B, episode);
    ref.get().release(B, episode);

    expect(thawed).toEqual([A, B]);
  });

  it("stays quiet for a refused unfreeze, and after the listener unsubscribes", () => {
    const { ref, thawed, unsubscribe } = boundRef();
    ref.get().freeze(A, RED);
    ref.get().unfreeze(A, RED);
    unsubscribe();
    ref.get().unfreeze(A, GREEN);

    expect(thawed).toEqual([]);
  });

  it("a throwing listener neither throws from the thaw nor stops the listener after it, and its failure is logged", () => {
    const { ref, thawed, unsubscribe } = boundRef();
    unsubscribe();
    ref.onThaw(() => {
      throw new Error("listener broke");
    });
    ref.onThaw((repo) => thawed.push(repo));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const episode = ref.get().freeze(A, RED).episode;

    const released = ref.get().release(A, episode);

    expect(released).toBe(true);
    expect(ref.get().isFrozen(A)).toBe(false);
    expect(thawed).toEqual([A]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("listener broke"));
    warn.mockRestore();
  });

  it("a store whose own thaw callback throws still reports the thaw it committed", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [freezeMigration(6), freezeCancelOnlyMigration(12), shepherdEventMigration(16), freezeFixPrMigration(23)]);
    const freezes = new FreezeStore(db, () => 0, () => {
      throw new Error("callback broke");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    freezes.freeze(A, RED);

    expect(freezes.unfreeze(A, GREEN)).toBe(true);
    expect(freezes.isFrozen(A)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("callback broke"));
    warn.mockRestore();
  });
});

describe("the freeze store on a database another connection writes", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("still freezes when another connection tries to commit between the freeze's read and its write", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-race-"));
    dirs.push(dir);
    const path = join(dir, "factory.db");
    const host = openDatabase(path);
    runMigrations(host, [freezeMigration(6), freezeCancelOnlyMigration(12), shepherdEventMigration(16), freezeFixPrMigration(23)]);
    const cli = openDatabase(path);
    cli.pragma("busy_timeout = 0");
    const cliWrite = () => {
      try {
        cli.prepare("INSERT INTO shepherd_freeze (repo, red_sha, red_count, frozen_at, episode) VALUES (?, ?, 1, ?, 1)").run(B, RED, "2026-10-09T00:00:00Z");
      } catch {
        return;
      }
    };
    const freezes = new FreezeStore(host, () => {
      cliWrite();
      return 0;
    });

    expect(() => freezes.freeze(A, RED)).not.toThrow();
    expect(freezes.get(A)).toMatchObject({ redSha: RED, episode: 1 });
    cli.close();
    host.close();
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

    expect(applied).toEqual([6, 8, 9, 10, 11, 12, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 31, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 46, 48]);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 31, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 46, 48]);
    expect(() => new FreezeStore(db).freeze(A, RED)).not.toThrow();
    db.close();
  });

  it("adds the cancel-only flag to a live freeze row as false, so that freeze still refuses its red sha", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [freezeMigration(6)]);
    db.prepare("INSERT INTO shepherd_freeze (repo, red_sha, red_count, frozen_at, episode) VALUES (?, ?, 1, ?, 1)").run(A, RED, "2026-10-05T00:29:50Z");

    expect(runMigrations(db, [freezeMigration(6), freezeCancelOnlyMigration(12), freezeFixPrMigration(23)])).toEqual([12, 23]);
    const freezes = new FreezeStore(db);

    expect(freezes.get(A)).toMatchObject({ redSha: RED, episode: 1, cancelOnly: false, fixPr: null });
    expect(freezes.unfreeze(A, RED)).toBe(false);
    db.close();
  });
});
