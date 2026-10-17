import { describe, expect, it, vi } from "vitest";
import { buildCodexExecArgs, codexExecCapabilities, createCodexExecAdapter } from "./codex-exec.js";
import type { ClaudeCodeRunRequest, CodexRunRequest } from "./harness-contracts.js";
import { preflightHarnessRun } from "./preflight.js";

const THREAD_ID = "019c0000-0000-7000-8000-000000000001";
const request = (nativeId: string): CodexRunRequest => ({
  harness: "codex", prompt: "report", cwd: "/tmp/work", wallTimeMs: 2000,
  target: { kind: "resume", conversation: { harness: "codex", namespace: "fixture", nativeId } },
  native: { model: "fixture", sandbox: "read-only", approvalPolicy: "never" },
});

describe("Codex resume thread identity", () => {
  const invalidIds = [
    "--dangerously-bypass-approvals-and-sandbox",
    '--config=sandbox_mode="danger-full-access"',
    "thread-1", "", " ", `-${THREAD_ID}`, `${THREAD_ID}\n`, `${THREAD_ID} `,
    THREAD_ID.replaceAll("-", ""), `${THREAD_ID}x`,
  ];
  it.each(invalidIds)("refuses non-UUID %j in the direct argv builder", (nativeId) => {
    expect(() => buildCodexExecArgs(request(nativeId))).toThrow(/thread UUID/);
  });
  it.each(invalidIds)("refuses non-UUID %j in preflight", (nativeId) => {
    expect(preflightHarnessRun(request(nativeId), codexExecCapabilities())).toMatchObject({
      kind: "invalid_request",
    });
  });
  it.each(invalidIds)("refuses non-UUID %j before probing or launching", async (nativeId) => {
    const inspectVersion = vi.fn(async () => "codex-cli 0.162.1");
    const inspectCapabilities = vi.fn(async () => ({
      capabilities: { json_events: true, config_overrides: true, user_config_isolation: true,
        strict_config: true, model_selection: true }, sandboxes: ["read-only"],
    }));
    const start = vi.fn(() => { throw new Error("must not launch"); });
    const adapter = createCodexExecAdapter({ auth: "cached-cli", env: {} },
      { inspectVersion, inspectCapabilities, start });
    expect(await adapter.run(request(nativeId))).toMatchObject({ ok: false, failure: { kind: "invalid_request" } });
    expect(inspectVersion).not.toHaveBeenCalled();
    expect(inspectCapabilities).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it.each([THREAD_ID, "ABCDEF01-2345-6789-ABCD-EF0123456789"])("keeps canonical UUID %s as the resume operand", (nativeId) => {
    const args = buildCodexExecArgs(request(nativeId));
    expect(args[args.indexOf("--") - 1]).toBe(nativeId);
    expect(preflightHarnessRun(request(nativeId), codexExecCapabilities())).toBeUndefined();
  });
  it("captures the validated resume operand once", () => {
    const nativeId = vi.fn().mockReturnValueOnce(THREAD_ID).mockReturnValue("--dangerously-bypass-approvals-and-sandbox");
    const resume = request(THREAD_ID);
    if (resume.target.kind !== "resume") throw new Error("expected resume fixture");
    Object.defineProperty(resume.target.conversation, "nativeId", { get: nativeId });
    const args = buildCodexExecArgs(resume);
    expect(nativeId).toHaveBeenCalledOnce();
    expect(args[args.indexOf("--") - 1]).toBe(THREAD_ID);
  });
  it("preserves opaque Claude conversation IDs", () => {
    const claude: ClaudeCodeRunRequest = { harness: "claude-code", prompt: "report", cwd: "/tmp/work", wallTimeMs: 2000,
      target: { kind: "resume", conversation: { harness: "claude-code", namespace: "fixture", nativeId: "opaque-session" } } };
    expect(preflightHarnessRun(claude, { ...codexExecCapabilities(), harness: "claude-code" })).toBeUndefined();
  });
});
