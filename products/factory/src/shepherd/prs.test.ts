import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, type FixtureOptions } from "../test-support/shepherd.js";
import { prSnapshot, type PrSnapshot } from "../workflows/pr-snapshot.js";
import { MERGED_WINDOW_MS, shepherdPrs, type PrRow, type PrsSources, type ShepherdedRun } from "./prs.js";
import type { Registration } from "./store.js";

const MINUTE = 60_000;
const MERGE_SHA = fakeSha("squash-of-pr-4");
const NOW = Date.parse("2026-03-02T12:00:00.000Z");

interface World {
  fake: FakeGitHub;
  snapshot: PrSnapshot;
  clock: { now: number };
}

function world(): World {
  const fake = fakeGitHub({ repo: REPO });
  const clock = { now: NOW };
  return { fake, clock, snapshot: prSnapshot(githubPort(fake.wire), { now: () => clock.now }) };
}

function sources(w: World, runs: ShepherdedRun[] = [], seatRepos: string[] = [REPO]): PrsSources {
  return { snapshot: w.snapshot, shepherded: async () => runs, seatRepos: () => seatRepos, now: () => w.clock.now };
}

function step(stepId: string, completedAt: string, result: object): StepResult {
  return { stepId, iteration: 0, operation: "dispatch", agentId: null, signal: null, completedAt, data: { result } };
}

function shepherded(pr: number, steps: StepResult[], completedAt: string | null = null): ShepherdedRun {
  const registration = { repo: REPO, pr, branch: `agent-chat/demo-${pr}`, runId: `run-${pr}` } as Registration;
  const stepResults = Object.fromEntries(steps.map((result) => [`${result.stepId}:0`, result]));
  const run = { id: `run-${pr}`, params: {}, stepResults, completedAt } as unknown as WorkflowRun;
  return { registration, run, phase: completedAt ? "done" : "ci", headSha: fakeSha(`head-of-${pr}`) };
}

const rulesStep = (contexts: string[]): StepResult => step("land-rules:r0", "2026-03-02T10:00:00.000Z", { base: "main", contexts, strict: true });

