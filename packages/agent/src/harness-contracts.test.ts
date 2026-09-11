import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ClaudeCodeRunRequest, CodexRunRequest, HarnessRunProgress } from "./harness-contracts.js";

describe("harness request conformance", () => {
  it("compiles native Claude and Codex options only in their own branches", () => {
    const claude: ClaudeCodeRunRequest<{ verdict: string }> = {
      harness: "claude-code",
      prompt: "review",
      cwd: "/tmp/work",
      target: { kind: "fresh", namespace: "local" },
      wallTimeMs: 60_000,
      limits: [{ unit: "agent_iterations", value: 8, scope: "execution", enforcement: "hard" }],
      native: { permissionMode: "dontAsk", allowedTools: ["Read"], outputSchema: z.object({ verdict: z.string() }) },
    };
    const parse = vi.fn((value: unknown) => z.object({ verdict: z.string() }).parse(value));
    const codex: CodexRunRequest<{ verdict: string }> = {
      harness: "codex",
      prompt: "review",
      cwd: "/tmp/work",
      target: { kind: "resume", conversation: { harness: "codex", namespace: "local", nativeId: "thread-1" } },
      wallTimeMs: 60_000,
      limits: [{ unit: "model_requests", value: 4, scope: "execution", enforcement: "advisory" }],
      native: {
        model: "selected-by-caller",
        reasoningEffort: "high",
        sandbox: "read-only",
        approvalPolicy: "never",
        outputSchema: { jsonSchema: { type: "object" }, parse },
      },
    };
    expect([claude.harness, codex.harness]).toEqual(["claude-code", "codex"]);
  });

  it("rejects cross-harness native fields and an omitted wall deadline at compile time", () => {
    const codex: CodexRunRequest = {
      harness: "codex",
      prompt: "review",
      cwd: "/tmp/work",
      target: { kind: "fresh", namespace: "local" },
      wallTimeMs: 1,
      native: {
        // @ts-expect-error allowedTools is an Anthropic SDK option, not a Codex option
        allowedTools: ["Read"],
      },
    };
    const claude: ClaudeCodeRunRequest = {
      harness: "claude-code",
      prompt: "review",
      cwd: "/tmp/work",
      target: { kind: "fresh", namespace: "local" },
      wallTimeMs: 1,
      native: {
        // @ts-expect-error sandbox is a Codex option, not an Anthropic SDK option
        sandbox: "read-only",
      },
    };
    // @ts-expect-error a bounded run always requires wallTimeMs
    const missingWallTime: CodexRunRequest = { harness: "codex", prompt: "review", cwd: "/tmp/work", target: { kind: "fresh", namespace: "local" } };
    expect([codex.harness, claude.harness, missingWallTime.harness]).toHaveLength(3);
  });

  it("keeps normalized progress independent of native event types", () => {
    const progress: HarnessRunProgress = {
      kind: "conversation_identified",
      harness: "codex",
      executionId: "execution-1",
      conversation: { harness: "codex", namespace: "local", nativeId: "thread-1" },
      atMs: 1_789_000_000_000,
    };
    expect(progress.kind).toBe("conversation_identified");
  });
});
