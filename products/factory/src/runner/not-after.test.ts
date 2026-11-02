import { describe, expect, it } from "vitest";
import { partialFake } from "@titan-design/test-kit";
import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import { defineWorkflow, type RegisteredSteps, type StepDeclaration } from "../definition.js";
import { openFactoryHost } from "../host.js";
import type { EntryLog } from "../markers/orphan-trap.js";
import { notAfterShadow, type ShadowDeps, type ShadowEvent } from "../markers/shadow.js";
import { runnerContext, unlessPast } from "./not-after.js";

const steps: StepDeclaration[] = [
  { id: "prepare", kind: "seed" },
  { id: "settle", kind: "seed", notAfter: "landed" },
  { id: "plain", kind: "seed" },
];
const definition = defineWorkflow({ name: "c28-unit", steps, run: async () => undefined });
const registry: RegisteredSteps = { entries: [{ name: "prepare", op: "seed" }, { name: "settle", op: "seed", fact: "landed" }, { name: "plain", op: "seed" }] };

/** A record whose next step after the last answered call is `next`; seeds resolve on the next macrotask. */
function recordedContext(next: string | undefined): WorkflowContext {
  const result = partialFake<StepResult>({ stepId: "plain", data: {} });
  const unused = (): never => {
    throw new Error("not used");
  };
  return {
    runId: "run-1",
    workflowName: definition.name,
    signal: new AbortController().signal,
    param: () => undefined,
    capability: unused,
    iteration: () => 0,
    historyNext: () => next,
    resumedGate: () => undefined,
    recoveredInFlight: () => [],
    expireGates: () => [],
    dispatch: unused,
    seed: () => new Promise((resolve) => setImmediate(() => resolve(result))),
    assisted: unused,
    authorize: unused,
  };
}

const openWith = (declared: StepDeclaration[]) => () =>
  openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "c28-open", steps: declared, run: async () => undefined })], registry, routes: [] }).close();

describe("unlessPast", () => {
  it("unlessPast refuses a step declared without notAfter", async () => {
    const ctx = runnerContext(recordedContext("plain"), definition);

    await expect(unlessPast(ctx, "plain", async () => "ran")).rejects.toThrow(/needs a step declared with notAfter/);
  });

  it("a notAfter naming an unknown fact fails registration", () => {
    expect(openWith([{ id: "prepare", kind: "seed" }, { id: "settle", kind: "seed", notAfter: "no-such-fact" }])).toThrow(/a fact no registered step meets/);
    expect(openWith(steps)).not.toThrow();
  });

  it("a notAfter on the first declaration fails registration", () => {
    expect(openWith([{ id: "settle", kind: "seed", notAfter: "landed" }])).toThrow(/first step "settle" may not declare notAfter/);
  });

  it("unlessPast inside all is refused", async () => {
    const ctx = runnerContext(recordedContext("plain"), definition);

    const children = Promise.all([unlessPast(ctx, "settle", async () => "ran"), ctx.seed("plain", async () => ({ data: {} }))]);

    await expect(children).rejects.toThrow(/inside all/);
  });

  it("a skip is a visit in the entry log and one sink line", async () => {
    const events: ShadowEvent[] = [];
    const log: EntryLog = { runId: "run-1", recorded: [], visited: new Set(), reached: 0, failClosed: false };
    const inner = recordedContext("plain");
    const shadow = notAfterShadow(inner, partialFake<ShadowDeps>({ sink: (event) => void events.push(event) }), { definition, log });
    let calls = 0;

    const outcome = await unlessPast(runnerContext(inner, definition, shadow), "settle", async () => (calls += 1));

    expect(outcome).toEqual({ skipped: true });
    expect(calls).toBe(0);
    expect([...log.visited]).toEqual(["c28-unit/settle"]);
    expect(events).toEqual([{ kind: "not-after-skip", runId: "run-1", stepId: "settle", fact: "landed", memoKey: "", notAfter: "landed" }]);
  });

  it("the step runs when the record's next call is the step itself or the run is live", async () => {
    for (const next of ["settle", undefined]) {
      const outcome = await unlessPast(runnerContext(recordedContext(next), definition), "settle", async () => "ran");
      expect(outcome).toEqual({ skipped: false, value: "ran" });
    }
  });
});