describe("shepherdPrs", () => {
  it("serves N concurrent callers from one open-list read", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, title: "Add the widget", body: "Synthetic body." });

    const answers = await Promise.all(Array.from({ length: 8 }, () => shepherdPrs(sources(w))));

    expect(w.fake.calls.filter((call) => call === "revalidateOpenPrs")).toHaveLength(1);
    expect(answers.every((rows) => rows.length === 1 && rows[0]!.headSha === H1)).toBe(true);
  });

  it("answers with no GitHub call while the list is under 60 s old, and revalidates at 60 s", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1 });
    await shepherdPrs(sources(w));
    const warm = w.fake.calls.length;

    w.clock.now += MINUTE - 1;
    await shepherdPrs(sources(w));
    expect(w.fake.calls.length).toBe(warm);

    w.clock.now += 1;
    await shepherdPrs(sources(w));
    expect(w.fake.calls.slice(warm)).toEqual(["revalidateOpenPrs"]);
  });

  it("returns the plan's row shape for an open PR, dated by its list read", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH, title: "Add the widget", body: "Synthetic body.", draft: true });

    const [row] = await shepherdPrs(sources(w));

    expect(row).toEqual<PrRow>({ repo: REPO, number: 1, branch: BRANCH, headSha: H1, base: "main", state: "open", mergedAt: null, mergeSha: null, title: "Add the widget", body: "Synthetic body.", draft: true, registered: false, source: "snapshot", at: new Date(NOW).toISOString() });
  });

  it("lists a seat repo's open PR when no run waits in it", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1 });

    const rows = await shepherdPrs(sources(w, [], [REPO.toUpperCase()]));

    expect(rows).toMatchObject([{ repo: REPO, number: 1, registered: false }]);
    expect(rows[0]).not.toHaveProperty("runId");
  });

  it("carries a merged-by-Shepherd PR's mergeSha from its merge step with no getPr", async () => {
    const w = world();
    const mergedAt = new Date(NOW - 2 * MINUTE).toISOString();
    const run = shepherded(4, [rulesStep(["validate"]), step("merge:r0", mergedAt, { done: true, mergeSha: MERGE_SHA })], mergedAt);

    const rows = await shepherdPrs(sources(w, [run]));

    expect(rows).toEqual([{ repo: REPO, number: 4, branch: "agent-chat/demo-4", headSha: fakeSha("head-of-4"), base: "main", state: "merged", mergedAt, mergeSha: MERGE_SHA, title: null, body: null, draft: false, registered: true, runId: "run-4", phase: "done", source: "merge-step", at: mergedAt }]);
    expect(w.fake.calls).not.toContain("getPr");
  });

  it("leaves out a merge older than the window and a merge step that did not land", async () => {
    const w = world();
    const old = new Date(NOW - MERGED_WINDOW_MS - 1).toISOString();
    const recent = new Date(NOW - MINUTE).toISOString();
    const runs = [shepherded(4, [step("merge:r0", old, { done: true, mergeSha: MERGE_SHA })], old), shepherded(5, [step("merge:r0", recent, { done: false, skipped: "base-moved", mergeSha: "" })])];

    expect(await shepherdPrs(sources(w, runs))).toEqual([]);
    expect(w.fake.calls).not.toContain("getPr");
  });

  it("leaves ci absent, and reads no checks, when the snapshot holds none for the head", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1 });
    w.fake.setRuns(H1, [successRun("validate", 1)]);

    const [row] = await shepherdPrs(sources(w));

    expect(row).not.toHaveProperty("ci");
    expect(w.fake.calls).toEqual(["revalidateOpenPrs"]);
  });

  it("reports the snapshot's cached checks with the run's missing required contexts", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: "agent-chat/demo-1" });
    w.fake.setRuns(H1, [successRun("validate", 1)]);
    await w.snapshot.checkRuns(REPO, H1, () => true);
    const run = { ...shepherded(1, [rulesStep(["validate", "dag-check"])]), headSha: H1 };

    const [row] = await shepherdPrs(sources(w, [run]));

    expect(row).toMatchObject({ registered: true, runId: "run-1", phase: "ci", ci: { head: H1, state: "pending", requiredMissing: ["dag-check"], at: new Date(NOW).toISOString() } });
  });

  it("dates ci by when its runs were read, not by an invalidate since", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1 });
    w.fake.setRuns(H1, [successRun("validate", 1)]);
    await w.snapshot.checkRuns(REPO, H1, () => true);
    w.clock.now += 2 * MINUTE;
    w.snapshot.invalidate(REPO);

    const [row] = await shepherdPrs(sources(w));

    expect(row?.ci?.at).toBe(new Date(NOW).toISOString());
    expect(row?.at).toBe(new Date(NOW + 2 * MINUTE).toISOString());
  });

  it("reads a head whose cached runs all passed as green", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1 });
    w.fake.setRuns(H1, [successRun("validate", 1), successRun("dag-check", 2)]);
    await w.snapshot.checkRuns(REPO, H1, () => true);

    const [row] = await shepherdPrs(sources(w));

    expect(row?.ci).toMatchObject({ state: "green", requiredMissing: [] });
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function served(options: FixtureOptions) {
  const fixture = shepherdFixture(options);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...fixture, host, call: <T>(name: string, args: unknown) => callCommand<T>(host, fixture.routes, name, args) };
}

describe("shepherd.prs", () => {
  it("marks a registered PR with its run and phase, and lists the repo's other PR unregistered", async () => {
    const w = served({ snapshot: true, frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    w.fake.addPr({ headSha: fakeSha("other-head") });
    const registered = await w.call<{ runId: string }>("shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
    if (!registered.ok) throw new Error(registered.error);

    const answer = await w.call<PrRow[]>("shepherd.prs", { repo: REPO });

    expect(answer).toMatchObject({ ok: true, data: [{ number: 1, registered: true, runId: registered.data.runId }, { number: 2, registered: false }] });
  });

  it("refuses on a host with no snapshot wired rather than reading GitHub", async () => {
    const w = served({});

    expect(await w.call("shepherd.prs", {})).toMatchObject({ ok: false, error: expect.stringContaining("without one") });
  });
});
