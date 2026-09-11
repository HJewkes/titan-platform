import { describe, expect, it, vi } from "vitest";
import {
  EXECUTION_CAPABILITIES,
  type CapabilityAssessment,
  type ClaudeCodeRunRequest,
  type CodexRunRequest,
  type ExecutionCapability,
  type HarnessAdapter,
  type HarnessCapabilityDescriptor,
  type HarnessRunResult,
  type LimitCapability,
} from "./harness-contracts.js";
import { dispatchHarnessRun } from "./preflight.js";

const SUPPORTED: CapabilityAssessment = { status: "supported", evidence: "fake adapter contract" };

function descriptor(
  overrides: Partial<Record<ExecutionCapability, CapabilityAssessment>> = {},
  limits: readonly LimitCapability[] = defaultLimits(),
): HarnessCapabilityDescriptor<"codex"> {
  const capabilities = Object.fromEntries(EXECUTION_CAPABILITIES.map((capability) => [capability, SUPPORTED])) as Record<
    ExecutionCapability,
    CapabilityAssessment
  >;
  return { harness: "codex", adapter: { name: "fake-codex", version: "1" }, capabilities: { ...capabilities, ...overrides }, limits };
}

function defaultLimits(): LimitCapability[] {
  return [
    { unit: "milliseconds", scope: "execution", enforcement: "hard", assessment: SUPPORTED },
    { unit: "usd", scope: "execution", enforcement: "hard", assessment: SUPPORTED },
    { unit: "model_requests", scope: "execution", enforcement: "hard", assessment: SUPPORTED },
    { unit: "agent_iterations", scope: "execution", enforcement: "advisory", assessment: SUPPORTED },
  ];
}

function request(overrides: Partial<CodexRunRequest<string>> = {}): CodexRunRequest<string> {
  return {
    harness: "codex",
    prompt: "inspect the checkout",
    cwd: "/tmp/work",
    target: { kind: "fresh", namespace: "local" },
    wallTimeMs: 30_000,
    ...overrides,
  };
}

function fakeAdapter(adapterDescriptor = descriptor(), thrown?: unknown) {
  const conversation = { harness: "codex", namespace: "local", nativeId: "thread-1" };
  const run = vi.fn();
  const adapter: HarnessAdapter<"codex"> = {
    descriptor: adapterDescriptor,
    async run<T>(runRequest: CodexRunRequest<T>): Promise<HarnessRunResult<T, "codex">> {
      run(runRequest);
      if (thrown !== undefined) throw thrown;
      const schema = runRequest.native?.outputSchema;
      return {
        ok: true,
        harness: "codex",
        execution: { executionId: "execution-1", conversation },
        conversation,
        output: schema ? { kind: "structured", value: schema.parse({ verdict: "done" }) } : { kind: "text", text: "done" },
        usage: [],
      };
    },
  };
  return { adapter, run };
}

function fakeClaudeAdapter() {
  const adapterDescriptor = { ...descriptor(), harness: "claude-code" as const, adapter: { name: "fake-claude", version: "1" } };
  const conversation = { harness: "claude-code", namespace: "local", nativeId: "session-1" };
  const run = vi.fn();
  const adapter: HarnessAdapter<"claude-code"> = {
    descriptor: adapterDescriptor,
    async run<T>(): Promise<HarnessRunResult<T, "claude-code">> {
      run();
      return {
        ok: true,
        harness: "claude-code",
        execution: { executionId: "execution-1", conversation },
        conversation,
        output: { kind: "text", text: "done" },
        usage: [],
      };
    },
  };
  return { adapter, run };
}

