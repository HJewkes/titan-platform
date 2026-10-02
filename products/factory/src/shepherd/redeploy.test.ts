import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_REPO } from "../build-info.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { isFactoryRepo, redeploy, REDEPLOY_LOG, systemDeployer, type Deployer, type DeployerPorts } from "./redeploy.js";
import { shepherdStoreRef } from "./store.js";

const OWN_REPO = FACTORY_REPO!;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function fakeDeployer(running = "unknown"): Deployer & { spawned: string[] } {
  const spawned: string[] = [];
  return { spawned, runningSha: () => running, spawn: (sha) => (spawned.push(sha), { pid: 4242, log: "/state/redeploy.log" }) };
}

function withPr(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  return fake;
}

function world(conclusion: string | null, deployer: Deployer, fake: FakeGitHub = withPr(), dbPath = ":memory:") {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && conclusion !== null && fake.setRuns(sha, [successRun("validate", 5, undefined, conclusion)]), base.checkRuns(repo, sha)) };
  let clock = 0;
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), redeploy: deployer });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake };
}

async function mergeIn(w: ReturnType<typeof world>, repo: string, params: Record<string, string> = {}): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY), ...params });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

const redeploySteps = (w: ReturnType<typeof world>, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("sh-redeploy"));

describe("sh-redeploy after main CI", () => {
  it("spawns the deployer for the merge sha after green main CI on the factory's own repo", async () => {
    const deployer = fakeDeployer();
    const w = world("success", deployer);
    const runId = await mergeIn(w, OWN_REPO);

    await w.host.runtime.wait(runId);

    const mergeSha = w.fake.pr(1).mergeSha;
    expect(deployer.spawned).toEqual([mergeSha]);
    expect(redeploySteps(w, runId)).toMatchObject([{ stepId: `sh-redeploy:${mergeSha}`, data: { result: { spawned: true, pid: 4242 } } }]);
  });

  it("records no step and spawns nothing after green main CI on another repo", async () => {
    const deployer = fakeDeployer();
    const w = world("success", deployer);
    const runId = await mergeIn(w, REPO);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(redeploySteps(w, runId)).toEqual([]);
    expect(deployer.spawned).toEqual([]);
  });

  it("spawns nothing when main CI on the factory's repo is red", async () => {
    const deployer = fakeDeployer();
    const w = world("failure", deployer);
    const runId = await mergeIn(w, OWN_REPO);

    await gateOpened(w.host, gateId(runId, "main-frozen"));

    expect(redeploySteps(w, runId)).toEqual([]);
    expect(deployer.spawned).toEqual([]);
  });

  it("spawns nothing when main CI on the factory's repo is never read", async () => {
    const deployer = fakeDeployer();
    const w = world(null, deployer);
    const runId = await mergeIn(w, OWN_REPO);

    await gateOpened(w.host, gateId(runId, "main-red"));

    expect(redeploySteps(w, runId)).toEqual([]);
    expect(deployer.spawned).toEqual([]);
  });

  it("spawns no second deployer when the service restarted by the first resumes the run", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp774-")), "factory.db");
    const fake = withPr();
    const first = world("success", fakeDeployer(), fake, dbPath);
    const runId = await mergeIn(first, OWN_REPO, { after: JSON.stringify(["deploy"]) });
    await gateOpened(first.host, gateId(runId, "after-stages"));
    first.host.close();

    const restarted = fakeDeployer();
    const second = world("success", restarted, fake, dbPath);
    await second.host.adopt();
    await gateOpened(second.host, gateId(runId, "after-stages"));
    second.host.runtime.signal(runId, "after-stages", { decision: "acknowledged", mergeSha: fake.pr(1).mergeSha }, OWNER);
    await second.host.runtime.wait(runId);

    expect(second.host.runtime.status(runId)!.status).toBe("completed");
    expect(restarted.spawned).toEqual([]);
    expect(redeploySteps(second, runId)).toHaveLength(1);
  });
});

