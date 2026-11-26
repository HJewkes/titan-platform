import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_CODEX_EXEC_VERSION, createCodexExecAdapter } from "./codex-exec.js";
import type { CodexProcessInput, SupervisedCodexProcess } from "./codex-process.js";
import type { CodexRunRequest } from "./harness-contracts.js";
import { runAgent } from "./run.js";
import type { AgentRunConfig } from "./types.js";

const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/args.txt"
cat > "$FAKE_DIR/stdin.txt"
cat "$FAKE_DIR/result.txt"
`;

// Synthetic bytes: a valid signature is all the sniffer reads, so no real picture is needed.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x03, 0x04]);

const RESULT = {
  type: "result", subtype: "success", is_error: false, result: "a synthetic answer", session_id: "print-sess-img",
  num_turns: 1, duration_ms: 900, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: { "claude-test": { inputTokens: 10, outputTokens: 5, costUSD: 0.001 } },
};
const TODAYS_ARGS = [
  "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--setting-sources", "", "--disable-slash-commands", "--max-turns", "1", "--max-budget-usd", "0.5",
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-images-test-"));
  const staging = join(dir, "claude.staging");
  writeFileSync(staging, FAKE_CLAUDE);
  chmodSync(staging, 0o755);
  execFileSync("cp", ["-p", staging, join(dir, "claude")]);
  writeFileSync(join(dir, "first.png"), PNG_BYTES);
  writeFileSync(join(dir, "second.jpg"), JPEG_BYTES);
  writeFileSync(join(dir, "notes.png"), "plain text wearing a png name");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function printConfig(overrides: Partial<AgentRunConfig> = {}): AgentRunConfig {
  return { harness: "claude-print", prompt: "Describe the sheet", cwd: dir, maxTurns: 1, maxBudgetUsd: 0.5, ...overrides };
}

function runPrint(overrides: Partial<AgentRunConfig> = {}) {
  return runAgent(printConfig(overrides), { env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_DIR: dir } });
}

function recorded(file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

function recordedArgs(): string[] {
  return recorded("args.txt").split("\n").slice(0, -1);
}

describe("claude-print image attachments", () => {
  it("a run with images sends each image as a content block before the prompt text, in order", async () => {
    const stream = [{ type: "system", subtype: "init", session_id: "print-sess-img" }, RESULT];
    writeFileSync(join(dir, "result.txt"), stream.map(line => JSON.stringify(line)).join("\n") + "\n");

    const result = await runPrint({ images: [join(dir, "first.png"), join(dir, "second.jpg")] });

    expect(result).toMatchObject({ ok: true, output: "a synthetic answer", sessionId: "print-sess-img" });
    const sent: unknown = JSON.parse(recorded("stdin.txt"));
    expect(sent).toEqual({ type: "user", message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_BYTES.toString("base64") } },
      { type: "text", text: "Describe the sheet" },
    ] } });
    expect(recordedArgs().slice(0, 6)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  });

  it.each([
    ["no images field", {}],
    ["an empty images list", { images: [] }],
  ])("a run with %s builds the same args and stdin as today", async (_scenario, overrides: Partial<AgentRunConfig>) => {
    writeFileSync(join(dir, "result.txt"), JSON.stringify(RESULT));

    const result = await runPrint(overrides);

    expect(result).toMatchObject({ ok: true, output: "a synthetic answer" });
    expect(recordedArgs()).toEqual(TODAYS_ARGS);
    expect(recorded("stdin.txt")).toBe("Describe the sheet");
  });

  it("a missing image path fails before spawn with a runtime_error that names the path", async () => {
    const missing = join(dir, "absent.png");

    const result = await runPrint({ images: [join(dir, "first.png"), missing] });

    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: expect.stringContaining(missing) } });
    expect(existsSync(join(dir, "args.txt"))).toBe(false);
  });

  it("a non-PNG/JPEG file is rejected before spawn, whatever its extension", async () => {
    const result = await runPrint({ images: [join(dir, "notes.png")] });

    expect(result).toMatchObject({ ok: false, failure: { kind: "runtime_error", reason: expect.stringContaining("not a PNG or JPEG") } });
    expect(existsSync(join(dir, "args.txt"))).toBe(false);
  });

  it("the SDK harness refuses images before starting a session", async () => {
    await expect(runAgent({ ...printConfig({ images: [join(dir, "first.png")] }), harness: "claude-code" })).rejects.toThrow(/claude-print/);
  });
});

function codexRequest(images: readonly string[]): CodexRunRequest {
  return {
    harness: "codex", prompt: "Describe the sheet", cwd: dir, target: { kind: "fresh", namespace: "workstation-a" },
    wallTimeMs: 30_000, native: { model: "caller-selected", sandbox: "read-only", approvalPolicy: "never", images },
  };
}

function codexEvents(): AsyncIterable<string> {
  const lines = [
    { type: "thread.started", thread_id: "019c0000-0000-7000-8000-000000000001" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
  ];
  return (async function* () {
    for (const line of lines) yield JSON.stringify(line);
  })();
}

function codexHarness() {
  const processHandle: SupervisedCodexProcess = {
    stdout: codexEvents(), stderr: (async function* () {})(), completed: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => {},
  };
  const start = vi.fn((_input: CodexProcessInput) => processHandle);
  const adapter = createCodexExecAdapter({ auth: "cached-cli", env: { PATH: "/bin" } }, {
    inspectVersion: async () => `codex-cli ${SUPPORTED_CODEX_EXEC_VERSION}`,
    inspectCapabilities: async () => ({
      capabilities: { json_events: true, config_overrides: true, user_config_isolation: true, strict_config: true, output_schema: true, model_selection: true, working_directory: true },
      sandboxes: ["read-only"],
    }),
    start, executionId: () => "execution-img", now: () => 100,
  });
  return { adapter, start };
}

describe("codex exec image attachments", () => {
  it("codex exec gets one -i per image", async () => {
    const images = [join(dir, "first.png"), join(dir, "second.jpg")];
    const { adapter, start } = codexHarness();

    const result = await adapter.run(codexRequest(images));

    expect(result.ok).toBe(true);
    const args = start.mock.calls[0]![0].args;
    const flagged = args.flatMap((arg, index) => (arg === "-i" ? [args[index + 1]] : []));
    expect(flagged).toEqual(images);
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("--"));
  });

  it("codex exec refuses a missing image before it starts the process", async () => {
    const missing = join(dir, "absent.png");
    const { adapter, start } = codexHarness();

    const result = await adapter.run(codexRequest([missing]));

    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid_request", reason: expect.stringContaining(missing) } });
    expect(start).not.toHaveBeenCalled();
  });
});
