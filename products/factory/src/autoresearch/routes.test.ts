import { arStepId, type ArDispatchStep, type ArPorts } from "@titan-design/autoresearch";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { arRoutes } from "./routes.js";
import { autoresearchWorkflow } from "./workflow.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function portsFailingAtPin(): ArPorts {
  const unused = () => Promise.reject(new Error("not reached"));
  return {
    pin: () => Promise.reject(new Error("target.json missing at the pin")),
    plan: unused,
    allocTree: unused,
    implement: unused,
    staticCheck: unused,
    micro: unused,
    evalCase: unused,
    ratchet: unused,
    releaseTree: unused,
    now: () => Date.parse("2026-10-21T00:00:00Z"),
  };
}

const RUN = { schema: "ar-result/v2", case: "t-alpha", repeat: "k1", metrics: { score: 1 }, gates: {}, violations: {}, usd: 0.4, wall_s: 1 } as const;

function answeringPorts(): ArPorts {
  return {
    ...portsFailingAtPin(),
    evalCase: async () => RUN,
    ratchet: async ({ to }) => ({ head: to }),
    implement: async ({ base }) => ({ head: base, usd: 2, agent: "implementer-1", mode: "spawn", usage: { usd: 2.5, cacheReadTokens: 900, retries: 0 } }),
  };
}

const IDEA = {
  id: "i-1", lineage: "l-1", cell: "c", round: 1, hypothesis: "h", mechanism: "m", class: "accept-gate", direction: "d",
  targets: [], expectedEffect: { metric: "score", direction: "down", microSignal: "accepts" }, testPlan: "t", bold: false,
};

const MOVE = {
  runId: "run-1", tree: "/trees/integration", ratchetRef: "refs/heads/autoresearch/fixture/run-1", ratchetPrefix: "autoresearch/fixture", from: "aaa", to: "bbb",
  round: 2, ideaId: "i-1", kind: "ff", keepRung: "L3", delta: 1.5, sigma: 0.25, runDigests: ["d1", "d2"], pin: "ppp",
};

/** One route call as the runtime makes it after a restart: the first attempt's start time survives. */
async function routeOutcome(name: ArDispatchStep, input: object, ports: ArPorts = answeringPorts()) {
  const route = arRoutes(() => ports).find((candidate) => candidate.match === arStepId(name))!;
  const stepId = `${arStepId(name)}:x`;
  const timing = { attempt: 1, requestKey: `run-1/${stepId}`, firstStartedAt: "2026-10-20T08:00:00.000Z", restarts: 1 };
  return route.runner.run({ runId: "run-1", workflowName: "autoresearch", stepId, iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, ...timing });
}

async function callRoute(name: ArDispatchStep, input: object, ports?: ArPorts) {
  const outcome = await routeOutcome(name, input, ports);
  if (!outcome.ok) throw new Error(outcome.error);
  const body: unknown = JSON.parse(outcome.output);
  return { outcome, body };
}

const RUN_PIN = { runId: "run-1", pin: "ppp" };

