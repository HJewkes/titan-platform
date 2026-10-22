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
});
