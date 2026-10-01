import { tmpdir } from "node:os";
import { GITHUB_ACTIONS_APP_ID, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { CleanupPorts } from "./cleanup.js";
import { freezeStoreRef } from "./freeze.js";
import type { MainRedWiring } from "./main-red.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS, type MainCiInput } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import { OWNER } from "../test-support/resolver.js";

const MERGE = fakeSha("merge");
const OTHER_APP = 999;
const input: MainCiInput = { repo: REPO, mergeSha: MERGE, after: [] };

function clockedTiming() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
}

const read = (fake: FakeGitHub, timing = clockedTiming(), given: MainCiInput = input) => readMainCi(githubPort(fake.wire), given, timing, new AbortController().signal);

describe("readMainCi", () => {
  it("reads the merge sha, not the PR head sha", async () => {
    const fake = fakeGitHub();
    fake.setRuns(H1, [successRun("validate", 1)]);
    fake.setRuns(MERGE, [successRun("validate", 2, undefined, "failure")]);

    const result = await read(fake);

    expect(result).toMatchObject({ verdict: "red", mergeSha: MERGE });
  });

  it("does not count a run from an app that is not allowed", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1, undefined, "success", OTHER_APP)]);

    const result = await read(fake);

    expect(result.verdict).toBe("none");
  });

  it("ignores a red run from a non-allowed app beside a green allowed run", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1), successRun("external", 2, undefined, "failure", OTHER_APP)]);

    expect((await read(fake)).verdict).toBe("green");
  });

  it("answers none, not green, when the deadline passes with no run", async () => {
    const timing = clockedTiming();

    const result = await read(fakeGitHub(), timing);

    expect(result.verdict).toBe("none");
    expect(timing.now()).toBeGreaterThanOrEqual(SH_MAIN_CI_TIMEOUT_MS);
  });

  it("answers none when a run never finishes before the deadline", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [{ ...successRun("validate", 1), status: "in_progress", conclusion: null }]);

    expect((await read(fake)).verdict).toBe("none");
  });

  it("keeps an older red run visible beside a newer green run of the same name", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1, "2026-01-01T00:00:00Z", "failure"), successRun("validate", 2, "2026-01-01T01:00:00Z")]);

    expect((await read(fake)).verdict).toBe("red");
  });

  it("answers none when the read fails until the deadline", async () => {
    const fake = fakeGitHub();
    fake.wire.listCheckRuns = async () => {
      throw new Error("boom");
    };

    expect((await read(fake)).verdict).toBe("none");
  });

  it("answers none for a missing merge sha without reading", async () => {
    const fake = fakeGitHub();

    const result = await read(fake, clockedTiming(), { ...input, mergeSha: "" });

    expect(result.verdict).toBe("none");
    expect(fake.calls).not.toContain("listCheckRuns");
  });

  it("answers green when every allowed run passed", async () => {
    const fake = fakeGitHub();
    fake.setRuns(MERGE, [successRun("validate", 1), successRun("dag-check", 2)]);

    expect((await read(fake)).verdict).toBe("green");
    expect(GITHUB_ACTIONS_APP_ID).toBe(15368);
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function shepherdWorld(mergeRuns: () => ReturnType<typeof successRun>[], cleanup?: CleanupPorts, mainRed?: Omit<MainRedWiring, "freezes">) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, mergeRuns()), base.checkRuns(repo, sha)) };
  let clock = 0;
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port, store, freeze, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), cleanup, mainRed });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, store, freezes: () => freeze.get() };
}

async function runToMerge(w: ReturnType<typeof shepherdWorld>, params: Record<string, string> = {}): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), ...params });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

const stepIds = (w: ReturnType<typeof shepherdWorld>, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);

describe("shepherd-pr after land", () => {
  it("records green main CI on the merge sha and opens no gate", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = await runToMerge(w);

    await w.host.runtime.wait(runId);

    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { verdict: "green", mergeSha: w.fake.pr(1).mergeSha, after: [] } });
  });

  it("cleans up once after green main CI, deleting the merged head branch", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    w.fake.pr(1).headRepo = REPO;
    w.fake.refs.set(w.fake.pr(1).headRef, H1);
    const runId = await runToMerge(w);

    await w.host.runtime.wait(runId);

    const cleanup = Object.values(w.host.runtime.status(runId)!.stepResults).filter((result) => result.stepId === "sh-cleanup");
    expect(cleanup.map((result) => result.data)).toMatchObject([{ result: { ref: "deleted", task: "no registration" } }]);
    expect(w.fake.refs.has(w.fake.pr(1).headRef)).toBe(false);
  });

  it("closes the registration's task and retires its implementer through the wired cleanup ports", async () => {
    const closed: string[] = [];
    const retired: string[] = [];
    const cleanup: CleanupPorts = {
      tasks: { state: async () => "open", done: async (initiative, id) => void closed.push(`${initiative}/${id}`), appendNote: async () => undefined },
      agents: { roster: async () => (retired.includes("impl-a") ? [] : [{ name: "impl-a", presence: "exited", status: "finished" }]), retire: async (name) => void retired.push(name) },
    };
    const w = shepherdWorld(() => [successRun("validate", 5)], cleanup);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);

    await w.host.runtime.wait(runId);

    expect(closed).toEqual(["demo/TP-1"]);
    expect(retired).toEqual(["impl-a"]);
  });

  it("freezes the repo and offers the owner the release when main is red and no task port is wired", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")]);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    w.host.runtime.signal(runId, "main-frozen", { decision: "stay-frozen", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).toContain("sh-freeze");
    expect(w.freezes().get(REPO)?.redSha).toBe(w.fake.pr(1).mergeSha);
  });

  it("gates on a non-empty after list and runs no stage", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = await runToMerge(w, { after: JSON.stringify(["deploy", "release"]) });

    await gateOpened(w.host, gateId(runId, "after-stages"));
    const before = stepIds(w, runId);
    w.host.runtime.signal(runId, "after-stages", { decision: "acknowledged", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(before.filter((id) => /deploy|release|activation/.test(id))).toEqual([]);
    expect(stepIds(w, runId).filter((id) => /deploy|release|activation/.test(id))).toEqual([]);
    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { after: ["deploy", "release"] } });
  });

  it("opens the main-red gate when no run appears at the merge sha", async () => {
    const w = shepherdWorld(() => []);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-red"));

    const main = Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "sh-main-ci");
    expect(main?.data).toMatchObject({ result: { verdict: "none" } });
  });

  it("fails a malformed after list before any merge, not after it", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)]);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), after: "not json" });

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("failed");
    expect(w.fake.calls).not.toContain("merge");
    expect(stepIds(w, runId)).not.toContain("merge");
  });
});

