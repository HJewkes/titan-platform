import { partialFake } from "@titan-design/test-kit";
import type { WorkflowEvent } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeRoutes } from "./compose-routes.js";
import type { FactoryHost } from "./host.js";

const EVENT: WorkflowEvent = { type: "step_complete", runId: "run-1", stepId: "post-merge", iteration: 0, signal: null };
const HOST = partialFake<FactoryHost>({});

afterEach(() => vi.restoreAllMocks());

describe("composeRoutes", () => {
  it("binds both bundles in order and unbinds both", () => {
    const calls: string[] = [];
    const bundle = (name: string) => ({ bindHost: () => (calls.push(`bind ${name}`), () => void calls.push(`unbind ${name}`)) });

    const unbind = composeRoutes(bundle("a"), bundle("b")).bindHost!(HOST);
    unbind();

    expect(calls).toEqual(["bind a", "bind b", "unbind a", "unbind b"]);
  });

  it("delivers an event to the second listener when the first throws, and logs the failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const heard = vi.fn();

    composeRoutes({ onEvent: () => { throw new Error("boom"); } }, { onEvent: heard }).onEvent!(EVENT);

    expect(heard).toHaveBeenCalledWith(EVENT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("binds the second bundle when the first bind throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bound = vi.fn(() => () => undefined);

    composeRoutes({ bindHost: () => { throw new Error("no"); } }, { bindHost: bound }).bindHost!(HOST)();

    expect(bound).toHaveBeenCalledOnce();
  });

  it("keeps a hook only one bundle has, and adds none when neither has it", () => {
    const onEvent = vi.fn();

    expect(composeRoutes({}, {})).toEqual({});
    composeRoutes({}, { onEvent }).onEvent!(EVENT);

    expect(onEvent).toHaveBeenCalledOnce();
  });
});
