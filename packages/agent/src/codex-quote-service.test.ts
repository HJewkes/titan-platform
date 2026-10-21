import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessPriceQuote, HarnessPricingPort } from "@titan-design/agent-protocol/harness";
import type { CodexRunRequest, HarnessRunProgress } from "./harness-contracts.js";
import type { CodexExecAdapterOptions, CodexExecDeps } from "./codex-exec.js";
import type { CodexProcessExit, SupervisedCodexProcess } from "./codex-process.js";

const boundary = vi.hoisted(() => {
  const violations: string[] = [];
  Object.defineProperty(globalThis, Symbol.for("codex-s07-native-violations"), { value: violations, configurable: true });
  const forbidden = (name: string): never => {
    violations.push(name);
    throw new Error(`forbidden native effect: ${name}`);
  };
  return { violations, forbidden };
});
// Mock ONLY a dedicated new fixture. Existing original tests retain all imports/assertions.
vi.mock("node:fs/promises", () => ({
  mkdtemp: () => boundary.forbidden("mkdtemp"),
  rm: () => boundary.forbidden("rm"),
  writeFile: () => boundary.forbidden("writeFile"),
}));
vi.mock("node:child_process", () => ({
  execFile: () => boundary.forbidden("execFile"),
  spawn: () => boundary.forbidden("spawn"),
}));
import { createCodexExecAdapter, SUPPORTED_CODEX_EXEC_VERSION } from "./codex-exec.js";

function request(overrides: Partial<CodexRunRequest<string>> = {}): CodexRunRequest<string> {
  return {
    harness: "codex", prompt: "synthetic quote fixture", cwd: "/synthetic/work",
    target: { kind: "fresh", namespace: "synthetic-namespace" }, wallTimeMs: 30_000,
    native: { model: "caller-selected", sandbox: "read-only", approvalPolicy: "never" },
    ...overrides,
  };
}
function events(text = "done") {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "019c0000-0000-7000-8000-000000000001" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 10, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2,
    } }),
  ];
}
function fakeProcess(lines: readonly string[] = events(), exitCode = 0, afterLines: () => void = () => undefined) {
  const signals: string[] = [];
  const completed = Promise.resolve<CodexProcessExit>({ exitCode, signal: null });
  async function* stdout() { for (const line of lines) yield line; afterLines(); }
  async function* stderr() { yield* []; }
  const handle: SupervisedCodexProcess = {
    stdout: stdout(), stderr: stderr(), completed, terminate: signal => { signals.push(signal); },
  };
  return { handle, signals };
}
function harness(handle: SupervisedCodexProcess, options: Partial<CodexExecAdapterOptions>, overrides: Partial<CodexExecDeps> = {}) {
  const start = vi.fn(() => handle);
  const deps: CodexExecDeps = {
    inspectVersion: async () => `codex-cli ${SUPPORTED_CODEX_EXEC_VERSION}`,
    inspectCapabilities: async () => ({
      capabilities: { json_events: true, config_overrides: true, user_config_isolation: true,
        strict_config: true, output_schema: true, model_selection: true, working_directory: true },
      sandboxes: ["read-only", "workspace-write"],
    }),
    start, executionId: () => "synthetic-execution", now: () => 100,
    createSchemaFile: async () => ({ path: "/synthetic/schema.json", dispose: async () => undefined }),
    ...overrides,
  };
  return { start, adapter: createCodexExecAdapter({ auth: "cached-cli", executablePath: "/synthetic/codex",
    env: {}, killGraceMs: 10, ...options }, deps) };
}
function priced(usd: number): HarnessPriceQuote {
  return { status: "priced", cost: { usd, kind: "estimate" }, basis: { kind: "catalog", atMs: 100, catalog: {
    id: "caller-catalog", version: "fixture-v1", provider: "caller-provider", model: "caller-selected",
    effectiveFrom: "1970-01-01", matchingPolicy: { id: "exact-model-date", version: "fixture-v1" },
    accountingPolicy: { id: "inclusive-tokens", version: "fixture-v1" },
  } } };
}
afterEach(() => { expect(boundary.violations).toEqual([]); vi.useRealTimers(); });

