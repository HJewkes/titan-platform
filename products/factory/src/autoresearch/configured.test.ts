import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArPorts } from "@titan-design/autoresearch";
import { fakeGitHub, githubPort, type GitHubPort } from "@titan-design/github";
import { inProcessCaller } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { seedRepoWithOrigin, withHistory } from "@titan-design/test-kit/git";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { createFactoryRegistry, factoryContext } from "../registry.js";
import { SHEPHERD_COMMAND_MAP } from "../shepherd/commands.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { arConfigFixture } from "../test-support/autoresearch.js";
import { portsForRun, snapshotHost, targetPorts, withAutoresearch } from "./configured.js";
import { execGit } from "./ratchet.js";

const IDENTITY = ["-c", "user.name=autoresearch fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);

const roots: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  hosts.splice(0).forEach((host) => host.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const TARGET = {
  schema: "ar-target/v1",
  ratchetPrefix: "autoresearch/fixture",
  metric: { primary: { name: "score", direction: "min" }, noise: {} },
  rungs: { seed: { cmd: ["sh", "-c", "exit 3"] } },
  phases: [{ id: "p1", train: ["train-1"], baselineRuns: 2, stop: { ideasEvaluated: 1, roundsWithoutGain: 1 } }],
};

/** A bare origin whose main holds the adapter, a side branch main never merged, and the clone a target points at. */
async function originWithSideBranch() {
  const root = mkdtempSync(join(tmpdir(), "ar-configured-"));
  roots.push(root);
  const [bare, clone] = [join(root, "origin.git"), join(root, "clone")];
  seedRepoWithOrigin(clone, bare, { "ar/target.json": JSON.stringify(TARGET), "ar/bounds.json": JSON.stringify({ schema: "ar-bounds/v1", classes: {} }) });
  const [side] = withHistory(clone, [{ branch: "side", from: "main", files: { "side.txt": "side\n" }, message: "side" }]);
  await git(clone, "push", "--quiet", "origin", "side");
  await git(clone, "checkout", "--quiet", "main");
  return { root, clone, side: side! };
}

describe("portsForRun", () => {
  it("builds each run's ports from its own target, once per target", () => {
    const config = arConfigFixture("/tmp/ar-fixture", { fixture: { clone: "/tmp/ar-fixture/a" }, other: { clone: "/tmp/ar-fixture/b" } });
    const targets: Record<string, string> = { "run-a": "other", "run-b": "fixture", "run-c": "other" };
    const build = vi.fn((_config: unknown, name: string) => partialFake<ArPorts>({ now: () => name.length }));
    const portsFor = portsForRun(config, (runId) => partialFake<WorkflowRun>({ params: { target: targets[runId]! } }), build);

    const [a, b, c] = [portsFor("run-a"), portsFor("run-b"), portsFor("run-c")];

    expect(build.mock.calls.map(([, name]) => name)).toEqual(["other", "fixture"]);
    expect(a).toBe(c);
    expect(a).not.toBe(b);
  });

  it("refuses a run with no target, and a target the config does not name", () => {
    const config = arConfigFixture("/tmp/ar-fixture");
    const portsFor = portsForRun(config, () => partialFake<WorkflowRun>({ params: {} }));

    expect(() => portsFor("run-a")).toThrow("[no-target] run run-a names no autoresearch target");
    expect(() => targetPorts(config, "missing")).toThrow("[no-target] missing");
  });
});

const signal = new AbortController().signal;
const SNAPSHOT = { repo: "fixture-owner/fixture-repo", task: "fixture/FX-1", implementer: "fixture-seat", logDir: "ar-log" };
const SNAP_BRANCH = "autoresearch/fixture-snap/run-1/m1";
const RATCHET = "refs/heads/autoresearch/fixture/run-1";
const LOG = { phase: "p1", trigger: "kept" as const, round: 1, from: "", to: "", kept: [{ ideaId: "i-a1", delta: 3, sigma: 1 }], spentSince: { agentUsd: 1.2, modelUsd: 0 } };

/** Shepherd's in-process register, answered without a store; the spy shows what the map's own command was handed. */
function spiedRegister() {
  const command = SHEPHERD_COMMAND_MAP["shepherd.register"];
  return vi.spyOn(command, "run").mockResolvedValue(partialFake<Awaited<ReturnType<typeof command.run>>>({ runId: "sh-fixture-1", created: true }));
}

/** A pinned snapshot target whose ratchet holds one kept idea, over a fake GitHub that knows the snapshot branch. */
async function keptRun(openPr?: (open: GitHubPort["openPr"]) => GitHubPort["openPr"]) {
  const { root, clone } = await originWithSideBranch();
  const fake = fakeGitHub({ repo: SNAPSHOT.repo });
  const real = githubPort(fake.wire);
  const services = partialFake<ShepherdServices>({ port: { ...real, openPr: openPr ? openPr(real.openPr) : real.openPr } });
  const config = arConfigFixture(root, { fixture: { clone, snapshot: SNAPSHOT } });
  const ports = targetPorts(config, "fixture", snapshotHost(services, () => partialFake<FactoryHost>({})));
  const pinned = await ports.pin({ runId: "run-1", pin: "main" }, signal);
  const tree = pinned.integrationTree;
  writeFileSync(join(tree, "kept.txt"), "kept idea\n");
  await git(tree, "add", "--all");
  await git(tree, "commit", "--quiet", "-m", "kept idea");
  const kept = await git(tree, "rev-parse", "HEAD");
  const run = { runId: "run-1", pin: pinned.pin, frozenHash: pinned.frozenHash };
  const move = { tree, ratchetRef: RATCHET, ratchetPrefix: "autoresearch/fixture", from: pinned.pin, to: kept, round: 1, ideaId: "i-a1", kind: "ff" as const, keepRung: "L3", delta: 3, sigma: 1, runDigests: [], pin: pinned.pin };
  await ports.ratchet({ ...run, ...move }, signal);
  fake.refs.set(SNAP_BRANCH, kept);
  const cut = { ...run, k: 1, trigger: "kept" as const, round: 1, sha: kept, ratchetRef: RATCHET, ratchetPrefix: "autoresearch/fixture", log: { ...LOG, from: pinned.pin, to: kept }, at: "2026-10-21T00:00:00Z" };
  return { ports, fake, port: real, kept, cut };
}

describe("a snapshot target", () => {
  it("refuses at wiring when the host has no Shepherd services", () => {
    const config = arConfigFixture("/tmp/ar-fixture", { fixture: { clone: "/tmp/ar-fixture/a", snapshot: SNAPSHOT } });

    expect(() => withAutoresearch([], config)).toThrow("[no-shepherd] targets fixture configure snapshots");
    expect(() => targetPorts(config, "fixture")).toThrow("[no-shepherd] target fixture");
  });

  it("omits the snapshot and sync ports for a target with no snapshot block", () => {
    const ports = targetPorts(arConfigFixture("/tmp/ar-fixture", { fixture: { clone: "/tmp/ar-fixture/a" } }), "fixture");

    expect(ports.snapshot).toBeUndefined();
    expect(ports.sync).toBeUndefined();
  });

  it("cuts a kept idea end to end: the -snap branch heads the PR and Shepherd registers it as p1-m1 under the configured task", async () => {
    const register = spiedRegister();
    const { ports, fake, port, kept, cut } = await keptRun();

    const result = await ports.snapshot!(cut, signal);

    expect(result).toMatchObject({ k: 1, sha: kept, tag: "refs/tags/ar/fixture/run-1/m1", branch: `refs/heads/${SNAP_BRANCH}`, shepherdRunId: "sh-fixture-1" });
    expect(await port.getPr(SNAPSHOT.repo, result.pr)).toMatchObject({ headRef: SNAP_BRANCH, baseRef: "main" });
    expect(register.mock.calls[0]![0]).toEqual({ repo: SNAPSHOT.repo, pr: result.pr, task: "fixture/FX-1", implementer: "fixture-seat", slice: "p1-m1", kind: "feature" });
    expect(fake.effects.createPr).toBe(1);
  });

  it("opens the PR on a retry with a later first start after the first cut pushed and its PR failed to open", async () => {
    spiedRegister();
    let failures = 1;
    const flaky = (open: GitHubPort["openPr"]): GitHubPort["openPr"] => async (repo, request) => {
      if (failures-- > 0) throw new Error("github unavailable");
      return open(repo, request);
    };
    const { ports, fake, cut } = await keptRun(flaky);
    await expect(ports.snapshot!(cut, signal)).rejects.toThrow("github unavailable");

    const retried = await ports.snapshot!({ ...cut, at: "2026-10-21T02:00:00Z" }, signal);

    expect(retried).toMatchObject({ k: 1, shepherdRunId: "sh-fixture-1" });
    expect(fake.effects.createPr).toBe(1);
  });
});

describe("a configured factory", () => {
  it("fails a run pinned off main at its pin step, through the configured ports", async () => {
    const { root, clone, side } = await originWithSideBranch();
    const routes = withAutoresearch([], arConfigFixture(root, { fixture: { clone } }));
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [], routes, gatePollMs: 5 });
    hosts.push(host);
    const call = inProcessCaller(createFactoryRegistry(), () => factoryContext(host, routes));

    const started = await call("autoresearch.start", { target: "fixture", pin: side });
    const run = await host.runtime.wait(z.object({ runId: z.string() }).parse(started.ok && started.data).runId);

    expect(run.status).toBe("failed");
    expect(run.error).toContain(`[pin-not-on-main] ${side}`);
    expect(Object.values(run.stepResults).map((result) => result.stepId)).not.toContain("ar-pin");
  });
});
