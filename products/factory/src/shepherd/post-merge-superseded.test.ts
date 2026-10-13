import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { freezeStoreRef } from "./freeze.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS, type MainCiInput } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const MERGE = fakeSha("merge");
const NEWER = fakeSha("newer-main-push");
const input: MainCiInput = { repo: REPO, pr: 1, mergeSha: MERGE, after: [] };
type Run = ReturnType<typeof successRun>;

function clockedTiming(onSleep: (now: number) => void = () => undefined) {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => onSleep((clock += ms)), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
}

/** Main has moved to NEWER, which contains the merge; concurrency cancelled the merge sha's queued run before any job ran. */
function supersededQueue(newerRuns: Run[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.rules = { contexts: [], strict: false };
  fake.addPr({ headSha: H1, baseRef: "main" });
  fake.refs.set("main", NEWER);
  fake.compares.set(`${MERGE}...${NEWER}`, { mergeBaseSha: MERGE, files: [] });
  fake.setRuns(NEWER, newerRuns);
  return fake;
}

const read = (fake: FakeGitHub, timing = clockedTiming()) => readMainCi(githubPort(fake.wire), input, timing, new AbortController().signal);

describe("readMainCi on a merge whose queued main run a newer push superseded", () => {
  it("reads the newer push's green run, not a timeout, when the merge sha has no run", async () => {
    const timing = clockedTiming();

    const result = await read(supersededQueue([successRun("validate", 2)]), timing);

    expect(result).toMatchObject({ verdict: "green", mergeSha: MERGE, readSha: NEWER });
    expect(timing.now()).toBeLessThan(SH_MAIN_CI_TIMEOUT_MS);
  });

  it("answers red from the newer push's red run", async () => {
    expect(await read(supersededQueue([successRun("validate", 2, undefined, "failure")]))).toMatchObject({ verdict: "red", readSha: NEWER });
  });

  it("waits past one window for a newer push whose run has not started behind the running one", async () => {
    const fake = supersededQueue([]);
    const timing = clockedTiming((now) => void (now > SH_MAIN_CI_TIMEOUT_MS + 60_000 && fake.setRuns(NEWER, [successRun("validate", 2)])));

    expect(await read(fake, timing)).toMatchObject({ verdict: "green", readSha: NEWER });
  });

  it("waits out the deadline, never following, when main has not moved past the merge sha", async () => {
    const fake = supersededQueue([successRun("validate", 2)]);
    fake.refs.set("main", MERGE);

    expect(await read(fake)).toMatchObject({ verdict: "none" });
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/**
 * A Shepherd run whose merge is followed by a green NEWER on main; `mergeRuns` sit at the merge sha. The repo requires no
 * context, so no green descendant can acknowledge a red read and only reading the cancel as superseded keeps the gate shut.
 */
function supersededWorld(mergeRuns: Run[]) {
  const fake = fakeGitHub();
  fake.rules = { contexts: [], strict: false };
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const mergedAt = (sha: string) => {
    if (sha !== fake.pr(1).mergeSha) return;
    fake.setRuns(sha, mergeRuns);
    fake.refs.set("main", NEWER);
    fake.compares.set(`${sha}...${NEWER}`, { mergeBaseSha: sha, files: [] });
    fake.setRuns(NEWER, [successRun("validate", 6), successRun("dag-check", 7)]);
  };
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (mergedAt(sha), base.checkRuns(repo, sha)) };
  let clock = 0;
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), freeze, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, freezes: () => freeze.get() };
}

async function mergeAndFinish(w: ReturnType<typeof supersededWorld>) {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await w.host.runtime.wait(runId);
  const results = Object.values(w.host.runtime.status(runId)!.stepResults);
  return { results, main: results.find((result) => result.stepId === "sh-main-ci") };
}

describe("shepherd-pr after land, when a newer main push superseded the merge's run", () => {
  it("opens no gate and freezes nothing when the merge's cancelled run is followed by a green newer run containing it", async () => {
    const w = supersededWorld([successRun("validate", 5, undefined, "cancelled"), successRun("dag-check", 6, undefined, "cancelled")]);

    const { results, main } = await mergeAndFinish(w);

    expect(main?.data).toMatchObject({ result: { verdict: "green", readSha: NEWER } });
    expect(results.map((result) => result.stepId)).not.toContain("sh-freeze");
    expect(w.host.gates.listPending()).toEqual([]);
    expect(w.freezes().isFrozen(REPO)).toBe(false);
  });

  it("opens no gate when concurrency cancelled the merge's queued run before any job ran", async () => {
    const w = supersededWorld([]);

    const { main } = await mergeAndFinish(w);

    expect(main?.data).toMatchObject({ result: { verdict: "green", readSha: NEWER } });
    expect(w.host.gates.listPending()).toEqual([]);
  });
});
