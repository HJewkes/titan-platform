import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { fakeActiveWork, filedFixTask } from "../test-support/active-work.js";
import { activeWorkFixTasks } from "./cleanup-ports.js";
import { shepherdEventMigration } from "./events.js";
import { FreezeStore, freezeCancelOnlyMigration, freezeFixPrMigration, freezeMigration } from "./freeze.js";
import { FixTaskRefused, type FixTasks, type FlakeFields, type MainRedWiring } from "./main-red.js";
import { FLAKE_REPEAT_MS, rerunRedMain, type RerunInput } from "./main-rerun.js";
import type { ShepherdDeps } from "./phases.js";
import { repoFreezeMigration } from "./repo-freeze.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "octo/widget";
const RED = fakeSha("red");
const TEST = "src/linear.test.ts > grows linearly";
const LOG = `FAIL  ${TEST}\nAssertionError: ratio 8.1 is above the limit 5`;
const signal = new AbortController().signal;
const ORIGIN = "http://127.0.0.1:7400";

/** A job attempt of the red Actions run 1007; a rerun of failed jobs adds attempts to that same run, which GitHub's default listing then hides. */
const attempt = (id: number, conclusion = "success", startedAt = `2026-01-01T00:${String(id).padStart(2, "0")}:00Z`): CheckRun => ({ ...successRun("validate", id, startedAt, conclusion), workflowRunId: 1007, url: `https://example.test/actions/runs/1007/job/${id}` });

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
  fake.setRuns(RED, [attempt(7, "failure")]);
  fake.jobLogs.set(7, LOG);
  fake.jobLogs.set(20, LOG);
  fake.addPr({ number: 1, headSha: RED, baseRef: "main" });
  fake.rules = { contexts: ["validate"], strict: true };
  const base = githubPort(fake.wire);
  let reruns = 0;
  const rerunFailed = async () => {
    reruns += 1;
    if (rerun !== "none") fake.setRuns(RED, [attempt(7, "failure"), attempt(20, rerun)]);
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
    expect(flake.notes).toContain("- validate: Actions run 1007, job 20, https://example.test/actions/runs/1007/job/20");
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
    r.freezes.episodes.claimRerun(REPO, input.episode!, input.runId, 7);
    r.fake.setRuns(RED, [attempt(7, "failure"), attempt(20)]);

    const result = await rerunRedMain(r.deps, r.wiring, input, signal);

    expect(result.thawed).toBe(true);
    expect(r.reruns()).toBe(0);
  });

  it("counts only Shepherd's own rerun, not a later one someone else started, though GitHub's default listing shows only the latest attempt", async () => {
    const r = rig("none");
    const runs = (ours: string): CheckRun[] => [attempt(7, "failure"), attempt(20, ours), attempt(21)];
    r.deps.port = { ...r.deps.port, rerunFailed: async () => (r.fake.setRuns(RED, runs("failure")), { done: true as const }) };

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: `the rerun at ${RED} failed again: validate` });
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("does not take a green rerun someone else made before Shepherd's step as its own", async () => {
    const r = rig();
    r.fake.setRuns(RED, [attempt(7, "failure"), attempt(9)]);

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toMatchObject({ thawed: false, detail: expect.stringContaining("only Shepherd's own rerun thaws") });
    expect(r.reruns()).toBe(0);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("keeps the repo frozen, with no rerun, when the same failing test already thawed main on a rerun within 24 h", async () => {
    const r = rig();
    await rerunRedMain(r.deps, r.wiring, frozen(r), signal);
    r.advance(FLAKE_REPEAT_MS - 60 * 60_000);
    r.fake.setRuns(RED, [attempt(7, "failure")]);

    const second = await rerunRedMain(r.deps, r.wiring, frozen(r, "run-2"), signal);

    expect(second).toEqual({ thawed: false, detail: `${TEST} already thawed main on a rerun within 24 h, so it stays frozen for a real fix` });
    expect(r.reruns()).toBe(1);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("reruns the same failing test again once 24 h have passed since its rerun thaw", async () => {
    const r = rig();
    await rerunRedMain(r.deps, r.wiring, frozen(r), signal);
    r.advance(FLAKE_REPEAT_MS + 60_000);
    r.fake.setRuns(RED, [attempt(7, "failure")]);

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

  it("stays frozen when a later red in the episode moved its red sha during the rerun", async () => {
    const r = rig("none");
    const later = fakeSha("later");
    r.deps.port = { ...r.deps.port, rerunFailed: async () => (r.fake.setRuns(RED, [attempt(7, "failure"), attempt(20)]), r.freezes.freeze(REPO, later), { done: true as const }) };

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: `the episode's red moved on to ${later} during the rerun` });
    expect(r.flakes).toEqual([]);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("does not thaw an episode whose red sha moved on, even on a green rerun of the earlier red", () => {
    const r = rig();
    const { episode } = r.freezes.freeze(REPO, RED);
    r.freezes.freeze(REPO, fakeSha("later"));

    expect(r.freezes.episodes.thawOnRerun(REPO, episode, RED, [TEST])).toBe("red-moved");
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("stays frozen, filing no flake, when a check that was still running at the red is not green after the rerun", async () => {
    const r = rig();
    r.fake.rules = { contexts: ["validate", "hub-compose"], strict: true };
    const pending = { ...successRun("hub-compose", 8), status: "in_progress", conclusion: null };
    r.fake.setRuns(RED, [attempt(7, "failure"), pending]);
    r.deps.port = { ...r.deps.port, rerunFailed: async () => (r.fake.setRuns(RED, [attempt(7, "failure"), pending, attempt(20)]), { done: true as const }) };

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: `main is still not green at ${RED} after the rerun: hub-compose pending` });
    expect(r.flakes).toEqual([]);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("stays frozen when a required context pinned to another app is red beside the flaky Actions job", async () => {
    const r = rig();
    r.fake.rules = { contexts: ["validate", "ci/external"], strict: true, pins: { "ci/external": [999] } };
    const external = { ...successRun("ci/external", 8, undefined, "failure", 999, RED), workflowRunId: null };
    r.deps.port = { ...r.deps.port, rerunFailed: async () => (r.fake.setRuns(RED, [attempt(7, "failure"), external, attempt(20)]), { done: true as const }) };
    r.fake.setRuns(RED, [attempt(7, "failure"), external]);

    const result = await rerunRedMain(r.deps, r.wiring, frozen(r), signal);

    expect(result).toEqual({ thawed: false, detail: `main is still not green at ${RED} after the rerun: ci/external failed` });
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("thaws through the active-work port on the fix task as filed, replacing its done_when with the root-cause one", async () => {
    const r = rig();
    const aw = fakeActiveWork([filedFixTask("FX-1")]);
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: aw.fetch });

    const result = await rerunRedMain(r.deps, { ...r.wiring, tasks }, frozen(r), signal);

    expect(result.thawed).toBe(true);
    expect(aw.tasks.get("FX-1")).toMatchObject({ status: "open", done_when: expect.stringMatching(/^The root cause of the flaky failure/), tags: ["main-red", "flake"], notes: expect.stringContaining("Flake (episode") });
  });

  it("ends the step at once, frozen, when active-work refuses the flake task, with no retry", async () => {
    const r = rig();
    const aw = fakeActiveWork([]);
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: aw.fetch });

    const result = await rerunRedMain(r.deps, { ...r.wiring, tasks }, frozen(r), signal);

    expect(result).toMatchObject({ thawed: false, detail: expect.stringContaining("active-work did not take the flake task") });
    expect(aw.calls.map((call) => call.command)).toEqual(["task.list"]);
    expect(r.freezes.isFrozen(REPO)).toBe(true);
  });

  it("reruns nothing when no port can file the flake task", async () => {
    const r = rig();
    const tasks: FixTasks = { findByTag: r.wiring.tasks!.findByTag, add: r.wiring.tasks!.add };

    const result = await rerunRedMain(r.deps, { ...r.wiring, tasks }, frozen(r), signal);

    expect(result.thawed).toBe(false);
    expect(r.reruns()).toBe(0);
  });
});

describe("the active-work flake port", () => {
  const flake: FlakeFields = { done_when: "root cause fixed", notes: "Flake (episode 1)", tag: "flake" };

  it("replaces the filed done_when with force, tags and reopens a done task, and appends the notes last, never closing it", async () => {
    const aw = fakeActiveWork([{ ...filedFixTask("FX-1"), status: "done" }]);

    await activeWorkFixTasks({ origin: ORIGIN, fetch: aw.fetch }).markFlake!("demo", "FX-1", flake);

    expect(aw.calls.slice(1).map((call) => call.body)).toEqual([
      { slug: "demo", id: "FX-1", field: "done_when", value: "root cause fixed", force: true },
      { slug: "demo", id: "FX-1", add_tag: "flake" },
      { slug: "demo", id: "FX-1", field: "status", value: "open" },
      { slug: "demo", id: "FX-1", field: "notes", value: "Filed by Shepherd for a red main.\n\nFlake (episode 1)" },
    ]);
  });

  it("writes nothing on a retry once every write landed", async () => {
    const aw = fakeActiveWork([filedFixTask("FX-1")]);
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: aw.fetch });
    await tasks.markFlake!("demo", "FX-1", flake);

    await tasks.markFlake!("demo", "FX-1", flake);

    expect(aw.calls.filter((call) => call.command === "task.edit")).toHaveLength(3);
  });

  it("is refused, as active-work refuses it, when a non-empty done_when is replaced without force", async () => {
    const aw = fakeActiveWork([filedFixTask("FX-1")]);

    const response = await aw.fetch(`${ORIGIN}/rpc/task.edit`, { method: "POST", body: JSON.stringify({ slug: "demo", id: "FX-1", field: "done_when", value: "other" }) });

    expect(await response.json()).toEqual({ ok: false, error: "Refusing to replace a non-empty done_when. Pass --force to replace it", code: 64 });
  });

  it("names a refusal as final, so a caller does not wait it out as an outage", async () => {
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: fakeActiveWork([]).fetch });

    await expect(tasks.markFlake!("demo", "FX-1", flake)).rejects.toBeInstanceOf(FixTaskRefused);
  });
});
