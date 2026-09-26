import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildClaudePrintArgs, resolveClaudeBin } from "./claude-print.js";
import { runAgent } from "./run.js";
import type { AgentRunConfig } from "./types.js";

// Records its argv, stdin, env and pid, then behaves per FAKE_MODE.
const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/args.txt"
cat > "$FAKE_DIR/stdin.txt"
env > "$FAKE_DIR/env.txt"
case "$FAKE_MODE" in
  fail) echo "fatal: model endpoint exploded" >&2; exit 3 ;;
  hang) sleep 30 & echo $! > "$FAKE_DIR/sleep.pid"; wait ;;
esac
cat "$FAKE_DIR/result.json"
`;

function cannedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result", subtype: "success", is_error: false, result: '{"ok":true}', structured_output: { ok: true },
    session_id: "print-sess-1", num_turns: 1, duration_ms: 900, stop_reason: "end_turn", total_cost_usd: 0.0025,
    usage: { input_tokens: 1007, output_tokens: 52, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-sonnet-5": { inputTokens: 1007, outputTokens: 52, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0025, contextWindow: 1_000_000, maxOutputTokens: 64_000 } },
    ...overrides,
  };
}

const okSchema = z.object({ ok: z.boolean() });
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-print-test-"));
  writeFileSync(join(dir, "claude"), FAKE_CLAUDE);
  chmodSync(join(dir, "claude"), 0o755);
  writeFileSync(join(dir, "result.json"), JSON.stringify(cannedResult()));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${dir}:/usr/bin:/bin`, HOME: "/home/tester", FAKE_DIR: dir, ...extra };
}

function printConfig<T>(overrides: Partial<AgentRunConfig<T>> = {}): AgentRunConfig<T> {
  return { harness: "claude-print", prompt: "Reply with the JSON", cwd: dir, maxTurns: 1, maxBudgetUsd: 0.5, ...overrides };
}

