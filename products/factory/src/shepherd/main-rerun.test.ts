import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { activeWorkFixTasks } from "./cleanup-ports.js";
import { shepherdEventMigration } from "./events.js";
import { FreezeStore, freezeCancelOnlyMigration, freezeFixPrMigration, freezeMigration } from "./freeze.js";
import type { FixTasks, FlakeFields, MainRedWiring } from "./main-red.js";
import { FLAKE_REPEAT_MS, rerunRedMain, type RerunInput } from "./main-rerun.js";
import type { ShepherdDeps } from "./phases.js";
import { repoFreezeMigration } from "./repo-freeze.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "octo/widget";
const RED = fakeSha("red");
const TEST = "src/linear.test.ts > grows linearly";
const LOG = `FAIL  ${TEST}\nAssertionError: ratio 8.1 is above the limit 5`;
const signal = new AbortController().signal;

interface Rig {
  fake: FakeGitHub;
  deps: ShepherdDeps;
  freezes: FreezeStore;
  flakes: { initiative: string; id: string; flake: FlakeFields }[];
  wiring: MainRedWiring;
  advance(ms: number): void;
  reruns(): number;
}

/** Main is red at RED in `validate` (job 7); `rerun` decides what Shepherd's own rerun posts (job 20). */
function rig(rerun: "success" | "failure" | "none" = "success"): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), freezeCancelOnlyMigration(12), shepherdEventMigration(16), freezeFixPrMigration(23), repoFreezeMigration(33)]);
  const store = shepherdStoreRef();
  store.bind(db);
  const fake = fakeGitHub();
  fake.setRuns(RED, [successRun("validate", 7, undefined, "failure")]);
  fake.jobLogs.set(7, LOG);
  fake.jobLogs.set(20, LOG);
  const base = githubPort(fake.wire);
  let reruns = 0;
  const rerunFailed = async () => {
    reruns += 1;
    if (rerun !== "none") fake.setRuns(RED, [successRun("validate", 7, undefined, "failure"), successRun("validate", 20, "2026-01-01T00:20:00Z", rerun)]);
    return { done: true as const };
  };
  let clock = Date.parse("2026-10-22T12:00:00Z");
  const deps: ShepherdDeps = { port: { ...base, rerunFailed }, store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 60_000, agentChatBin: "agent-chat" };
  const freezes = new FreezeStore(db, () => clock);
  const flakes: Rig["flakes"] = [];
  const tasks: FixTasks = { findByTag: async () => undefined, add: async () => "FX-1", markFlake: async (initiative, id, flake) => void flakes.push({ initiative, id, flake }) };
  return { fake, deps, freezes, flakes, wiring: { freezes: () => freezes, tasks }, advance: (ms) => void (clock += ms), reruns: () => reruns };
}

/** A new episode at RED with its fix task filed, as `sh-file-fix-task` leaves it. */
function frozen(r: Rig, runId = "run-1"): RerunInput {
  const { episode } = r.freezes.freeze(REPO, RED);
  r.freezes.setFixTask(REPO, episode, "demo/FX-1");
  return { repo: REPO, pr: 1, mergeSha: RED, runId, episode, task: "demo/FX-1" };
}

