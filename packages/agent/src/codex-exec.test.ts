import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunRequest, HarnessRunProgress } from "./harness-contracts.js";
import {
  SUPPORTED_CODEX_EXEC_VERSION,
  buildCodexExecArgs,
  createCodexExecAdapter,
  prepareCodexEnv,
  type CodexExecDeps,
} from "./codex-exec.js";
import type { CodexProcessExit, CodexProcessInput, SupervisedCodexProcess } from "./codex-process.js";

function request<T = string>(overrides: Partial<CodexRunRequest<T>> = {}): CodexRunRequest<T> {
  return {
    harness: "codex",
    prompt: "inspect the checkout",
    cwd: "/tmp/work",
    target: { kind: "fresh", namespace: "workstation-a" },
    wallTimeMs: 30_000,
    native: { model: "caller-selected", sandbox: "read-only", approvalPolicy: "never" },
    ...overrides,
  } as CodexRunRequest<T>;
}

interface FakeProcessOptions {
  stdout?: readonly string[];
  stderr?: readonly string[];
  exit?: CodexProcessExit;
  exitOn?: "SIGTERM" | "SIGKILL";
}

function fakeProcess(options: FakeProcessOptions = {}) {
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  let resolveExit: ((exit: CodexProcessExit) => void) | undefined;
  const completed = options.exitOn
    ? new Promise<CodexProcessExit>((resolve) => {
        resolveExit = resolve;
      })
    : Promise.resolve(options.exit ?? { exitCode: 0, signal: null });
  const processHandle: SupervisedCodexProcess = {
    stdout: gatedLines(options.stdout ?? [], completed),
    stderr: gatedLines(options.stderr ?? [], completed),
    completed,
    terminate(signal) {
      signals.push(signal);
      if (signal === options.exitOn) resolveExit?.({ exitCode: null, signal });
    },
  };
  return { processHandle, signals };
}

async function* gatedLines(lines: readonly string[], completed: Promise<unknown>): AsyncIterable<string> {
  for (const line of lines) yield line;
  await completed;
}

function events(text = "done") {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2 },
    }),
  ];
}

function harness(processHandle: SupervisedCodexProcess, overrides: Partial<CodexExecDeps> = {}) {
  const inspectVersion = vi.fn(async () => `codex-cli ${SUPPORTED_CODEX_EXEC_VERSION}`);
  const start = vi.fn((_input: CodexProcessInput) => processHandle);
  const deps: CodexExecDeps = {
    inspectVersion,
    start,
    executionId: () => "execution-1",
    now: () => 100,
    ...overrides,
  };
  const adapter = createCodexExecAdapter(
    { auth: "cached-cli", env: { PATH: "/bin", CODEX_API_KEY: "secret" }, killGraceMs: 100 },
    deps,
  );
  return { adapter, inspectVersion, start };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex exec command and policy", () => {
  it("builds deterministic fresh and explicit-ID resume commands without disabling persistence", () => {
    const fresh = buildCodexExecArgs(request());
    const resume = buildCodexExecArgs(
      request({
        target: {
          kind: "resume",
          conversation: { harness: "codex", namespace: "workstation-a", nativeId: "thread-1" },
        },
      }),
      "/tmp/schema.json",
    );
    expect(fresh).toContain("--cd");
    expect(fresh).toContain('approval_policy="never"');
    expect(fresh).not.toContain("--ephemeral");
    expect(resume.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resume).toContain("thread-1");
    expect(resume).toContain("/tmp/schema.json");
    expect(resume).not.toContain("--last");
  });

  it("strips environment credentials so cached CLI auth is the only auth path", () => {
    expect(
      prepareCodexEnv({
        PATH: "/bin",
        CODEX_HOME: "/tmp/codex",
        CODEX_API_KEY: "codex-secret",
        OPENAI_API_KEY: "openai-secret",
        OPENAI_ACCESS_TOKEN: "access-secret",
      }),
    ).toEqual({ PATH: "/bin", CODEX_HOME: "/tmp/codex" });
  });

  it.each([
    { auth: "api-key" },
    { auth: "cached-cli", executablePath: " " },
    { auth: "cached-cli", executablePath: "relative/codex" },
    { auth: "cached-cli", killGraceMs: Number.NaN },
  ])("rejects malformed adapter option %#", (options) => {
    expect(() => createCodexExecAdapter(options as never)).toThrow(TypeError);
  });

  it("requires an explicit model and noninteractive approval policy before version probing", async () => {
    const fake = fakeProcess({ stdout: events() });
    const runner = harness(fake.processHandle);
    const missingModel = await runner.adapter.run(request({ native: { sandbox: "read-only" } }));
    const interactive = await runner.adapter.run(request({ native: { model: "m", approvalPolicy: "on-request" } }));
    const emptyPrompt = await runner.adapter.run(request({ prompt: " " }));
    const relativeCwd = await runner.adapter.run(request({ cwd: "relative/path" }));
    expect(missingModel).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: /model/ } });
    expect(interactive).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: /noninteractive/ } });
    expect(emptyPrompt).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: /prompt/ } });
    expect(relativeCwd).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: /absolute cwd/ } });
    expect(runner.inspectVersion).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("rejects hard dollar guarantees through the adapter preflight without spawning", async () => {
    const fake = fakeProcess({ stdout: events() });
    const runner = harness(fake.processHandle);
    const result = await runner.adapter.run(
      request({ limits: [{ unit: "usd", value: 1, scope: "execution", enforcement: "hard" }] }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "unsupported_requirement", status: "unsupported" },
    });
    expect(runner.start).not.toHaveBeenCalled();
  });
});

