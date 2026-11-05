import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_REPO } from "../build-info.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { DEPLOY_WANTED, readWanted, type WantedStore } from "./deploy-pacer.js";
import { deployPacerPorts, deployUnitName, isFactoryRepo, redeploy, REDEPLOY_LOG, SYSTEMD_RUN, systemDeployer, type Deployer, type DeployerPorts } from "./redeploy.js";
import { shepherdStoreRef } from "./store.js";
import { partialFake } from "@titan-design/test-kit";
import type { ChildProcess } from "node:child_process";

const OWN_REPO = FACTORY_REPO!;
const SHA = "b".repeat(40);
const LOG = join("/state", REDEPLOY_LOG);
const DEPLOY_ARGS = ["/factory/dist/bin.js", "service", "deploy", "--expect", SHA];
const AT = new Date("2026-10-10T12:00:00.000Z");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function fakeDeployer(running = "unknown"): Deployer & { spawned: string[] } {
  const spawned: string[] = [];
  return { spawned, runningSha: () => running, spawn: (sha) => (spawned.push(sha), { pid: 4242, log: "/state/redeploy.log" }) };
}

/** `failing` makes every write throw, the way a full or read-only state dir does. */
function memoryStore(failing = false): WantedStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (path) => files.get(path),
    writeFile: (path, text) => {
      if (failing) throw new Error(`EROFS ${LEAKY_MESSAGE}`);
      files.set(path, text);
    },
    rename: (from, to) => (files.set(to, files.get(from) ?? ""), void files.delete(from)),
    remove: (path) => void files.delete(path),
  };
}

const spawnOnly = (deployer: Deployer): Deployer => ({ runningSha: deployer.runningSha, spawn: deployer.spawn });

function withPr(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  return fake;
}

