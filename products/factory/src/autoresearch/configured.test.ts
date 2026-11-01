import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArPorts } from "@titan-design/autoresearch";
import { inProcessCaller } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { seedRepoWithOrigin, withHistory } from "@titan-design/test-kit/git";
import type { WorkflowEvent, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
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

  it("binds a host and hears an event through both the routes' own hooks and autoresearch's", () => {
    const own = { bound: vi.fn(() => () => undefined), heard: vi.fn() };
    const base = Object.assign([], { bindHost: own.bound, onEvent: own.heard });
    const routes = withAutoresearch(base, arConfigFixture("/tmp/ar-fixture", { fixture: { clone: "/tmp/ar-fixture/a" } }));
    const event: WorkflowEvent = { type: "step_complete", runId: "run-1", stepId: "post-merge", iteration: 0, signal: null };

    const host = openFactoryHost({ dbPath: ":memory:", workflows: [], routes });
    hosts.push(host);
    routes.onEvent?.(event);

    expect(own.bound).toHaveBeenCalledWith(host);
    expect(own.heard).toHaveBeenCalledWith(event);
    expect(routes.workflows?.length).toBeGreaterThan(0);
  });
});