describe("autoresearch routes", () => {
  it("records the step's first start time and restart count, not the time of this attempt", async () => {
    const { body } = await callRoute("eval", { ...RUN_PIN, tree: "/trees/a", case: "t-alpha", key: "k1", rung: "seed" });

    expect(body).toMatchObject({ startedAt: "2026-10-20T08:00:00.000Z", restarts: 1, result: { repeat: "k1" } });
  });

  it("passes a dispatch's usage, cache reads included, and an eval's model dollars to the runtime", async () => {
    const implemented = await callRoute("implement", { runId: "run-1", idea: IDEA, tree: "/trees/a", base: "aaa", brief: "b", round: 1, lane: 1, fork: "explore" });
    const evaluated = await callRoute("eval", { ...RUN_PIN, tree: "/trees/a", case: "t-alpha", key: "k1", rung: "seed" });

    expect(implemented.outcome.usage).toEqual({ costUsd: 2.5, cacheReadTokens: 900 });
    expect(evaluated.outcome.usage).toEqual({ costUsd: 0.4 });
  });

  it("records the ratchet move with its pin, Δ and σ beside the head it reached", async () => {
    const { body } = await callRoute("ratchet", MOVE);

    expect(body).toMatchObject({ result: { head: "bbb" }, move: { run: "run-1", round: 2, idea: "i-1", from: "aaa", to: "bbb", delta: 1.5, sigma: 0.25, pin: "ppp", runDigests: ["d1", "d2"] } });
  });

  it("records a sync that moved the ratchet as one ratchet move of kind sync, with the frozen paths it allowed", async () => {
    const answer = { state: "merged" as const, merged: { from: "aaa", to: "ccc", main: "mmm" }, treeChanged: true, allowedFrozen: ["eval/score.sh"] };
    const ports: ArPorts = { ...answeringPorts(), sync: async () => answer };
    const sync = { ...RUN_PIN, round: 3, pr: 7, branch: "autoresearch/fixture-snap/run-1/m1", head: "aaa", ratchetRef: MOVE.ratchetRef, ratchetPrefix: MOVE.ratchetPrefix, tree: MOVE.tree, resolved: "ccc", allowedFrozen: ["eval/score.sh"] };

    const { body } = await callRoute("sync", sync, ports);

    expect(body).toMatchObject({ kind: "autoresearch.ratchet", result: { state: "merged" }, move: { run: "run-1", round: 3, from: "aaa", to: "ccc", kind: "sync", pr: 7, resolved: "ccc", allowedFrozen: ["eval/score.sh"] } });
  });

  it("records a sync that moved nothing as a sync, with no move", async () => {
    const ports: ArPorts = { ...answeringPorts(), sync: async () => ({ state: "open" }) };
    const sync = { ...RUN_PIN, round: 3, pr: 7, branch: "autoresearch/fixture-snap/run-1/m1", head: "aaa", ratchetRef: MOVE.ratchetRef, ratchetPrefix: MOVE.ratchetPrefix, tree: MOVE.tree };

    const { body } = await callRoute("sync", sync, ports);

    expect(body).toMatchObject({ kind: "autoresearch.sync", result: { state: "open" } });
    expect(body).not.toHaveProperty("move");
  });

  it("hands the load gate the step's first start time, so a restart keeps its deadline", async () => {
    const seen: unknown[] = [];
    const ports = { ...answeringPorts(), loadWait: async (input: unknown) => (seen.push(input), { waitedMs: 0 }) };

    await callRoute("load-wait", { stage: "implement" }, ports);

    expect(seen).toEqual([{ stage: "implement", firstStartedAt: "2026-10-20T08:00:00.000Z" }]);
  });

  it("marks a live tree retryable and a frozen-file drift or a missing pin not", async () => {
    const failing = (message: string): ArPorts => ({ ...answeringPorts(), releaseTree: () => Promise.reject(new Error(message)) });
    const retryable = async (message: string) => {
      const outcome = await routeOutcome("release", { tree: "/trees/a" }, failing(message));
      return outcome.ok ? undefined : outcome.retryable;
    };

    expect(await retryable("[tree-live] /trees/a is the cwd of live agent ar-x")).toBe(true);
    expect(await retryable("[pin-fetch] git fetch origin failed in /trees/clone: could not resolve host")).toBe(true);
    expect(await retryable("[pin-not-on-main] ppp is not on origin/main")).toBe(false);
    expect(await retryable("[frozen-drift] frozen files in /trees/e no longer match the pin")).toBe(false);
    expect(await retryable("[no-pin] run run-1 has no evaluator checkout")).toBe(false);
    expect(await retryable("[release] [tree-live] quoted inside another code")).toBe(false);
  });
});

describe("autoresearch routes per run", () => {
  it("calls the ports of the step's own run", async () => {
    const seen: string[] = [];
    const portsOf = (runId: string): ArPorts => ({ ...answeringPorts(), evalCase: async () => (seen.push(runId), RUN) });
    const route = arRoutes(portsOf).find((candidate) => candidate.match === arStepId("eval"))!;
    const input = (runId: string) => ({ runId, workflowName: "autoresearch", stepId: "ar-eval:x", iteration: 0, prompt: JSON.stringify({ ...RUN_PIN, runId, tree: "/trees/a", case: "t-alpha", key: "k1", rung: "seed" }), signal: new AbortController().signal, attempt: 1, requestKey: `${runId}/ar-eval:x` });

    await route.runner.run(input("run-a"));
    await route.runner.run(input("run-b"));

    expect(seen).toEqual(["run-a", "run-b"]);
  });
});

describe("autoresearch on the factory host", () => {
  it("routes every dispatch step of the package's workflow and fails the run on a port error", async () => {
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [autoresearchWorkflow()], routes: arRoutes(portsFailingAtPin), gatePollMs: 5 });
    hosts.push(host);

    const run = await host.runtime.wait(host.runtime.start("autoresearch", { pin: "abc123" }));

    expect(run.status).toBe("failed");
    expect(run.error).toContain("target.json missing at the pin");
  });
});