describe("sh-main-rerun", () => {
  it("thaws on Shepherd's own green rerun at the red sha and leaves the fix task open as the flake task", async () => {
    const r = rig();
    const input = frozen(r);

    const result = await rerunRedMain(r.deps, r.wiring, input, signal);

    expect(result).toMatchObject({ thawed: true, detail: expect.stringContaining("flake filed on demo/FX-1") });
    expect(r.reruns()).toBe(1);
    expect(r.freezes.isFrozen(REPO)).toBe(false);
    expect(r.flakes).toHaveLength(1);
  });

  it("files the flake with both runs' ids and URLs, the job, the failing test, an error excerpt and a root-cause done_when", async () => {
    const r = rig();

    await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    const { initiative, id, flake } = r.flakes[0]!;
    expect({ initiative, id, tag: flake.tag }).toEqual({ initiative: "demo", id: "FX-1", tag: "flake" });
    expect(flake.notes).toContain("- validate: Actions run 1007, job 7, https://example.test/actions/runs/1007/job/7");
    expect(flake.notes).toContain("- validate: Actions run 1020, job 20, https://example.test/actions/runs/1020/job/20");
    expect(flake.notes).toContain(`- ${TEST}`);
    expect(flake.notes).toContain("ratio 8.1 is above the limit 5");
    expect(flake.done_when).toMatch(/root cause .* is found and fixed/);
    expect(flake.done_when).toContain("A retry, a longer timeout or a quarantine does not count.");
  });

  it("stays frozen and files no flake when the rerun fails again", async () => {
    const r = rig("failure");

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: `the rerun at ${RED} failed again: validate` });
    expect(r.freezes.isFrozen(REPO)).toBe(true);
    expect(r.flakes).toEqual([]);
  });

  it("stays frozen when the flake task cannot be filed, so no flake thaws unrecorded", async () => {
    const r = rig();
    const tasks: FixTasks = { ...r.wiring.tasks!, markFlake: async () => Promise.reject(new Error("connect ECONNREFUSED")) };

    const result = await rerunRedMain(r.deps, { ...r.wiring, tasks }, frozen(r), signal);

    expect(result).toMatchObject({ thawed: false, detail: expect.stringContaining("active-work did not take the flake task") });
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("reruns once per episode: another run in the same episode queues nothing and stays frozen", async () => {
    const r = rig("failure");
    const input = frozen(r);
    await rerunRedMain(r.deps, r.wiring, input, signal);

    const second = await rerunRedMain(r.deps, r.wiring, { ...input, runId: "run-2" }, signal);

    expect(second).toEqual({ thawed: false, detail: "this episode's one rerun was already spent" });
    expect(r.reruns()).toBe(1);
  });

  it("resumes its own claim after a restart without queuing a second rerun", async () => {
    const r = rig("none");
    const input = frozen(r);
    r.freezes.claimRerun(REPO, input.episode!, input.runId, 7);
    r.fake.setRuns(RED, [successRun("validate", 7, undefined, "failure"), successRun("validate", 20, "2026-01-01T00:20:00Z")]);

    const result = await rerunRedMain(r.deps, r.wiring, input, signal);

    expect(result.thawed).toBe(true);
    expect(r.reruns()).toBe(0);
  });

  it("counts only Shepherd's own rerun, not a later one someone else started", async () => {
    const r = rig("none");
    const runs = (ours: string): CheckRun[] => [successRun("validate", 7, undefined, "failure"), successRun("validate", 20, "2026-01-01T00:20:00Z", ours), successRun("validate", 21, "2026-01-01T00:40:00Z")];
    r.deps.port = { ...r.deps.port, rerunFailed: async () => (r.fake.setRuns(RED, runs("failure")), { done: true as const }) };

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: `the rerun at ${RED} failed again: validate` });
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("does not take a green rerun someone else made before Shepherd's step as its own", async () => {
    const r = rig();
    r.fake.setRuns(RED, [successRun("validate", 7, "2026-01-01T00:00:00Z", "failure"), successRun("validate", 9, "2026-01-01T00:10:00Z")]);

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toMatchObject({ thawed: false, detail: expect.stringContaining("only Shepherd's own rerun thaws") });
    expect(r.reruns()).toBe(0);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("keeps the repo frozen, with no rerun, when the same failing test already thawed main on a rerun within 24 h", async () => {
    const r = rig();
    await rerunRedMain(r.deps, r.wiring, frozen(r), signal);
    r.advance(FLAKE_REPEAT_MS - 60 * 60_000);
    r.fake.setRuns(RED, [successRun("validate", 7, undefined, "failure")]);

    const second = await rerunRedMain(r.deps, r.wiring, frozen(r, "run-2"), signal);

    expect(second).toEqual({ thawed: false, detail: `${TEST} already thawed main on a rerun within 24 h, so it stays frozen for a real fix` });
    expect(r.reruns()).toBe(1);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("reruns the same failing test again once 24 h have passed since its rerun thaw", async () => {
    const r = rig();
    await rerunRedMain(r.deps, r.wiring, frozen(r), signal);
    r.advance(FLAKE_REPEAT_MS + 60_000);
    r.fake.setRuns(RED, [successRun("validate", 7, undefined, "failure")]);

    const second = await rerunRedMain(r.deps, r.wiring, frozen(r, "run-2"), signal);

    expect(second.thawed).toBe(true);
    expect(r.reruns()).toBe(2);
  });

  it("reruns nothing for a red whose log names no failing test", async () => {
    const r = rig();
    r.fake.jobLogs.set(7, "error TS2304: Cannot find name 'widget'.");

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: "the failing jobs name no failing test, so main is not rerun" });
    expect(r.reruns()).toBe(0);
  });

  it("reruns nothing when no port can file the flake task", async () => {
    const r = rig();
    const { markFlake: _, ...tasks } = r.wiring.tasks!;

    const result = await rerunRedMain(r.deps, { ...r.wiring, tasks }, frozen(r), signal);

    expect(result.thawed).toBe(false);
    expect(r.reruns()).toBe(0);
  });
});

describe("the active-work flake port", () => {
  it("appends the flake notes once, sets the root-cause done_when, tags it and reopens a done task, never closing it", async () => {
    const calls: { command: string; body: Record<string, unknown> }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const command = String(url).split("/rpc/")[1]!;
      calls.push({ command, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const data = command === "task.list" ? { tasks: [{ id: "FX-1", status: "done", notes: "filed on red", tags: ["main-red"] }] } : {};
      return new Response(JSON.stringify({ ok: true, data }));
    });
    const tasks = activeWorkFixTasks({ origin: "http://127.0.0.1:7400", fetch });

    await tasks.markFlake!("demo", "FX-1", { done_when: "root cause fixed", notes: "Flake (episode 1)", tag: "flake" });

    expect(calls.map((call) => call.command)).not.toContain("task.done");
    expect(calls.slice(1).map((call) => call.body)).toEqual([
      { slug: "demo", id: "FX-1", field: "notes", value: "filed on red\n\nFlake (episode 1)" },
      { slug: "demo", id: "FX-1", field: "done_when", value: "root cause fixed" },
      { slug: "demo", id: "FX-1", add_tag: "flake" },
      { slug: "demo", id: "FX-1", field: "status", value: "open" },
    ]);
  });
});
