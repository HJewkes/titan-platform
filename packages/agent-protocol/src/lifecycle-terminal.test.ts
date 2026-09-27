import { describe, expect, it } from "vitest";
import {
  EXECUTION_PHASES,
  TERMINAL_EXECUTION_PHASES,
  isTerminalExecutionPhase,
  type ExecutionTerminal,
  type SurfaceIdentity,
} from "./index.js";
import { T2, T3, T4, apply, dispatching, event, expectCode, fence, prepare, running } from "./test-fixtures.js";

const pane: SurfaceIdentity = { kind: "tmux", host: "local", nativeId: "%7", owned: true };
const ended = (terminal: Partial<Extract<ExecutionTerminal<string>, { outcome: "ended" }>> = {}) =>
  ({ outcome: "ended", evidence: "pane closed without a result", ...terminal }) as ExecutionTerminal<string>;

describe("ended terminal outcome", () => {
  it("absorbs a running execution so any later transition is refused", () => {
    const record = apply(running(), event("finish", 3, T3, { fence, terminal: ended({ exit: { code: null, signal: "SIGHUP" } }) }));

    expect(record).toMatchObject({ phase: "ended", owner: undefined, terminal: { outcome: "ended", exit: { signal: "SIGHUP" } } });
    expectCode(() => apply(record, event("require_recovery", 4, T4, { fence, evidence: "late" })), "invalid_transition");
  });

  it.each([
    ["empty evidence", ended({ evidence: " " })],
    ["a fractional exit code", ended({ exit: { code: 1.5, signal: null } })],
    ["a numeric signal", ended({ exit: { code: 1, signal: 9 as unknown as string } })],
  ])("rejects %s", (_, terminal) => {
    expectCode(() => apply(running(), event("finish", 3, T3, { fence, terminal })), "invalid_transition");
  });

  it("refuses to end an execution that was never dispatched", () => {
    expectCode(() => apply(apply(undefined, prepare()), event("finish", 1, T2, { fence, terminal: ended() })), "invalid_transition");
  });

  it("keeps the terminal phase list and the predicate in agreement", () => {
    expect(isTerminalExecutionPhase("ended")).toBe(true);
    for (const phase of EXECUTION_PHASES) {
      expect(isTerminalExecutionPhase(phase)).toBe((TERMINAL_EXECUTION_PHASES as readonly string[]).includes(phase));
    }
  });
});

describe("observe_launched", () => {
  const launched = (overrides: { surface?: SurfaceIdentity; runnerRef?: string } = {}) =>
    event("observe_launched", 2, T2, { fence, runnerRef: "ledger:execution-1", surface: pane, evidence: "pane spawned", ...overrides });

  it("records the surface and runner while the phase stays dispatching", () => {
    const record = apply(dispatching(), launched());

    expect(record).toMatchObject({ phase: "dispatching", runnerRef: "ledger:execution-1", surface: pane, revision: 3 });
  });

  it.each([
    ["another surface", { surface: { ...pane, nativeId: "%8" } }],
    ["another runnerRef", { runnerRef: "ledger:other" }],
  ])("rejects a later observe_running with %s", (_, change) => {
    const record = apply(dispatching(), launched());
    const observed = event("observe_running", 3, T3, {
      fence, runnerRef: "ledger:execution-1", adapterExecution: { executionId: "adapter-run-1" }, surface: pane, evidence: "running", ...change,
    });

    expectCode(() => apply(record, observed), "invalid_transition");
  });

  it("refuses a stale fence", () => {
    expectCode(() => apply(dispatching(), { ...launched(), fence: { ...fence, generation: 2 } }), "ownership_lost");
  });

  it.each([
    ["recovery_required", () => apply(dispatching(), event("require_recovery", 2, T2, { fence, evidence: "supervisor restarted" }))],
    ["running", running],
  ])("is refused from %s", (_, record) => {
    expectCode(() => apply(record(), { ...launched(), expectedRevision: 3, occurredAt: T3 }), "invalid_transition");
  });
});
