import { fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { runCleanup, type TaskClose } from "./cleanup.js";
import { activeWorkTasks } from "./cleanup-ports.js";
import { shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, lastSliceMigration, lineageMigration, shepherdMigration, ShepherdStore, sliceMigration, type RegistrationInput } from "./store.js";
import { lastSliceMarker } from "./task-close.js";

const REPO = "octo/demo";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface AwTask {
  id: string;
  status: string;
  notes: string;
  done_at: string | null;
}

/** Answers active-work's loopback rpc from one task; `task.done` is the store write that stamps `done_at`. */
function activeWork(task: AwTask): typeof fetch {
  return async (url, init) => {
    const command = String(url).split("/rpc/")[1];
    const args = JSON.parse(String(init?.body)) as { field?: "notes" | "status"; value?: string };
    if (command === "task.edit" && args.field) task[args.field] = args.value ?? "";
    if (command === "task.done") Object.assign(task, { status: "done", done_at: new Date(0).toISOString().slice(0, 10) });
    const data = command === "task.list" ? { tasks: [task] } : command === "source.list" ? { sources: [] } : {};
    return new Response(JSON.stringify({ ok: true, data }));
  };
}

interface Fixture {
  task: string;
  merged: number;
  open: number[];
}

/** Synthetic copies of the two misfires: TP-4264 closed on #2536 while #2541 was open; TP-4259 on #2550 while #2554 was. */
const TP4264: Fixture = { task: "demo/TP-4264", merged: 2536, open: [2541] };
const TP4259: Fixture = { task: "demo/TP-4259", merged: 2550, open: [2554] };

function world(fixture: Fixture, options: { taskClose?: TaskClose; body?: string; lastSlice?: boolean; slice?: string } = {}) {
  const fake: FakeGitHub = fakeGitHub({ repo: REPO });
  fake.addPr({ number: fixture.merged, headRef: `feat/${fixture.merged}`, headSha: fakeSha("head"), state: "closed", merged: true, mergeSha: fakeSha("merge"), body: options.body ?? "" });
  for (const pr of fixture.open) fake.addPr({ number: pr, headRef: `feat/${pr}`, headSha: fakeSha(`head-${pr}`) });
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), lastSliceMigration(43)]);
  const store = new ShepherdStore(db, () => 0);
  const own: RegistrationInput = { repo: REPO, pr: fixture.merged, runId: "run-merged", task: fixture.task, implementer: "impl-a", policy: OWNER_GATE_POLICY, ...(options.slice && { slice: options.slice }), ...(options.lastSlice && { lastSlice: true }) };
  store.register(own);
  for (const pr of fixture.open) store.register({ ...own, pr, runId: `run-${pr}`, slice: undefined, lastSlice: undefined });
  const task: AwTask = { id: fixture.task.split("/")[1]!, status: "open", notes: "", done_at: null };
  const cleanup = { agents: { roster: async () => [], invalidate: () => undefined, retire: async () => undefined }, tasks: activeWorkTasks({ origin: "http://127.0.0.1:7400", fetch: activeWork(task) }) };
  const deps = { port: githubPort(fake.wire), store: { get: () => store, bind: () => () => undefined }, now: () => 0, sleep: async () => undefined, cleanup, ...(options.taskClose && { taskClose: options.taskClose }) };
  const run = () => runCleanup(deps, { repo: REPO, pr: fixture.merged, runId: "run-merged" }, new AbortController().signal);
  return { task, run, landing: `${REPO}#${fixture.merged} at ${fakeSha("merge")}` };
}

describe("shepherd.taskClose", () => {
  it.each([TP4264, TP4259])("absent, closes the task #$merged delivers though another PR on it is open, as today", async (fixture) => {
    const w = world(fixture);

    const result = await w.run();

    expect(result.task).toBe("done");
    expect(w.task).toMatchObject({ status: "done", notes: `closed by Shepherd: ${w.landing} merged` });
  });

  it.each([TP4264, TP4259])("last-slice-only notes #$merged as a slice and leaves its task open while another registered PR is open", async (fixture) => {
    const w = world(fixture, { taskClose: "last-slice-only" });

    const result = await w.run();

    expect(result.task).toBe("slice-noted");
    expect(w.task).toEqual({ id: w.task.id, status: "open", notes: `slice merged: ${w.landing}`, done_at: null });
  });

  it.each([
    ["a Last slice: yes body line", { body: "Fixes the parser.\n\nlast slice: YES\n" }],
    ["register --last-slice", { lastSlice: true }],
  ])("last-slice-only closes on %s, writing done_at as a date", async (_, marker) => {
    const w = world(TP4264, { taskClose: "last-slice-only", ...marker });

    const result = await w.run();

    expect(result.task).toBe("done");
    expect(w.task.status).toBe("done");
    expect(w.task.done_at).toMatch(DATE);
  });

  it("last-slice-only closes when no other PR is registered open on the task", async () => {
    const w = world({ ...TP4264, open: [] }, { taskClose: "last-slice-only" });

    expect((await w.run()).task).toBe("done");
    expect(w.task.done_at).toMatch(DATE);
  });

  it("last-slice-only leaves the task open on a Last slice: no body line, though nothing else is open", async () => {
    const w = world({ ...TP4264, open: [] }, { taskClose: "last-slice-only", body: "Last slice: no" });

    expect((await w.run()).task).toBe("slice-noted");
    expect(w.task.status).toBe("open");
  });

  it("last-slice-only closes a --slice registration only on its last-slice mark, after noting the slice", async () => {
    const plain = world({ ...TP4264, open: [] }, { taskClose: "last-slice-only", slice: "d" });
    const last = world({ ...TP4264, open: [] }, { taskClose: "last-slice-only", slice: "d", lastSlice: true });

    const results = [(await plain.run()).task, (await last.run()).task];

    expect(results).toEqual(["noted", "done"]);
    expect(plain.task).toMatchObject({ status: "open", notes: `d landed in ${plain.landing}` });
    expect(last.task.notes).toBe(`d landed in ${last.landing}\nclosed by Shepherd: ${last.landing} merged`);
  });
});

describe("lastSliceMarker", () => {
  it("reads a whole Last slice line in any case, and nothing else", () => {
    expect([lastSliceMarker("x\n  Last Slice: yes  \n"), lastSliceMarker("last slice: no"), lastSliceMarker("Last slice: yes please"), lastSliceMarker(undefined)]).toEqual(["yes", "no", undefined, undefined]);
  });
});
