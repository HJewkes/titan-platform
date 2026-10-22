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
  tree: "/trees/integration", ratchetRef: "refs/heads/autoresearch/fixture/run-1", ratchetPrefix: "autoresearch/fixture", from: "aaa", to: "bbb",
  round: 2, ideaId: "i-1", kind: "ff", keepRung: "L3", delta: 1.5, sigma: 0.25, runDigests: ["d1", "d2"], pin: "ppp",
};

/** One route call as the runtime makes it after a restart: the first attempt's start time survives. */
async function callRoute(name: ArDispatchStep, input: object) {
  const route = arRoutes(answeringPorts()).find((candidate) => candidate.match === arStepId(name))!;
  const stepId = `${arStepId(name)}:x`;
  const timing = { attempt: 1, requestKey: `run-1/${stepId}`, firstStartedAt: "2026-10-20T08:00:00.000Z", restarts: 1 };
  const outcome = await route.runner.run({ runId: "run-1", workflowName: "autoresearch", stepId, iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, ...timing });
  if (!outcome.ok) throw new Error(outcome.error);
  return { outcome, body: JSON.parse(outcome.output) as Record<string, unknown> };
}

describe("autoresearch routes", () => {
  it("records the step's first start time and restart count, not the time of this attempt", async () => {
    const { body } = await callRoute("eval", { tree: "/trees/a", case: "t-alpha", key: "k1", rung: "seed" });

    expect(body).toMatchObject({ startedAt: "2026-10-20T08:00:00.000Z", restarts: 1, result: { repeat: "k1" } });
  });

  it("passes a dispatch's usage, cache reads included, and an eval's model dollars to the runtime", async () => {
    const implemented = await callRoute("implement", { idea: IDEA, tree: "/trees/a", base: "aaa", brief: "b", round: 1, lane: 1, fork: "explore" });
    const evaluated = await callRoute("eval", { tree: "/trees/a", case: "t-alpha", key: "k1", rung: "seed" });

    expect(implemented.outcome.usage).toEqual({ costUsd: 2.5, cacheReadTokens: 900 });
    expect(evaluated.outcome.usage).toEqual({ costUsd: 0.4 });
  });

  it("records the ratchet move with its pin, Δ and σ beside the head it reached", async () => {
    const { body } = await callRoute("ratchet", MOVE);

    expect(body).toMatchObject({ result: { head: "bbb" }, move: { run: "run-1", round: 2, idea: "i-1", from: "aaa", to: "bbb", delta: 1.5, sigma: 0.25, pin: "ppp", runDigests: ["d1", "d2"] } });
  });
});

describe("autoresearch on the factory host", () => {
  it("routes every dispatch step of the package's workflow and fails the run on a port error", async () => {
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [autoresearchWorkflow()], routes: arRoutes(portsFailingAtPin()), gatePollMs: 5 });
    hosts.push(host);

    const run = await host.runtime.wait(host.runtime.start("autoresearch", { pin: "abc123" }));

    expect(run.status).toBe("failed");
    expect(run.error).toContain("target.json missing at the pin");
  });
});