describe("Codex exec results", () => {
  it("normalizes thread identity, text, progress, usage, and transcript discovery hints", async () => {
    const fake = fakeProcess({ stdout: events("final answer") });
    const runner = harness(fake.processHandle);
    const progress: HarnessRunProgress[] = [];
    const result = await runner.adapter.run(request({ onProgress: (event) => progress.push(event) }));
    expect(result).toMatchObject({
      ok: true,
      execution: { executionId: "execution-1" },
      conversation: { harness: "codex", namespace: "workstation-a", nativeId: "thread-1" },
      output: { kind: "text", text: "final answer" },
      transcript: { format: "codex-rollout-jsonl", namespace: "workstation-a" },
    });
    expect(result.usage[0]).toMatchObject({
      kind: "snapshot",
      scope: "turn",
      scopeId: "execution:execution-1:turn",
      model: "caller-selected",
      tokens: { input: 10, cachedInput: 4, output: 6, reasoningOutput: 2, total: 16 },
      cost: null,
      source: "codex-exec.turn.completed.usage",
    });
    expect(progress.map((event) => event.kind)).toEqual([
      "execution_started",
      "conversation_identified",
      "assistant_output",
      "usage",
      "execution_finished",
    ]);
    expect(runner.start.mock.calls[0]?.[0].env.CODEX_API_KEY).toBeUndefined();
  });

  it("requires native turn completion before reporting success", async () => {
    const withoutTerminal = events("plausible answer").filter((line) => !line.includes('"turn.completed"'));
    const result = await harness(fakeProcess({ stdout: withoutTerminal }).processHandle).adapter.run(request());
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "runtime_error", reason: /without a turn.completed event/ },
    });
  });

  it("uses a native turn ID when Codex reports one", async () => {
    const stdout = events().map((line) =>
      line.includes('"turn.started"') ? JSON.stringify({ type: "turn.started", turn_id: "turn-7" }) : line,
    );
    const result = await harness(fakeProcess({ stdout }).processHandle).adapter.run(request());
    expect(result.usage[0]).toMatchObject({
      kind: "snapshot",
      scope: "turn",
      scopeId: "turn:codex:workstation-a:thread-1:turn-7",
    });
  });

  it("resumes only the requested native conversation", async () => {
    const fake = fakeProcess({ stdout: events() });
    const runner = harness(fake.processHandle);
    const result = await runner.adapter.run(
      request({
        target: {
          kind: "resume",
          conversation: { harness: "codex", namespace: "workstation-a", nativeId: "thread-1" },
        },
      }),
    );
    expect(result).toMatchObject({ ok: true, conversation: { nativeId: "thread-1" } });
    expect(runner.start.mock.calls[0]?.[0].args).toContain("thread-1");
  });

  it("writes a native schema, parses JSON, validates locally, and disposes the schema file", async () => {
    const fake = fakeProcess({ stdout: events('{"verdict":"ship"}') });
    const dispose = vi.fn(async () => undefined);
    const createSchemaFile = vi.fn(async () => ({ path: "/tmp/schema.json", dispose }));
    const runner = harness(fake.processHandle, { createSchemaFile });
    const parse = vi.fn((value: unknown) => value as { verdict: string });
    const result = await runner.adapter.run(
      request<{ verdict: string }>({
        native: {
          model: "caller-selected",
          outputSchema: { jsonSchema: { type: "object" }, parse },
        },
      }),
    );
    expect(result).toMatchObject({ ok: true, output: { kind: "structured", value: { verdict: "ship" } } });
    expect(createSchemaFile).toHaveBeenCalledWith({ type: "object" });
    expect(runner.start.mock.calls[0]?.[0].args).toContain("/tmp/schema.json");
    expect(parse).toHaveBeenCalledWith({ verdict: "ship" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("categorizes schema cleanup failures instead of rejecting adapter.run", async () => {
    const fake = fakeProcess({ stdout: events('{"verdict":"ship"}') });
    const progress: HarnessRunProgress[] = [];
    const runner = harness(fake.processHandle, {
      createSchemaFile: async () => ({
        path: "/tmp/schema.json",
        dispose: async () => { throw new Error("schema cleanup failed"); },
      }),
    });
    const result = await runner.adapter.run(
      request({
        onProgress: (event) => progress.push(event),
        native: {
          model: "caller-selected",
          outputSchema: { jsonSchema: {}, parse: (value: unknown) => value },
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: "schema cleanup failed" } });
    expect(progress.filter((event) => event.kind === "execution_finished")).toEqual([
      expect.objectContaining({ outcome: "failed" }),
    ]);
  });

  it.each([
    ["invalid JSON", "not-json", vi.fn((value: unknown) => value)],
    ["parser rejection", '{"verdict":3}', vi.fn(() => { throw new Error("verdict must be a string"); })],
  ])("returns output_invalid for %s", async (_case, text, parse) => {
    const fake = fakeProcess({ stdout: events(text) });
    const runner = harness(fake.processHandle, {
      createSchemaFile: async () => ({ path: "/tmp/schema.json", dispose: async () => undefined }),
    });
    const result = await runner.adapter.run(
      request({ native: { model: "caller-selected", outputSchema: { jsonSchema: {}, parse } } }),
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "output_invalid" } });
  });

  it("rejects a version mismatch before starting the run process", async () => {
    const fake = fakeProcess({ stdout: events() });
    const runner = harness(fake.processHandle, { inspectVersion: async () => "codex-cli 0.999.0" });
    const result = await runner.adapter.run(request());
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: /unsupported Codex CLI version/ } });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("rechecks the pinned executable version before every launch", async () => {
    const first = fakeProcess({ stdout: events() });
    const inspectVersion = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(`codex-cli ${SUPPORTED_CODEX_EXEC_VERSION}`)
      .mockResolvedValueOnce("codex-cli 0.999.0");
    const start = vi.fn((_input: CodexProcessInput) => first.processHandle);
    const adapter = createCodexExecAdapter(
      { auth: "cached-cli", env: { PATH: "/bin" } },
      { inspectVersion, start, executionId: () => "execution-1", now: () => 100 },
    );
    expect(await adapter.run(request())).toMatchObject({ ok: true });
    expect(await adapter.run(request())).toMatchObject({ ok: false, failure: { reason: /unsupported Codex CLI version/ } });
    expect(inspectVersion).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
  });

  it("kills malformed JSONL and retains the bad line for diagnosis", async () => {
    const fake = fakeProcess({ stdout: ["not-json"], exitOn: "SIGTERM" });
    const runner = harness(fake.processHandle);
    const result = await runner.adapter.run(request());
    expect(result).toMatchObject({
      ok: false,
      execution: { executionId: "execution-1" },
      failure: { kind: "runtime_error", reason: /malformed JSONL/, native: { line: "not-json" } },
    });
    expect(fake.signals).toContain("SIGTERM");
  });

  it("uses stderr for a nonzero process failure", async () => {
    const fake = fakeProcess({
      stderr: ["authentication required"],
      exit: { exitCode: 1, signal: null },
    });
    const result = await harness(fake.processHandle).adapter.run(request());
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: "authentication required" } });
  });
});

