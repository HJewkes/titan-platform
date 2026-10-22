import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArPorts } from "@titan-design/autoresearch";
import { inProcessCaller } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { createFactoryRegistry, factoryContext } from "../registry.js";
import { arConfigFixture } from "../test-support/autoresearch.js";
import { portsForRun, targetPorts, withAutoresearch } from "./configured.js";
import { execGit } from "./ratchet.js";

const IDENTITY = ["-c", "user.name=autoresearch fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);

const roots: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
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
  const [seed, bare, clone] = [join(root, "seed"), join(root, "origin.git"), join(root, "clone")];
  mkdirSync(join(seed, "ar"), { recursive: true });
  await git(seed, "init", "--quiet", "-b", "main");
  writeFileSync(join(seed, "ar/target.json"), JSON.stringify(TARGET));
  writeFileSync(join(seed, "ar/bounds.json"), JSON.stringify({ schema: "ar-bounds/v1", classes: {} }));
  await git(seed, "add", "--all");
  await git(seed, "commit", "--quiet", "-m", "fixture");
  await git(seed, "checkout", "--quiet", "-b", "side");
  writeFileSync(join(seed, "side.txt"), "side\n");
  await git(seed, "add", "--all");
  await git(seed, "commit", "--quiet", "-m", "side");
  const side = await git(seed, "rev-parse", "HEAD");
  await git(seed, "checkout", "--quiet", "main");
  await git(root, "clone", "--quiet", "--bare", seed, bare);
  await git(root, "clone", "--quiet", bare, clone);
  return { root, clone, side };
}

describe("portsForRun", () => {
  it("builds each run's ports from its own target, once per target", () => {
    const config = arConfigFixture("/tmp/ar-fixture", { fixture: { clone: "/tmp/ar-fixture/a" }, other: { clone: "/tmp/ar-fixture/b" } });
    const runs: Record<string, Partial<WorkflowRun>> = { "run-a": { params: { target: "other" } }, "run-b": { params: { target: "fixture" } }, "run-c": { params: { target: "other" } } };
    const build = vi.fn((_config: unknown, name: string) => partialFake<ArPorts>({ now: () => name.length }));
    const portsFor = portsForRun(config, (runId) => runs[runId] as WorkflowRun | undefined, build);

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

describe("a configured factory", () => {
  it("fails a run pinned off main at its pin step, through the configured ports", async () => {
    const { root, clone, side } = await originWithSideBranch();
    const routes = withAutoresearch(Object.assign([], {}) as FactoryRoutes, arConfigFixture(root, { fixture: { clone } }));
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [], routes, gatePollMs: 5 });
    hosts.push(host);
    const call = inProcessCaller(createFactoryRegistry(), () => factoryContext(host, routes));

    const started = await call("autoresearch.start", { target: "fixture", pin: side });
    const run = await host.runtime.wait(started.ok ? (started.data as { runId: string }).runId : "");

    expect(run.status).toBe("failed");
    expect(run.error).toContain(`[pin-not-on-main] ${side}`);
    expect(Object.values(run.stepResults).map((result) => result.stepId)).not.toContain("ar-pin");
  });
});