/** Ports that record each effect; `failing` names the one that throws. */
function fakePorts(failing?: "spawn" | "mkdir" | "openAppend" | "append") {
  const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const effects: string[] = [];
  const errorHandlers: ((error: Error) => void)[] = [];
  const fail = (port: string) => {
    if (port === failing) throw new Error(`${port} refused`);
  };
  const ports: DeployerPorts = {
    spawn: (file, args, options) => {
      fail("spawn");
      calls.push({ file, args, options: options as Record<string, unknown> });
      const on = (_event: string, handler: (error: Error) => void) => void errorHandlers.push(handler);
      return { pid: 777, unref: () => void effects.push("unref"), on: on as never };
    },
    mkdir: (dir) => (fail("mkdir"), void effects.push(`mkdir ${dir}`)),
    append: (path) => (fail("append"), void effects.push(`append ${path}`)),
    openAppend: (path) => (fail("openAppend"), effects.push(`open ${path}`), 9),
    close: (fd) => void effects.push(`close ${fd}`),
  };
  return { ports, calls, effects, errorHandlers };
}

const stepIdsOf = (w: ReturnType<typeof world>, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);

describe("sh-redeploy when the deployer cannot start", () => {
  it.each(["spawn", "mkdir", "openAppend"] as const)("records spawned false when %s throws, and still unfreezes and cleans up", async (failing) => {
    const deployer = systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node" }, fakePorts(failing).ports);
    const w = world("success", deployer);
    const runId = await mergeIn(w, OWN_REPO);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(redeploySteps(w, runId)).toMatchObject([{ data: { result: { spawned: false, detail: `the deployer did not start: ${failing} refused` } } }]);
    expect(stepIdsOf(w, runId)).toEqual(expect.arrayContaining(["sh-unfreeze", "sh-cleanup"]));
  });
});

describe("redeploy", () => {
  const input = { repo: OWN_REPO, pr: 1, mergeSha: "a".repeat(40) };

  it("spawns nothing when the service already runs the merge sha", () => {
    const deployer = fakeDeployer(input.mergeSha);

    expect(redeploy(deployer, input)).toMatchObject({ spawned: false, detail: `the service already runs ${input.mergeSha}` });
    expect(deployer.spawned).toEqual([]);
  });

  it("spawns nothing when no deployer is wired", () => {
    expect(redeploy(undefined, input)).toMatchObject({ spawned: false, detail: "no deployer wired" });
  });

  it("reports no spawn when the deployer got no pid", () => {
    const deployer: Deployer = { runningSha: () => "unknown", spawn: () => ({ pid: undefined, log: "/state/redeploy.log" }) };

    expect(redeploy(deployer, input)).toMatchObject({ spawned: false });
  });

  it("matches the factory's repo case-insensitively and no other", () => {
    expect(isFactoryRepo(OWN_REPO.toUpperCase())).toBe(true);
    expect(isFactoryRepo(REPO)).toBe(false);
  });
});

describe("systemDeployer", () => {
  it("starts service deploy detached in its own session, logging to the state dir, and lets the service exit without it", () => {
    const fake = fakePorts();
    const deployer = systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node" }, fake.ports);

    const started = deployer.spawn("b".repeat(40));

    const log = join("/state", REDEPLOY_LOG);
    expect(started).toEqual({ pid: 777, log });
    expect(fake.calls).toEqual([
      { file: "/bin/node", args: ["/factory/dist/bin.js", "service", "deploy", "--expect", "b".repeat(40)], options: { cwd: "/state", detached: true, stdio: ["ignore", 9, 9] } },
    ]);
    expect(fake.effects).toEqual(["mkdir /state", `append ${log}`, `open ${log}`, "unref", "close 9"]);
  });

  it("swallows a log append that throws while reporting a late spawn error, so the service does not crash", () => {
    const fake = fakePorts();
    systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node" }, fake.ports).spawn("b".repeat(40));
    fake.ports.append = () => {
      throw new Error("disk full");
    };

    expect(() => fake.errorHandlers.forEach((handler) => handler(new Error("ENOENT")))).not.toThrow();
    expect(fake.errorHandlers).toHaveLength(1);
  });
});