describe("Codex injected quote boundary", () => {
  it("calls the service once at captured event time on success and failed exit", async () => {
    for (const exitCode of [0, 1]) {
      let clock = 100;
      const process = fakeProcess(events(), exitCode, () => { clock = 9999; });
      const quote = vi.fn<HarnessPricingPort<"codex">["quote"]>(() => priced(0.125));
      // Existing killGraceMs keeps OLD3927 weak option structure compatible: real behavioral RED.
      const options = { killGraceMs: 10, pricingService: { harness: "codex" as const, quote } };
      const progress: HarnessRunProgress[] = [];
      const result = await harness(process.handle, options, { now: () => clock }).adapter.run(
        request({ onProgress: event => progress.push(event) }),
      );
      expect(quote).toHaveBeenCalledTimes(1);
      expect(quote.mock.calls[0]?.[1]).toBe(100);
      expect(quote.mock.calls[0]?.[0]).toMatchObject({ model: "caller-selected", kind: "snapshot", scope: "turn",
        epoch: "synthetic-execution", source: "codex-exec.turn.completed.usage",
        tokens: { input: 10, cachedInput: 4, output: 6, reasoningOutput: 2 } });
      expect(result.ok).toBe(exitCode === 0);
      expect(result.usage[0]?.cost).toEqual({ usd: 0.125, kind: "estimate" });
      const emitted = progress.flatMap(event => event.kind === "usage" ? [event.measurement] : []);
      expect(emitted).toEqual(result.usage);
      expect(emitted[0]).toBe(result.usage[0]);
    }
  });
  it("keeps unpriced null distinct from priced zero", async () => {
    for (const response of [{ status: "unpriced", reason: "synthetic unavailable" } as const, priced(0)]) {
      const quote = vi.fn<HarnessPricingPort<"codex">["quote"]>(() => response);
      const options = { killGraceMs: 10, pricingService: { harness: "codex" as const, quote } };
      const result = await harness(fakeProcess().handle, options).adapter.run(request());
      expect(quote).toHaveBeenCalledTimes(1);
      expect(result.usage[0]?.cost).toEqual(response.status === "unpriced" ? null : { usd: 0, kind: "estimate" });
    }
  });
  it("does not recursively quote or lose usage on Error and primitive rejection", async () => {
    for (const error of [new Error("synthetic quote failure"), "synthetic primitive failure"]) {
      const quote = vi.fn(() => { throw error; });
      const options = { killGraceMs: 10, pricingService: { harness: "codex" as const, quote } };
      const result = await harness(fakeProcess().handle, options).adapter.run(request());
      expect(quote).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error",
        reason: error instanceof Error ? error.message : error } });
      expect(result.usage[0]).toMatchObject({ cost: null, source: "codex-exec.turn.completed.usage",
        tokens: { input: 10, cachedInput: 4, output: 6 } });
    }
  });
  it("rejects both rows and service without starting a process", () => {
    const quote = vi.fn<HarnessPricingPort<"codex">["quote"]>(() => priced(0));
    const options = { killGraceMs: 10, prices: [], pricingService: { harness: "codex" as const, quote } };
    expect(() => harness(fakeProcess().handle, options)).toThrow(TypeError);
    expect(quote).not.toHaveBeenCalled();
  });
  it("reuses the quote after schema cleanup failure", async () => {
    const quote = vi.fn<HarnessPricingPort<"codex">["quote"]>(() => priced(0.125));
    const options = { killGraceMs: 10, pricingService: { harness: "codex" as const, quote } };
    const order: string[] = [];
    const parse = vi.fn((value: unknown) => { expect(value).toBe("done"); order.push("parse"); return String(value); });
    const dispose = vi.fn(async () => { order.push("cleanup"); throw new Error("synthetic cleanup failure"); });
    const result = await harness(fakeProcess(events(JSON.stringify("done"))).handle, options, {
      createSchemaFile: async () => ({ path: "/synthetic/schema.json", dispose }),
    }).adapter.run(request({ native: { model: "caller-selected", sandbox: "read-only", approvalPolicy: "never",
      outputSchema: { jsonSchema: { type: "string" }, parse } } }));
    expect(quote).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["parse", "cleanup"]);
    expect(result).toMatchObject({ ok: false, failure: { reason: "synthetic cleanup failure" } });
    expect(result.usage[0]?.cost).toEqual({ usd: 0.125, kind: "estimate" });
  });
});

