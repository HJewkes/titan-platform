import { describe, expect, it } from "vitest";
import { arStepHandlers } from "./handlers.js";
import type { ArDispatchStep } from "./manifest.js";
import type { ArPorts } from "./ports.js";

const signal = new AbortController().signal;
const unused = () => Promise.reject(new Error("not reached"));

function portsWith(overrides: Partial<ArPorts>): ArPorts {
  const base = { pin: unused, plan: unused, allocTree: unused, implement: unused, staticCheck: unused, micro: unused, evalCase: unused, ratchet: unused, releaseTree: unused };
  return { ...base, now: () => 0, ...overrides };
}

const handlerFor = (ports: ArPorts, name: ArDispatchStep) => arStepHandlers(ports).find((handler) => handler.name === name)!;

describe("step handlers", () => {
  it("hand the load gate the step's first start time, which is not in the step's input", async () => {
    const seen: unknown[] = [];
    const ports = portsWith({ loadWait: async (input) => (seen.push(input), { waitedMs: 0 }) });

    await handlerFor(ports, "load-wait").run({ stage: "implement" }, signal, { firstStartedAt: "2026-01-01T00:00:00.000Z" });

    expect(seen).toEqual([{ stage: "implement", firstStartedAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("answer the plan step with the planner's agent and usage beside its ops", async () => {
    const planned = { ops: { add: [] }, agent: "planner-a", sessionId: "s-a", mode: "resume" as const, usage: { usd: 1, retries: 0 } };
    const ports = portsWith({ plan: async () => planned });

    const result = await handlerFor(ports, "plan").run({ runId: "run-a", round: 2, digest: {}, violations: [], mode: "resume" }, signal);

    expect(result).toEqual(planned);
  });

  it("answer the inbox step with no ideas and the cursor unmoved on a host with no inbox", async () => {
    const result = await handlerFor(portsWith({}), "inbox").run({ runId: "run-a", round: 3, after: 4 }, signal);

    expect(result).toEqual({ ideas: [], cursor: 4 });
  });

  it("answer a snapshot port that throws with a recorded failure, and hand it the step's first start", async () => {
    const seen: unknown[] = [];
    const ports = portsWith({ snapshot: async (input) => (seen.push(input.at), Promise.reject(new Error("[snapshot-fixture] refused"))) });
    const log = { phase: "p1", trigger: "kept", round: 1, from: "a", to: "b", kept: [], spentSince: { agentUsd: 0, modelUsd: 0 } };
    const input = { runId: "run-a", pin: "p", k: 1, trigger: "kept", round: 1, sha: "b", ratchetRef: "r", ratchetPrefix: "autoresearch/fixture", log };

    const result = await handlerFor(ports, "snapshot").run(input, signal, { firstStartedAt: "2026-01-01T00:00:00.000Z" });

    expect(result).toEqual({ failed: "[snapshot-fixture] refused" });
    expect(seen).toEqual(["2026-01-01T00:00:00.000Z"]);
  });

  it("answer a sync port that throws with a recorded failure, but rethrow a moved ratchet for a person", async () => {
    const input = { runId: "run-a", pin: "p", round: 2, pr: 101, branch: "b", head: "h", ratchetRef: "r", ratchetPrefix: "autoresearch/fixture", tree: "t" };
    const failing = (message: string) => handlerFor(portsWith({ sync: () => Promise.reject(new Error(message)) }), "sync").run(input, signal);

    expect(await failing("[pin-fetch] origin unreachable")).toEqual({ failed: "[pin-fetch] origin unreachable" });
    await expect(failing("[ratchet-moved] r is at x, not h")).rejects.toThrow("[ratchet-moved]");
    expect(await handlerFor(portsWith({}), "sync").run(input, signal)).toEqual({ failed: "[no-sync] this host has no sync port" });
  });

  it("rethrow a failed sync once the run is cancelled", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const ports = portsWith({ sync: () => Promise.reject(new Error("aborted")) });
    const input = { runId: "run-a", pin: "p", round: 2, pr: 101, branch: "b", head: "h", ratchetRef: "r", ratchetPrefix: "autoresearch/fixture", tree: "t" };

    await expect(handlerFor(ports, "sync").run(input, aborted.signal)).rejects.toThrow("aborted");
  });

  it("repeat a snapshot after a restart, and park a sync, which may already have moved the ratchet", () => {
    const rules = Object.fromEntries(arStepHandlers(portsWith({})).map((handler) => [handler.name, handler.onRestart]));

    expect([rules.snapshot, rules.sync, rules.ratchet]).toEqual(["repeat", "park", "park"]);
  });

  it("refuse a look on a host with no validator rather than answer an empty aggregate", async () => {
    const look = handlerFor(portsWith({}), "validate").run({ runId: "run-a", pin: "p", look: 1, head: "h" }, signal);

    await expect(look).rejects.toThrow("[no-validator]");
  });
});