function world(conclusion: string | null, deployer: Deployer, fake: FakeGitHub = withPr(), dbPath = ":memory:") {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && conclusion !== null && fake.setRuns(sha, [successRun("validate", 5, undefined, conclusion), successRun("dag-check", 6)]), base.checkRuns(repo, sha)) };
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

  it("queues the merge sha for the deploy pacer instead of spawning a deployer", async () => {
    const fake = fakePorts();
    const store = memoryStore();
    const w = world("success", systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node", now: () => AT }, fake.ports, store));
    const runId = await mergeIn(w, OWN_REPO);

    await w.host.runtime.wait(runId);

    const mergeSha = w.fake.pr(1).mergeSha;
    expect(fake.calls).toEqual([]);
    expect(redeploySteps(w, runId)).toMatchObject([{ data: { result: { spawned: false, queued: true, detail: `queued ${mergeSha}; deploys after 15 min with no newer merge, at most 45 min after the first` } } }]);
    expect(readWanted("/state", store)).toEqual({ sha: mergeSha, firstAt: AT.toISOString(), lastAt: AT.toISOString() });
  });

  it("records spawned false when the queue write fails, and still unfreezes and cleans up", async () => {
    const w = world("success", systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node" }, fakePorts().ports, memoryStore(true)));
    const runId = await mergeIn(w, OWN_REPO);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(redeploySteps(w, runId)).toMatchObject([{ data: { result: { spawned: false, detail: "the deploy was not queued: Error" } } }]);
    expectNoLeak(redeploySteps(w, runId));
    expect(stepIdsOf(w, runId)).toEqual(expect.arrayContaining(["sh-unfreeze", "sh-cleanup"]));
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

    await gateOpened(w.host, gateId(runId, "main-ci-timeout"));

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

/** Ports that record each effect; `failing` names the one that throws, `refusedFile` a program whose spawn throws. */
function fakePorts(failing?: "spawn" | "mkdir" | "openAppend" | "append", refusedFile?: string) {
  const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const effects: string[] = [];
  const lines: string[] = [];
  const handlers: Record<string, ((value: unknown) => void)[]>[] = [];
  const fail = (port: string) => {
    if (port === failing) throw new Error(`${port} refused`);
  };
  const ports: DeployerPorts = {
    spawn: (file, args, options) => {
      fail("spawn");
      if (file === refusedFile) throw new Error(`${file} refused`);
      calls.push({ file, args, options: { ...options } });
      const own: Record<string, ((value: unknown) => void)[]> = {};
      handlers.push(own);
      const on = (event: string, handler: (value: unknown) => void) => void (own[event] ??= []).push(handler);
      return Object.assign(partialFake<Pick<ChildProcess, "pid" | "unref" | "on">>(), { pid: 776 + calls.length, unref: () => void effects.push("unref"), on });
    },
    mkdir: (dir) => (fail("mkdir"), void effects.push(`mkdir ${dir}`)),
    append: (path, text) => (fail("append"), effects.push(`append ${path}`), void lines.push(text)),
    openAppend: (path) => (fail("openAppend"), effects.push(`open ${path}`), 9),
    close: (fd) => void effects.push(`close ${fd}`),
  };
  const emit = (spawned: number, event: string, value: unknown) => handlers[spawned]?.[event]?.forEach((handler) => handler(value));
  return { ports, calls, effects, lines, emit, errorHandlers: () => handlers.flatMap((own) => own.error ?? []) };
}

const stepIdsOf = (w: ReturnType<typeof world>, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);

describe("sh-redeploy when the deployer cannot start", () => {
  it.each(["spawn", "mkdir", "openAppend"] as const)("records spawned false when %s throws, and still unfreezes and cleans up", async (failing) => {
    const deployer = spawnOnly(systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node" }, fakePorts(failing).ports));
    const w = world("success", deployer);
    const runId = await mergeIn(w, OWN_REPO);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(redeploySteps(w, runId)).toMatchObject([{ data: { result: { spawned: false, detail: "the deployer did not start: Error" } } }]);
    expect(stepIdsOf(w, runId)).toEqual(expect.arrayContaining(["sh-unfreeze", "sh-cleanup"]));
  });
});

describe("redeploy", () => {
  const input = { repo: OWN_REPO, pr: 1, mergeSha: "a".repeat(40) };

  it("spawns nothing when the service already runs the merge sha", async () => {
    const deployer = fakeDeployer(input.mergeSha);

    expect(await redeploy(deployer, input)).toMatchObject({ spawned: false, detail: `the service already runs ${input.mergeSha}` });
    expect(deployer.spawned).toEqual([]);
  });

  it("spawns nothing when no deployer is wired", async () => {
    expect(await redeploy(undefined, input)).toMatchObject({ spawned: false, detail: "no deployer wired" });
  });

  it("records the error class, never a URL or token from the spawn error", async () => {
    const deployer: Deployer = {
      runningSha: () => "unknown",
      spawn: () => {
        throw new Error(LEAKY_MESSAGE);
      },
    };

    const result = await redeploy(deployer, input);

    expect(result).toMatchObject({ spawned: false, detail: "the deployer did not start: Error" });
    expectNoLeak(result);
  });

  it("asks a deployer that queues before the running-sha check only when the sha is new", async () => {
    const deployer = { ...fakeDeployer(input.mergeSha), request: () => ({ spawned: false, queued: true, detail: "queued" }) };

    expect(await redeploy(deployer, input)).toMatchObject({ spawned: false, detail: `the service already runs ${input.mergeSha}` });
  });

  it("records a request that throws as no spawn, with the error class only", async () => {
    const deployer: Deployer = {
      ...fakeDeployer(),
      request: () => {
        throw new Error(LEAKY_MESSAGE);
      },
    };

    const result = await redeploy(deployer, input);

    expect(result).toEqual({ spawned: false, detail: "the deploy was not queued: Error" });
    expectNoLeak(result);
  });

  it("reports no spawn when the deployer got no pid", async () => {
    const deployer: Deployer = { runningSha: () => "unknown", spawn: () => ({ pid: undefined, log: "/state/redeploy.log" }) };

    expect(await redeploy(deployer, input)).toMatchObject({ spawned: false });
  });

  it("matches the factory's repo case-insensitively and no other", () => {
    expect(isFactoryRepo(OWN_REPO.toUpperCase())).toBe(true);
    expect(isFactoryRepo(REPO)).toBe(false);
  });
});

const deployerOn = (platform: NodeJS.Platform, ports: DeployerPorts, at = AT) => systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node", platform, now: () => at }, ports);
const setsidCall = { file: "/bin/node", args: DEPLOY_ARGS, options: { cwd: "/state", detached: true, stdio: ["ignore", 9, 9] } };

describe("systemDeployer on darwin", () => {
  it("starts service deploy detached in its own session, logging to the state dir, and lets the service exit without it", () => {
    const fake = fakePorts();

    const started = deployerOn("darwin", fake.ports).spawn(SHA);

    expect(started).toEqual({ pid: 777, log: LOG });
    expect(fake.calls).toEqual([setsidCall]);
    expect(fake.effects).toEqual(["mkdir /state", `append ${LOG}`, `open ${LOG}`, "unref", "close 9"]);
  });

  it("swallows a log append that throws while reporting a late spawn error, so the service does not crash", () => {
    const fake = fakePorts();
    deployerOn("darwin", fake.ports).spawn(SHA);
    fake.ports.append = () => {
      throw new Error("disk full");
    };

    expect(() => fake.emit(0, "error", new Error("ENOENT"))).not.toThrow();
    expect(fake.errorHandlers()).toHaveLength(1);
  });
});

describe("deployPacerPorts", () => {
  it("spawns through the same systemd-run unit and log as the per-merge deployer, in the deployer's state dir", () => {
    const fake = fakePorts();

    const pacer = deployPacerPorts({ bin: "/factory/dist/bin.js", stateDir: "/state", node: "/bin/node", platform: "linux", now: () => AT }, fake.ports);
    const started = pacer.spawn(SHA);

    expect(pacer.stateDir).toBe("/state");
    expect(started).toEqual({ pid: 777, log: LOG });
    expect(fake.calls[0]).toMatchObject({ file: SYSTEMD_RUN, args: expect.arrayContaining(["--unit", deployUnitName(SHA, AT), "/bin/node", ...DEPLOY_ARGS]) });
    expect(fake.lines).toEqual([`${AT.toISOString()} service deploy --expect ${SHA}\n`]);
  });

  it("queues into the file the pacer reads", async () => {
    const store = memoryStore();

    await systemDeployer({ bin: "/factory/dist/bin.js", stateDir: "/state", now: () => AT }, fakePorts().ports, store).request?.(SHA);

    expect([...store.files.keys()]).toEqual([join("/state", DEPLOY_WANTED)]);
  });
});

describe("systemDeployer on systemd", () => {
  it("starts service deploy in its own transient user unit, outside the service's cgroup, logging to the state dir", () => {
    const fake = fakePorts();

    const started = deployerOn("linux", fake.ports).spawn(SHA);

    expect(started).toEqual({ pid: 777, log: LOG });
    expect(fake.calls).toEqual([
      {
        file: SYSTEMD_RUN,
        args: ["--user", "--collect", "--quiet", "--unit", deployUnitName(SHA, AT), "--working-directory=/state", "--setenv=PATH", `--property=StandardOutput=append:${LOG}`, `--property=StandardError=append:${LOG}`, "--", "/bin/node", ...DEPLOY_ARGS],
        options: { cwd: "/state", detached: true, stdio: ["ignore", 9, 9] },
      },
    ]);
    expect(fake.lines).toEqual([`${AT.toISOString()} service deploy --expect ${SHA}\n`]);
  });

  it("names each deploy's unit after the sha and the time, so a redeploy of the same sha gets a fresh unit", () => {
    const first = deployUnitName(SHA, AT);
    const again = deployUnitName(SHA, new Date(AT.getTime() + 1000));

    expect(first).toMatch(/^titan-factory-deploy-bbbbbbbb-[0-9a-z]+$/);
    expect(again).not.toBe(first);
  });

  it("starts nothing more when systemd-run exits cleanly", () => {
    const fake = fakePorts();
    deployerOn("linux", fake.ports).spawn(SHA);

    fake.emit(0, "exit", 0);

    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    ["is missing", "error", new Error("spawn systemd-run ENOENT"), "spawn systemd-run ENOENT"],
    ["refuses the unit", "exit", 1, "exit 1"],
  ])("falls back to a setsid deployer and logs why when systemd-run %s", (_case, event, value, why) => {
    const fake = fakePorts();
    deployerOn("linux", fake.ports).spawn(SHA);

    fake.emit(0, event, value);
    fake.emit(0, "exit", 1);

    expect(fake.calls.slice(1)).toEqual([setsidCall]);
    expect(fake.lines.slice(1)).toEqual([`${SYSTEMD_RUN} did not start the deployer (${why}); starting it in its own session instead\n`]);
  });

  it("falls back to a setsid deployer when spawning systemd-run throws", () => {
    const fake = fakePorts(undefined, SYSTEMD_RUN);

    const started = deployerOn("linux", fake.ports).spawn(SHA);

    expect(started).toEqual({ pid: 777, log: LOG });
    expect(fake.calls).toEqual([setsidCall]);
    expect(fake.lines.slice(1)).toEqual([`${SYSTEMD_RUN} did not start the deployer (Error); starting it in its own session instead\n`]);
  });

  it("logs that the deployer did not start when the fallback cannot spawn either", () => {
    const fake = fakePorts();
    deployerOn("linux", fake.ports).spawn(SHA);
    fake.ports.spawn = () => {
      throw new Error("EAGAIN");
    };

    fake.emit(0, "exit", 1);

    expect(fake.lines.at(-1)).toBe("deployer did not start: Error\n");
  });
});