// Reuses its actual harness()/fakeProcess()/request()/priced() helpers and narrow mocks.
// Runtime mutation of well-typed data models malformed external JS without unsafe casts.
describe("additional injected quote contract boundaries", () => {
  it("rejects malformed projected quotes once while retaining raw normalized usage", async () => {
    for (const malformed of ["nan-usd", "negative-usd", "invalid-status"] as const) {
      const quote = vi.fn<HarnessPricingPort<"codex">["quote"]>(() => {
        const response = priced(0.125);
        if (malformed === "invalid-status") Reflect.set(response, "status", "invalid");
        else if (response.status === "priced") {
          Reflect.set(response.cost, "usd", malformed === "nan-usd" ? Number.NaN : -1);
        }
        return response;
      });
      const options = { killGraceMs: 10, pricingService: { harness: "codex" as const, quote } };
      const progress: HarnessRunProgress[] = [];
      const result = await harness(fakeProcess().handle, options).adapter.run(
        request({ onProgress: event => progress.push(event) }),
      );
      expect(quote).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error",
        reason: malformed === "invalid-status" ? "pricingService returned an invalid quote" : "pricingService returned invalid USD cost" } });
      expect(result.usage[0]).toMatchObject({ model: "caller-selected", cost: null,
        source: "codex-exec.turn.completed.usage", tokens: { input: 10, cachedInput: 4, output: 6 } });
      const emitted = progress.flatMap(event => event.kind === "usage" ? [event.measurement] : []);
      expect(emitted).toEqual(result.usage);
      expect(emitted[0]).toBe(result.usage[0]);
    }
  });

  it("refuses wrong harness and noncallable service before any native start or probe", () => {
    for (const invalid of ["wrong-harness", "noncallable"] as const) {
      const service: HarnessPricingPort<"codex"> = { harness: "codex", quote: () => priced(0) };
      if (invalid === "wrong-harness") Reflect.set(service, "harness", "another-harness");
      else Reflect.set(service, "quote", false);
      const process = fakeProcess();
      const start = vi.fn(() => process.handle);
      const inspectVersion = vi.fn(async () => `codex-cli ${SUPPORTED_CODEX_EXEC_VERSION}`);
      const options = { killGraceMs: 10, pricingService: service };
      expect(() => harness(process.handle, options, { start, inspectVersion })).toThrow(TypeError);
      expect(start).not.toHaveBeenCalled();
      expect(inspectVersion).not.toHaveBeenCalled();
      expect(process.signals).toEqual([]);
    }
  });

  it("preserves cleanup error precedence after a quote error without a second quote", async () => {
    const quote = vi.fn(() => { throw new Error("synthetic quote failure"); });
    const options = { killGraceMs: 10, pricingService: { harness: "codex" as const, quote } };
    const order: string[] = [];
    const parse = vi.fn((value: unknown) => { expect(value).toBe("done"); order.push("parse"); return String(value); });
    const dispose = vi.fn(async () => { order.push("cleanup"); throw new Error("synthetic cleanup failure"); });
    const result = await harness(fakeProcess(events(JSON.stringify("done"))).handle, options, {
      createSchemaFile: async () => ({ path: "/synthetic/schema.json", dispose }),
    }).adapter.run(request({ native: { model: "caller-selected", sandbox: "read-only", approvalPolicy: "never",
      outputSchema: { jsonSchema: { type: "string" }, parse } } }));
    expect(quote).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["parse", "cleanup"]);
    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: "synthetic cleanup failure" } });
    expect(result.usage[0]).toMatchObject({ cost: null, source: "codex-exec.turn.completed.usage",
      tokens: { input: 10, cachedInput: 4, output: 6 } });
  });
});

describe("pricing service capture compatibility", () => {
  it("captures a get-only Proxy quote once and binds the original receiver without has traps", async () => {
    let quoteReads = 0;
    let hasCalls = 0;
    let quoteCalls = 0;
    const service: HarnessPricingPort<"codex"> = new Proxy({
      harness: "codex" as const,
      get quote(): HarnessPricingPort<"codex">["quote"] {
        quoteReads++;
        return function (this: HarnessPricingPort<"codex">) {
          expect(this).toBe(service);
          quoteCalls++;
          return priced(0.125);
        };
      },
    }, { has() { hasCalls++; return false; } });
    const process = fakeProcess();
    const result = await harness(process.handle, { killGraceMs: 10, pricingService: service }).adapter.run(request());
    expect(result.ok).toBe(true);
    expect(result.usage[0]?.cost).toEqual({ usd: 0.125, kind: "estimate" });
    expect([quoteReads, quoteCalls, hasCalls]).toEqual([1, 1, 0]);
    expect(process.signals).toEqual([]);
  });
});
