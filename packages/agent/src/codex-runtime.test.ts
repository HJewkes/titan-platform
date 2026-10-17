import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CODEX_EXECUTABLE, createCodexExecAdapter } from "./codex-exec.js";
import type { CodexRunRequest } from "./harness-contracts.js";
import type { CodexRuntimeCapability } from "./codex-runtime.js";

const request = (): CodexRunRequest => ({
  harness: "codex", prompt: "report", cwd: "/tmp/work", wallTimeMs: 500,
  target: { kind: "fresh", namespace: "fixture" },
  native: { model: "fixture-model", sandbox: "read-only", approvalPolicy: "never" },
});

function report() {
  return {
    capabilities: {
      json_events: true, config_overrides: true, user_config_isolation: true,
      strict_config: true, output_schema: true, model_selection: true, working_directory: true,
      mcp_config: false, tool_policy: false, rollout_rate_limits: false,
    },
    sandboxes: ["read-only", "workspace-write"],
  };
}

async function* events() {
  yield JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" });
  yield JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } });
  yield JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}

function runner(version = "0.162.1", inspection = report(), requiredRuntimeCapabilities: CodexRuntimeCapability[] = []) {
  const inspectCapabilities = vi.fn(async () => inspection);
  const start = vi.fn(() => ({
    stdout: events(), stderr: (async function* () {})(),
    completed: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn(),
  }));
  const adapter = createCodexExecAdapter(
    { auth: "cached-cli", requiredRuntimeCapabilities },
    { inspectVersion: async () => `codex-cli ${version}`, inspectCapabilities, start },
  );
  return { adapter, inspectCapabilities, start };
}

describe("Codex runtime admission", () => {
  it("uses the installed CLI on PATH rather than a desktop application path", () => {
    expect(DEFAULT_CODEX_EXECUTABLE).toBe("codex");
  });

  it.each(["0.162.1", "0.162.2", "0.163.0", "0.999.0", "1.0.0", "0.163.0-alpha.1", "0.162.1+build.2"])(
    "admits %s when required capabilities pass without a version allow-list", async version => {
      const fixture = runner(version);
      expect(await fixture.adapter.run(request())).toMatchObject({ ok: true });
      expect(fixture.inspectCapabilities).toHaveBeenCalledOnce();
      expect(fixture.start).toHaveBeenCalledOnce();
    },
  );

  it.each(["0.154.0-alpha.6.1", "0.162.0", "0.162.1-alpha.1", "0.162.01", "future", "0.162.1garbage"])(
    "refuses below-floor or malformed %s before probing or spawning", async version => {
      const fixture = runner(version);
      expect(await fixture.adapter.run(request())).toMatchObject({ ok: false, failure: { kind: "runtime_error" } });
      expect(fixture.inspectCapabilities).not.toHaveBeenCalled();
      expect(fixture.start).not.toHaveBeenCalled();
    },
  );

  it.each(["json_events", "config_overrides", "user_config_isolation", "strict_config", "model_selection", "working_directory"] as const)(
    "refuses a newer runtime missing %s before model launch", async capability => {
      const inspection = report(); inspection.capabilities[capability] = false;
      const fixture = runner("0.163.0", inspection);
      expect(await fixture.adapter.run(request())).toMatchObject({ ok: false, failure: { reason: expect.stringContaining(capability) } });
      expect(fixture.start).not.toHaveBeenCalled();
    },
  );

  it.each(["mcp_config", "tool_policy", "rollout_rate_limits"] as const)(
    "refuses required unverified %s instead of inferring it from the version", async capability => {
      const fixture = runner("0.163.0", report(), [capability]);
      expect(await fixture.adapter.run(request())).toMatchObject({ ok: false, failure: { reason: expect.stringContaining(capability) } });
      expect(fixture.start).not.toHaveBeenCalled();
    },
  );

  it("checks the requested sandbox, not merely the presence of a sandbox flag", async () => {
    const fixture = runner("0.163.0", { ...report(), sandboxes: ["workspace-write"] });
    expect(await fixture.adapter.run(request())).toMatchObject({ ok: false, failure: { reason: expect.stringContaining("read-only") } });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("admits a newer runtime when an independent probe establishes all extra requirements", async () => {
    const inspection = report();
    inspection.capabilities.mcp_config = true;
    inspection.capabilities.tool_policy = true;
    inspection.capabilities.rollout_rate_limits = true;
    const fixture = runner("1.0.0", inspection, ["mcp_config", "tool_policy", "rollout_rate_limits"]);
    expect(await fixture.adapter.run(request())).toMatchObject({ ok: true });
  });

  it("rechecks capabilities before every invocation", async () => {
    const fixture = runner("0.163.0");
    fixture.inspectCapabilities.mockResolvedValueOnce(report()).mockResolvedValueOnce({ ...report(), sandboxes: [] });
    expect(await fixture.adapter.run(request())).toMatchObject({ ok: true });
    expect(await fixture.adapter.run(request())).toMatchObject({ ok: false });
    expect(fixture.inspectCapabilities).toHaveBeenCalledTimes(2);
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it("bounds capability inspection within the existing wall deadline", async () => {
    const fixture = runner();
    fixture.inspectCapabilities.mockImplementation(() => new Promise(() => {}));
    expect(await fixture.adapter.run({ ...request(), wallTimeMs: 10 })).toMatchObject({ ok: false, failure: { kind: "wall_time_exceeded" } });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("honors abort during capability inspection without starting the model", async () => {
    const fixture = runner();
    fixture.inspectCapabilities.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = fixture.adapter.run({ ...request(), signal: controller.signal });
    await vi.waitFor(() => expect(fixture.inspectCapabilities).toHaveBeenCalledOnce());
    controller.abort("fixture abort");
    expect(await result).toMatchObject({ ok: false, failure: { kind: "aborted" } });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("requires output-schema input only when structured output is requested", async () => {
    const inspection = report(); inspection.capabilities.output_schema = false;
    const fixture = runner("0.163.0", inspection);
    expect(await fixture.adapter.run(request())).toMatchObject({ ok: true });
    const structured = { ...request(), native: { ...request().native,
      outputSchema: { jsonSchema: { type: "object" }, parse: (value: unknown) => value } } };
    expect(await fixture.adapter.run(structured)).toMatchObject({ ok: false, failure: { reason: expect.stringContaining("output_schema") } });
    expect(fixture.start).toHaveBeenCalledOnce();
  });
});