function recorded(file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

async function whenRecorded(file: string): Promise<void> {
  while (!existsSync(join(dir, file))) await new Promise(resolve => setTimeout(resolve, 20));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("claude-print harness", () => {
  it("returns structured output, usage and the model from the JSON result", async () => {
    const result = await runAgent(printConfig({ outputSchema: okSchema, model: "sonnet", systemPrompt: "Answer in JSON." }), { env: fakeEnv() });

    expect(result).toMatchObject({ ok: true, output: { ok: true }, sessionId: "print-sess-1", init: { model: "claude-sonnet-5", tools: [] } });
    expect(result.ok && result.usage.totalCostUsd).toBe(0.0025);
    expect(result.ok && result.usage.modelUsage["claude-sonnet-5"]?.inputTokens).toBe(1007);
    expect(recorded("stdin.txt")).toBe("Reply with the JSON");
    const args = recorded("args.txt").split("\n");
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--system-prompt", "Answer in JSON.", "--json-schema"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
  });

  it("returns the result text when no schema is given", async () => {
    const result = await runAgent(printConfig(), { env: fakeEnv() });

    expect(result).toMatchObject({ ok: true, output: '{"ok":true}' });
  });

  it("fails as schema_invalid when the answer does not match the zod schema", async () => {
    writeFileSync(join(dir, "result.json"), JSON.stringify(cannedResult({ result: '{"ok":"yes"}', structured_output: { ok: "yes" } })));

    const result = await runAgent(printConfig({ outputSchema: okSchema }), { env: fakeEnv() });

    expect(result).toMatchObject({ ok: false, failure: { kind: "schema_invalid" }, sessionId: "print-sess-1" });
  });

  it("fails as runtime_error carrying stderr when the CLI exits non-zero without a result", async () => {
    const result = await runAgent(printConfig(), { env: fakeEnv({ FAKE_MODE: "fail" }) });

    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error" } });
    expect(!result.ok && result.failure.reason).toContain("code 3");
    expect(!result.ok && result.failure.reason).toContain("fatal: model endpoint exploded");
  });

  it("maps an is_error result through the shared failure taxonomy", async () => {
    writeFileSync(join(dir, "result.json"), JSON.stringify(cannedResult({ is_error: true, result: "API Error: 429 rate limit exceeded" })));

    const result = await runAgent(printConfig(), { env: fakeEnv() });

    expect(result).toMatchObject({ ok: false, failure: { kind: "rate_limited" } });
  });

  it("reports a logged-out CLI as auth_misconfigured", async () => {
    writeFileSync(join(dir, "result.json"), JSON.stringify(cannedResult({ is_error: true, result: "Not logged in · Please run /login" })));

    const result = await runAgent(printConfig(), { env: fakeEnv() });

    expect(result).toMatchObject({ ok: false, failure: { kind: "auth_misconfigured" } });
  });

  it("kills the child process group and fails as inactivity_timeout at the deadline", async () => {
    const started = Date.now();

    const result = await runAgent(printConfig({ inactivityTimeoutMs: 2_000 }), { env: fakeEnv({ FAKE_MODE: "hang" }) });

    expect(result).toMatchObject({ ok: false, failure: { kind: "inactivity_timeout", timeoutMs: 2_000 } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(isAlive(Number(recorded("sleep.pid")))).toBe(false);
  });

  it("kills the child and fails as aborted when the caller aborts", async () => {
    const controller = new AbortController();
    void whenRecorded("sleep.pid").then(() => controller.abort("caller gave up"));

    const result = await runAgent(printConfig({ signal: controller.signal }), { env: fakeEnv({ FAKE_MODE: "hang" }) });

    expect(result).toEqual({ ok: false, failure: { kind: "aborted", reason: "caller gave up" } });
    expect(isAlive(Number(recorded("sleep.pid")))).toBe(false);
  });

  it("starts without CLAUDE_CODE_OAUTH_TOKEN and still strips metered credentials", async () => {
    const env = fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-api-test", ANTHROPIC_AUTH_TOKEN: "bearer-test", CLAUDECODE: "1" });

    const result = await runAgent(printConfig(), { env });

    expect(result.ok).toBe(true);
    const childEnv = recorded("env.txt");
    expect(childEnv).not.toContain("ANTHROPIC_API_KEY");
    expect(childEnv).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(childEnv).not.toContain("CLAUDECODE=");
    expect(childEnv).toContain("HOME=/home/tester");
  });

  it("keeps the API key only when allowApiKeyBilling is set", async () => {
    const result = await runAgent(printConfig({ allowApiKeyBilling: true }), { env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-api-test" }) });

    expect(result.ok).toBe(true);
    expect(recorded("env.txt")).toContain("ANTHROPIC_API_KEY=sk-ant-api-test");
  });

  it("the SDK harness still refuses to start without CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const result = await runAgent({ ...printConfig(), harness: "claude-code" }, { env: fakeEnv() });

    expect(result).toMatchObject({ ok: false, failure: { kind: "auth_misconfigured" } });
  });

  it("throws before spawning when the config asks for tools, MCP or resume", async () => {
    await expect(runAgent(printConfig({ tools: ["Read"] }), { env: fakeEnv() })).rejects.toThrow(/tools is not supported/);
    await expect(runAgent(printConfig({ resumeSessionId: "s" }), { env: fakeEnv() })).rejects.toThrow(/resumeSessionId/);
    await expect(runAgent(printConfig({ tools: [] }), { env: fakeEnv() })).resolves.toMatchObject({ ok: true });
  });

  it("fails as runtime_error when no claude binary is on PATH", async () => {
    const result = await runAgent(printConfig(), { env: { PATH: "/nonexistent" } });

    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: expect.stringContaining("CLAUDE_BIN") } });
  });
});

describe("resolveClaudeBin", () => {
  it("prefers CLAUDE_BIN, then the first executable file named claude on PATH", () => {
    expect(resolveClaudeBin({ CLAUDE_BIN: "/opt/claude", PATH: dir })).toBe("/opt/claude");
    expect(resolveClaudeBin({ PATH: `/nonexistent:${dir}` })).toBe(join(dir, "claude"));
  });
});

describe("buildClaudePrintArgs", () => {
  it("passes a JSON Schema without the draft 2020-12 header the CLI rejects", () => {
    const args = buildClaudePrintArgs(printConfig({ outputSchema: okSchema }));

    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!) as Record<string, unknown>;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({ type: "object", required: ["ok"] });
  });

  it("omits model, system prompt and schema flags when they are not configured", () => {
    const args = buildClaudePrintArgs(printConfig());

    expect(args).not.toContain("--model");
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("--json-schema");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });
});