describe("Codex exec cancellation", () => {
  it("aborts during version inspection without spawning the run process", async () => {
    const controller = new AbortController();
    const fake = fakeProcess({ stdout: events() });
    const inspectVersion = vi.fn(
      (_path: string, _env: Record<string, string>, options: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        }),
    );
    const runner = harness(fake.processHandle, { inspectVersion, deadlineNow: Date.now });
    const pending = runner.adapter.run(request({ signal: controller.signal }));
    expect(inspectVersion).toHaveBeenCalledOnce();
    controller.abort("stop before spawn");
    const result = await pending;
    expect(result).toMatchObject({ ok: false, failure: { kind: "aborted", reason: "stop before spawn" } });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("applies the wall deadline while version inspection is still pending", async () => {
    vi.useFakeTimers();
    const fake = fakeProcess({ stdout: events() });
    const inspectVersion = vi.fn(() => new Promise<string>(() => undefined));
    const runner = harness(fake.processHandle, { inspectVersion, deadlineNow: Date.now });
    const pending = runner.adapter.run(request({ wallTimeMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, failure: { kind: "wall_time_exceeded", wallTimeMs: 1_000 } });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("subtracts version inspection time from the process wall deadline", async () => {
    vi.useFakeTimers();
    const fake = fakeProcess({ exitOn: "SIGKILL" });
    const inspectVersion = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(`codex-cli ${SUPPORTED_CODEX_EXEC_VERSION}`), 400)),
    );
    const runner = harness(fake.processHandle, { inspectVersion, deadlineNow: Date.now });
    const pending = runner.adapter.run(request({ wallTimeMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(400);
    expect(runner.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(599);
    expect(fake.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      ok: false,
      failure: { kind: "cancelled_unknown", native: { cause: "timeout" } },
    });
  });

  it("terminates then force-kills the owned process when wall time expires", async () => {
    vi.useFakeTimers();
    const fake = fakeProcess({ exitOn: "SIGKILL" });
    const runner = harness(fake.processHandle);
    const pending = runner.adapter.run(request({ wallTimeMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "cancelled_unknown",
        native: {
          cause: "timeout",
          requested: { kind: "wall_time_exceeded", wallTimeMs: 1_000 },
          processExit: { signal: "SIGKILL" },
        },
      },
    });
  });

  it("terminates promptly when the caller aborts", async () => {
    const controller = new AbortController();
    const fake = fakeProcess({ exitOn: "SIGTERM" });
    const runner = harness(fake.processHandle);
    const pending = runner.adapter.run(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce());
    controller.abort("stop requested");
    const result = await pending;
    expect(fake.signals).toEqual(["SIGTERM"]);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "cancelled_unknown",
        native: {
          cause: "abort",
          requested: { kind: "external_abort", reason: "stop requested" },
          processExit: { signal: "SIGTERM" },
        },
      },
    });
  });

  it("terminates the child and categorizes a progress callback throw", async () => {
    const fake = fakeProcess({ stdout: events(), exitOn: "SIGTERM" });
    const runner = harness(fake.processHandle);
    const result = await runner.adapter.run(
      request({
        onProgress: (event) => {
          if (event.kind === "execution_started") throw new Error("progress sink closed");
        },
      }),
    );
    expect(fake.signals).toContain("SIGTERM");
    expect(result).toMatchObject({
      ok: false,
      execution: { executionId: "execution-1" },
      failure: { kind: "runtime_error", reason: /progress sink closed/ },
    });
  });
});
