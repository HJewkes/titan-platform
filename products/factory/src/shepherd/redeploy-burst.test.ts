import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_REPO } from "../build-info.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { DEPLOY_QUIET_MS, noteWanted, pacerTick, readWanted, writeWanted, type WantedStore } from "./deploy-pacer.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { redeploy, systemDeployer, type DeployerPorts } from "./redeploy.js";
import { shepherdStoreRef } from "./store.js";

const OWN_REPO = FACTORY_REPO!;
const TIP = fakeSha("green-tip");
const RUNNING = fakeSha("running-build");
const AT = Date.parse("2026-10-22T07:57:30.000Z");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function memoryStore(): WantedStore {
  const files = new Map<string, string>();
  return {
    readFile: (path) => files.get(path),
    writeFile: (path, text) => void files.set(path, text),
    rename: (from, to) => (files.set(to, files.get(from) ?? ""), void files.delete(from)),
    remove: (path) => void files.delete(path),
  };
}

const unused = (): never => {
  throw new Error("the queue path starts no process");
};
const queueOnlyPorts: DeployerPorts = { spawn: unused, mkdir: () => undefined, append: unused, openAppend: unused, close: unused };

/** The merge's own main run was cancelled by concurrency; main has moved to TIP, which contains it and is green. */
function cancelledUnderGreenTip(fake: FakeGitHub): void {
  const mergeSha = fake.pr(1).mergeSha!;
  fake.refs.set("main", TIP);
  fake.compares.set(`${mergeSha}...${TIP}`, { mergeBaseSha: mergeSha, files: [] });
  fake.setRuns(TIP, [successRun("validate", 6), successRun("dag-check", 7)]);
  fake.setRuns(mergeSha, [successRun("validate", 5, undefined, "cancelled")]);
}

function world(store: WantedStore, running: string) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && cancelledUnderGreenTip(fake), base.checkRuns(repo, sha)) };
  const deployer = { ...systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", now: () => new Date(AT) }, queueOnlyPorts, store), runningSha: () => running };
  let clock = 0;
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), redeploy: deployer });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake };
}

async function landCancelledMerge(store: WantedStore, running = RUNNING): Promise<string> {
  const w = world(store, running);
  const runId = w.host.runtime.start("shepherd-pr", { repo: OWN_REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await w.host.runtime.wait(runId);
  return w.fake.pr(1).mergeSha!;
}

function tickAfterQuiet(store: WantedStore, runningHolds: (sha: string) => boolean = () => false): string[] {
  const spawned: string[] = [];
  pacerTick({
    stateDir: "/state",
    store,
    now: () => AT + DEPLOY_QUIET_MS,
    runningSha: () => RUNNING,
    runningHolds,
    lastDeploy: () => undefined,
    busy: () => 0,
    paused: () => false,
    spawn: (sha) => (spawned.push(sha), { pid: 4242 }),
    log: () => undefined,
  });
  return spawned;
}

describe("a burst of merges whose own main CI was cancelled under one green tip (TP-3959)", () => {
  it("queues the green tip sh-main-ci read, not the merge sha whose run was cancelled", async () => {
    const store = memoryStore();

    await landCancelledMerge(store);

    expect(readWanted("/state", store)?.sha).toBe(TIP);
  });

  it("keeps the green tip its own run queued when an older merge acknowledged on it queues after", async () => {
    const store = memoryStore();
    writeWanted("/state", store, noteWanted(undefined, TIP, AT));

    await landCancelledMerge(store);

    expect(tickAfterQuiet(store)).toEqual([TIP]);
  });

  it("does not clear the wanted tip because the running build already holds the older merge", async () => {
    const store = memoryStore();
    writeWanted("/state", store, noteWanted(undefined, TIP, AT));
    const mergeSha = await landCancelledMerge(store);

    const spawned = tickAfterQuiet(store, (sha) => sha === mergeSha);

    expect(spawned).toEqual([TIP]);
  });

  it("queues nothing when the service already runs the green tip", async () => {
    const store = memoryStore();

    await landCancelledMerge(store, TIP);

    expect(readWanted("/state", store)).toBeUndefined();
  });

  it("spawns the green tip, not the merge sha, when no pacer queue is wired", () => {
    const spawned: string[] = [];
    const deployer = { runningSha: () => RUNNING, spawn: (sha: string) => (spawned.push(sha), { pid: 4242, log: "/state/redeploy.log" }) };

    const result = redeploy(deployer, { repo: OWN_REPO, pr: 1, mergeSha: fakeSha("cancelled-merge"), greenSha: TIP });

    expect(spawned).toEqual([TIP]);
    expect(result.detail).toContain(`deploys ${TIP}`);
  });
});