describe("dispatchHarnessRun preflight", () => {
  it("invokes the adapter only after all declared requirements pass", async () => {
    const fake = fakeAdapter();
    const result = await dispatchHarnessRun(
      request({ requires: ["persisted_transcript"], limits: [{ unit: "usd", value: 1, scope: "execution", enforcement: "hard" }] }),
      fake.adapter,
    );
    expect(result).toMatchObject({ ok: true, output: { kind: "text", text: "done" } });
    expect(fake.run).toHaveBeenCalledOnce();
  });

  it("reuses one adapter across text and differently typed structured requests", async () => {
    const fake = fakeAdapter();
    const textResult = await dispatchHarnessRun(request(), fake.adapter);
    const parse = vi.fn((value: unknown) => value as { verdict: string });
    const structuredRequest: CodexRunRequest<{ verdict: string }> = {
      ...request(),
      native: { outputSchema: { jsonSchema: { type: "object" }, parse } },
    };
    const structuredResult = await dispatchHarnessRun(structuredRequest, fake.adapter);
    expect(textResult).toMatchObject({ ok: true, output: { kind: "text" } });
    expect(structuredResult).toMatchObject({ ok: true, output: { kind: "structured", value: { verdict: "done" } } });
    expect(parse).toHaveBeenCalledOnce();
    expect(fake.run).toHaveBeenCalledTimes(2);
  });

  it("categorizes an adapter exception as runtime_error", async () => {
    const fake = fakeAdapter(descriptor(), new Error("transport exploded"));
    const result = await dispatchHarnessRun(request(), fake.adapter);
    expect(result).toMatchObject({ ok: false, harness: "codex", failure: { kind: "runtime_error", reason: "transport exploded" }, usage: [] });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed wallTimeMs %s without invoking the adapter",
    async (wallTimeMs) => {
      const fake = fakeAdapter();
      const result = await dispatchHarnessRun(request({ wallTimeMs: wallTimeMs as number }), fake.adapter);
      expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: /wallTimeMs/ } });
      expect(fake.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "fresh" as const, namespace: " " },
    { kind: "resume" as const, conversation: { harness: "codex", namespace: "", nativeId: "thread-1" } },
    { kind: "resume" as const, conversation: { harness: "codex", namespace: "local", nativeId: " " } },
  ])("rejects unusable $kind identity components before launch", async (target) => {
    const fake = fakeAdapter();
    const result = await dispatchHarnessRun(request({ target }), fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request" } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    { unit: "usd" as const, value: Number.NaN, scope: "execution" as const, enforcement: "hard" as const },
    { unit: "usd" as const, value: 0, scope: "execution" as const, enforcement: "hard" as const },
    { unit: "model_requests" as const, value: 1.5, scope: "execution" as const, enforcement: "hard" as const },
  ])("rejects malformed $unit limit values before launch", async (limit) => {
    const fake = fakeAdapter();
    const result = await dispatchHarnessRun(request({ limits: [limit] }), fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request" } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported", { status: "unsupported", reason: "transport has no resume operation" }],
    ["unverified", { status: "unverified", reason: "resume has not been exercised" }],
  ] as const)("rejects an %s capability before launch", async (status, assessment) => {
    const fake = fakeAdapter(descriptor({ resume: assessment }));
    const resume = request({
      target: { kind: "resume", conversation: { harness: "codex", namespace: "local", nativeId: "thread-1" } },
    });
    const result = await dispatchHarnessRun(resume, fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "unsupported_requirement", status } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("treats an omitted capability declaration as unverified", async () => {
    const adapterDescriptor = descriptor();
    delete (adapterDescriptor.capabilities as Partial<Record<ExecutionCapability, CapabilityAssessment>>).resume;
    const fake = fakeAdapter(adapterDescriptor);
    const result = await dispatchHarnessRun(
      request({ target: { kind: "resume", conversation: { harness: "codex", namespace: "local", nativeId: "thread-1" } } }),
      fake.adapter,
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "unsupported_requirement", status: "unverified" } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("short-circuits an already-aborted signal before adapter invocation", async () => {
    const fake = fakeAdapter(descriptor({ external_cancellation: { status: "unverified", reason: "not exercised" } }));
    const result = await dispatchHarnessRun(request({ signal: AbortSignal.abort("cancelled before launch") }), fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "aborted", reason: "cancelled before launch" } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each(["allowedTools", "permissionMode", "allowApiKeyBilling"])(
    "rejects Claude-only native field %s on an untyped Codex request",
    async (field) => {
      const fake = fakeAdapter();
      const untyped = request({ native: { [field]: true } as never });
      const result = await dispatchHarnessRun(untyped, fake.adapter);
      expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: new RegExp(field) } });
      expect(fake.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["reasoningEffort", ""],
    ["sandbox", "host-root"],
    ["approvalPolicy", "always"],
    ["model", " "],
    ["outputSchema", []],
    ["outputSchema", { jsonSchema: [], parse: () => ({}) }],
    ["outputSchema", { jsonSchema: {}, parse: false }],
    ["native", []],
  ])("rejects malformed Codex native option %s before launch", async (field, value) => {
    const fake = fakeAdapter();
    const overrides = field === "native" ? { native: value as never } : { native: { [field]: value } as never };
    const result = await dispatchHarnessRun(request(overrides), fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: new RegExp(field) } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    ["permissionMode", "unattended"],
    ["allowedTools", "Read"],
    ["disallowedTools", ["Read", 3]],
    ["settingSources", ["project", "global"]],
    ["allowApiKeyBilling", "yes"],
    ["outputSchema", {}],
  ])("rejects malformed Claude native option %s before launch", async (field, value) => {
    const fake = fakeClaudeAdapter();
    const claudeRequest = {
      harness: "claude-code",
      prompt: "inspect the checkout",
      cwd: "/tmp/work",
      target: { kind: "fresh", namespace: "local" },
      wallTimeMs: 30_000,
      native: { [field]: value },
    } as unknown as ClaudeCodeRunRequest;
    const result = await dispatchHarnessRun(claudeRequest, fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: new RegExp(field) } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("rejects an unverified hard limit before launch", async () => {
    const limits = defaultLimits().map((limit) =>
      limit.unit === "usd"
        ? { ...limit, assessment: { status: "unverified" as const, reason: "reported cost is only an estimate" } }
        : limit,
    );
    const fake = fakeAdapter(descriptor({}, limits));
    const result = await dispatchHarnessRun(
      request({ limits: [{ unit: "usd", value: 2, scope: "execution", enforcement: "hard" }] }),
      fake.adapter,
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "unsupported_requirement", status: "unverified" } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("rejects an adapter whose descriptor names another harness", async () => {
    const fake = fakeAdapter();
    fake.adapter.descriptor = { ...fake.adapter.descriptor, harness: "claude-code" } as unknown as HarnessCapabilityDescriptor<"codex">;
    const result = await dispatchHarnessRun(request(), fake.adapter);
    expect(result).toMatchObject({ ok: false, failure: { kind: "harness_mismatch", reason: /adapter harness/ } });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("rejects a resume identity from another harness", async () => {
    const fake = fakeAdapter();
    const result = await dispatchHarnessRun(
      request({ target: { kind: "resume", conversation: { harness: "claude-code", namespace: "local", nativeId: "same-id" } } }),
      fake.adapter,
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "harness_mismatch", reason: /resume conversation/ } });
    expect(fake.run).not.toHaveBeenCalled();
  });
});