const FIXER_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" };
const EARLIER_RED = fakeSha("earlier-red");
const FIXER = "fix-widget-aaaaaaa";

function mainRedPorts() {
  const added: string[] = [];
  const spawned: string[] = [];
  const mainRed: Omit<MainRedWiring, "freezes"> = {
    tasks: { findByTag: async () => undefined, add: async (_initiative, fields) => `FX-${added.push(fields.title)}` },
    fixers: { roster: async () => spawned.map((name) => ({ name })), spawn: async (name) => void spawned.push(name) },
    checkoutFor: () => tmpdir(),
  };
  return { mainRed, added, spawned };
}

/** Starts a run for PR 1 and registers it before the merge gate, as `shepherd.register` would. */
async function registeredToMerge(w: ReturnType<typeof shepherdWorld>, task: string, implementer: string): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(FIXER_POLICY) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task, implementer, policy: FIXER_POLICY });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

/** The repo is already frozen at an earlier red with a fix task and a fixer, before PR 1's run starts. */
function frozenWithFixer(w: ReturnType<typeof shepherdWorld>): void {
  const freezes = w.freezes();
  freezes.freeze(REPO, EARLIER_RED);
  freezes.setFixTask(REPO, "demo/FX-1");
  freezes.setFixer(REPO, FIXER);
}

describe("shepherd-pr on a red main", () => {
  it("freezes, files one fix task and spawns one fixer, and asks the owner nothing", async () => {
    const ports = mainRedPorts();
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, ports.mainRed);
    const runId = await registeredToMerge(w, "demo/TP-1", "impl-a");

    await w.host.runtime.wait(runId);

    expect(ports.added).toHaveLength(1);
    expect(ports.spawned).toHaveLength(1);
    expect(w.freezes().get(REPO)).toMatchObject({ fixTask: "demo/FX-1", fixer: ports.spawned[0] });
    expect(w.host.gates.listPending()).toEqual([]);
  });

  it("opens main-red-again on a red at the fixer's own merge, spawns no second fixer, and thaws on the owner's word", async () => {
    const ports = mainRedPorts();
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, ports.mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-red-again"));
    const before = { added: ports.added.length, spawned: ports.spawned.length };
    w.host.runtime.signal(runId, "main-red-again", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(before).toEqual({ added: 0, spawned: 0 });
    expect(ports.spawned).toEqual([]);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("unfreezes when the fixer's merge is green", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await w.host.runtime.wait(runId);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("neither freezes nor unfreezes when no run appears at the merge sha", async () => {
    const w = shepherdWorld(() => [], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-red"));

    expect(w.freezes().get(REPO)).toMatchObject({ redSha: EARLIER_RED, redCount: 1 });
    expect(stepIds(w, runId)).not.toContain("sh-freeze");
    expect(stepIds(w, runId)).not.toContain("sh-unfreeze");
  });

  it("files a task, spawns nothing and thaws on the owner's word when the policy grants no fixer", async () => {
    const ports = mainRedPorts();
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, ports.mainRed);
    const runId = await runToMerge(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    const frozenAtGate = w.freezes().isFrozen(REPO);
    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(ports.added).toHaveLength(1);
    expect(ports.spawned).toEqual([]);
    expect(frozenAtGate).toBe(true);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("thaws on the owner's word when no fix task could be filed", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5, undefined, "failure")], undefined, { ...mainRedPorts().mainRed, tasks: undefined });
    const runId = await registeredToMerge(w, "demo/TP-1", "impl-a");

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("offers the owner the release when the fixer's green merge skipped a check that was red, and thaws on the owner's word", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)], undefined, mainRedPorts().mainRed);
    w.fake.setRuns(EARLIER_RED, [successRun("docs", 4, undefined, "failure")]);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await gateOpened(w.host, gateId(runId, "main-frozen"));
    const frozenAtGate = w.freezes().isFrozen(REPO);
    w.host.runtime.signal(runId, "main-frozen", { decision: "unfreeze", mergeSha: w.fake.pr(1).mergeSha }, OWNER);
    await w.host.runtime.wait(runId);

    expect(frozenAtGate).toBe(true);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("opens no gate when the fixer's green merge thaws the repo", async () => {
    const w = shepherdWorld(() => [successRun("validate", 5)], undefined, mainRedPorts().mainRed);
    frozenWithFixer(w);
    const runId = await registeredToMerge(w, "demo/FX-1", FIXER);

    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).not.toContain("main-frozen");
  });
});
