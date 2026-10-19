import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { HARNESS_CONTRACT_VERSION } from "./index.js";
import type {
  HarnessAccountRef, HarnessCapabilityDescriptor, HarnessDispatchReceipt, HarnessExecutionBinding,
  HarnessExecutionPort, HarnessExecutionRequest, HarnessRunProgress, HarnessRunResult,
} from "./index.js";

const binding: HarnessExecutionBinding<"fixture-third"> = {
  profileRef: "profile/fixture", policyRevision: "synthetic-policy-only",
  account: { harness: "fixture-third", host: "fixture-host", accountId: "account/fixture", billingPoolId: "pool/fixture" },
  model: { model: "fixture-model", reasoningEffort: "fixture-intent" },
};
const supported = { status: "supported" as const, evidence: "synthetic local transform only" };
const unverified = { status: "unverified" as const, reason: "no native runtime evidence" };
const descriptor: HarnessCapabilityDescriptor<"fixture-third"> = {
  harness: "fixture-third", adapter: { name: "fixture", version: "1" }, limits: [],
  capabilities: { fresh_run: supported, resume: supported, structured_output: supported,
    fork: unverified, interactive_approvals: unverified, external_cancellation: unverified,
    semantic_interrupt: unverified, active_turn_steering: unverified, idle_turn_submission: unverified,
    persisted_transcript: unverified, process_reattachment: unverified, token_reporting: unverified },
};
function fixture() {
  const calls: { binding: HarnessExecutionBinding<"fixture-third">; target: HarnessExecutionRequest["target"] }[] = [];
  const port: HarnessExecutionPort<"fixture-third"> = {
    contractVersion: HARNESS_CONTRACT_VERSION, descriptor,
    async run<T>(request: HarnessExecutionRequest<"fixture-third", T>): Promise<HarnessRunResult<T, "fixture-third">> {
      calls.push({ binding: request.binding, target: request.target });
      const conversation = request.target.kind === "resume" ? request.target.conversation : {
        harness: request.harness, namespace: request.target.namespace, nativeId: `native-${calls.length}`,
      };
      const execution = { executionId: `execution-${calls.length}`, conversation };
      request.onProgress?.({ harness: request.harness, atMs: 1, kind: "execution_started", execution });
      const text = request.prompt.toUpperCase();
      const output = request.output?.kind === "structured" ?
        { kind: "structured" as const, value: request.output.parse({ answer: text }) } : { kind: "text" as const, text };
      request.onProgress?.({ harness: request.harness, atMs: 2, kind: "execution_finished", executionId: execution.executionId, outcome: "succeeded" });
      return { ok: true, harness: request.harness, execution, conversation, output, usage: [] };
    },
  };
  return { port, calls };
}
async function invoke<H extends string, T>(port: HarnessExecutionPort<H>, request: HarnessExecutionRequest<H, T>) {
  return port.run(request);
}
function request(): HarnessExecutionRequest<"fixture-third"> {
  return { harness: "fixture-third", binding, prompt: "observable work", cwd: "/fixture/work", wallTimeMs: 1000,
    target: { kind: "fresh", namespace: "fixture-host/account" } };
}

describe("neutral execution port", () => {
  it("performs observable third-adapter work with no closed vendor union", async () => {
    const f = fixture(); const progress: HarnessRunProgress<"fixture-third">[] = [];
    const result = await invoke(f.port, { ...request(), onProgress: value => progress.push(value) });
    expect(f.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, harness: "fixture-third", output: { kind: "text", text: "OBSERVABLE WORK" }, usage: [] });
    expect(progress.map(value => value.kind)).toEqual(["execution_started", "execution_finished"]);
    expectTypeOf(result.harness).toEqualTypeOf<"fixture-third">();
  });
  it("retains bound account, pool, model intent and scoped conversation on resume", async () => {
    const f = fixture(); const first = await f.port.run(request());
    if (!first.ok) throw new Error("fixture must finish");
    const resumed = await f.port.run({ ...request(), prompt: "resume work", target: { kind: "resume", conversation: first.conversation } });
    expect(f.calls.map(call => call.binding)).toEqual([binding, binding]);
    expect(f.calls[1]?.target).toEqual({ kind: "resume", conversation: first.conversation });
    expect(resumed).toMatchObject({ ok: true, conversation: first.conversation, output: { text: "RESUME WORK" } });
  });
  it("carries SDK-free structured output validation in the selected adapter", async () => {
    const f = fixture(); const parsed: unknown[] = [];
    const result = await f.port.run({ ...request(), output: { kind: "structured", jsonSchema: { type: "object" }, parse(value) {
      parsed.push(value);
      if (typeof value !== "object" || value === null || !("answer" in value) || typeof value.answer !== "string") throw new Error("invalid fixture output");
      return { answer: value.answer };
    } } });
    expect(parsed).toEqual([{ answer: "OBSERVABLE WORK" }]);
    if (!result.ok || result.output.kind !== "structured") throw new Error("fixture must produce structured output");
    expectTypeOf(result.output.value).toEqualTypeOf<{ answer: string }>();
    expect(result.output.value).toEqual({ answer: "OBSERVABLE WORK" });
  });
  it("keeps acceptance/running/refusal receipts distinct from completed results", () => {
    const accepted: HarnessDispatchReceipt<"fixture-third"> = { state: "accepted", harness: "fixture-third", binding, execution: { executionId: "pending" } };
    const running: HarnessDispatchReceipt<"fixture-third"> = { ...accepted, state: "running", observedAtMs: 1 };
    const refused: HarnessDispatchReceipt<"fixture-third"> = { state: "refused", harness: "fixture-third", failure: { kind: "cancelled_unknown", reason: "fixture outcome unknown" } };
    // @ts-expect-error acceptance lacks terminal output and usage; it is not a completed run
    const completed: HarnessRunResult = accepted;
    expect([accepted.state, running.state, refused.state]).toEqual(["accepted", "running", "refused"]);
    expect(completed).not.toHaveProperty("ok");
  });
  it("requires compatible account binding/version and keeps native options out of the neutral request", () => {
    const other: HarnessAccountRef<"other-system"> = { ...binding.account, harness: "other-system" };
    // @ts-expect-error a statically bound third adapter cannot use another harness account
    const wrongBinding: HarnessExecutionBinding<"fixture-third"> = { ...binding, account: other };
    // @ts-expect-error every account binding retains its billing pool
    const missingPool: HarnessAccountRef = { harness: "fixture-third", host: "fixture-host", accountId: "account" };
    // @ts-expect-error native SDK options belong to the adapter, not the consumer service contract
    const nativeRequest: HarnessExecutionRequest<"fixture-third"> = { ...request(), native: { permissionMode: "fixture" } };
    // @ts-expect-error incompatible interface versions require explicit negotiation before use
    const wrongVersion: typeof HARNESS_CONTRACT_VERSION = 2;
    expect([wrongBinding, missingPool, nativeRequest, wrongVersion]).toHaveLength(4);
  });
  it("keeps the new contract leaf SDK-free with only relative type imports", () => {
    const text = readFileSync(new URL("./execution-port.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("execution-port.ts", text, ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration);
    expect(imports.every(node => node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("."))).toBe(true);
    expect(text).not.toMatch(/node:|@anthropic-ai|@openai|claude-agent-sdk/);
  });
});
