import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { toJSONSchema, type ZodType } from "zod";
import { terminateProcessGroup } from "./codex-process.js";
import { classifyResult, usageFromResult } from "./failures.js";
import { CLAUDE_PRINT_UNSUPPORTED_OPTIONS, EXECUTION_CAPABILITIES, type HarnessCapabilityDescriptor } from "./harness-contracts.js";
import type { AgentFailure, AgentInit, AgentRunConfig, AgentRunResult } from "./types.js";

/** SIGTERM alone has been ignored by the CLI in the repo-review pipeline, so SIGKILL follows. */
export const CLAUDE_PRINT_KILL_GRACE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const LOGIN_FAILURE = /not logged in|please run \/login|invalid api key/i;

export function claudePrintCapabilities(): HarnessCapabilityDescriptor<"claude-print"> {
  const capabilities = Object.fromEntries(EXECUTION_CAPABILITIES.map(capability => [capability, {
    status: "unsupported", reason: "claude -p runs one turn with no tools, hooks, MCP or resume",
  }])) as HarnessCapabilityDescriptor<"claude-print">["capabilities"];
  capabilities.fresh_run = { status: "supported", evidence: "spawns claude -p --max-turns 1 per call" };
  capabilities.structured_output = { status: "supported", evidence: "--json-schema, then a local zod parse" };
  capabilities.external_cancellation = { status: "supported", evidence: "abort kills the child process group" };
  capabilities.token_reporting = { status: "supported", evidence: "usage and modelUsage from the JSON result" };
  return {
    harness: "claude-print", adapter: { name: "claude-print", version: "1" }, capabilities,
    limits: [{ unit: "milliseconds", scope: "execution", enforcement: "hard", assessment: {
      status: "supported", evidence: "inactivityTimeoutMs is a wall deadline that kills the child process group",
    } }],
  };
}

/** A caller mistake, thrown before anything spawns, like a missing budget. */
export function assertClaudePrintConfig(config: AgentRunConfig<unknown>): void {
  const field = CLAUDE_PRINT_UNSUPPORTED_OPTIONS.find(name => config[name] !== undefined)
    ?? (config.tools?.length ? "tools" : undefined)
    ?? (config.settingSources?.length ? "settingSources" : undefined);
  if (field) throw new TypeError(`${field} is not supported by the claude-print harness (one turn, no tools, hooks or MCP)`);
}

/** The first executable file named `claude` on PATH, never a shell function or alias. `CLAUDE_BIN` wins. */
export function resolveClaudeBin(env: Record<string, string>): string | undefined {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutableFile(join(dir, "claude"))) return join(dir, "claude");
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function buildClaudePrintArgs(config: AgentRunConfig<unknown>): string[] {
  const args = [
    "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG,
    "--setting-sources", "", "--max-turns", "1", "--max-budget-usd", String(config.maxBudgetUsd),
  ];
  if (config.model) args.push("--model", config.model);
  if (config.systemPrompt !== undefined) args.push("--system-prompt", config.systemPrompt);
  if (config.outputSchema) args.push("--json-schema", cliJsonSchema(config.outputSchema));
  return args;
}

/** The CLI's validator rejects zod's draft 2020-12 `$schema` URI, so the header is dropped. */
function cliJsonSchema(schema: ZodType): string {
  const body = { ...toJSONSchema(schema) } as Record<string, unknown>;
  delete body.$schema;
  return JSON.stringify(body);
}

interface Clock {
  now: () => number;
  startedAt: number;
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  ended?: AgentFailure;
}

/** Run one `claude -p` call; `env` must already be scrubbed and pre-flighted. */
export async function runClaudePrint<T>(
  config: AgentRunConfig<T>,
  env: Record<string, string>,
  clock: Clock,
): Promise<AgentRunResult<T>> {
  if (config.signal?.aborted) return { ok: false, failure: aborted(config.signal) };
  const bin = resolveClaudeBin(env);
  if (!bin) return { ok: false, failure: { kind: "runtime_error", reason: "claude binary not found on PATH; set CLAUDE_BIN" } };
  const child = spawn(bin, buildClaudePrintArgs(config), {
    cwd: config.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const outcome = await supervise(child, config);
  return settle(outcome, config, clock.now() - clock.startedAt);
}

function supervise(child: ChildProcess, config: AgentRunConfig<unknown>): Promise<ChildOutcome> {
  const timeoutMs = config.inactivityTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const output = collectOutput(child);
  let ended: AgentFailure | undefined;
  const stop = (failure: AgentFailure) => {
    ended ??= failure;
    terminateProcessGroup(child, "SIGTERM");
    setTimeout(() => terminateProcessGroup(child, "SIGKILL"), CLAUDE_PRINT_KILL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => stop({ kind: "inactivity_timeout", reason: `claude -p ran past ${timeoutMs}ms`, timeoutMs }), timeoutMs);
  const onAbort = () => stop(aborted(config.signal));
  config.signal?.addEventListener("abort", onAbort, { once: true });
  // A child killed before it reads the prompt closes stdin; that EPIPE is not the failure.
  child.stdin?.on("error", () => {});
  child.stdin?.end(config.prompt);
  return new Promise(resolve => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, ...output(), ...(spawnError ? { spawnError } : {}), ...(ended ? { ended } : {}) });
    };
    child.once("error", error => finish(null, null, error));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

function collectOutput(child: ChildProcess): () => { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return () => ({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
}

function settle<T>(outcome: ChildOutcome, config: AgentRunConfig<T>, durationMs: number): AgentRunResult<T> {
  if (outcome.ended) return { ok: false, failure: outcome.ended };
  if (outcome.spawnError) return { ok: false, failure: { kind: "runtime_error", reason: `claude -p failed to start: ${outcome.spawnError.message}`, raw: outcome.spawnError } };
  const result = parseResult(outcome.stdout);
  if (!result) return { ok: false, failure: exitFailure(outcome, "printed no JSON result") };
  config.onMessage?.(result);
  const usage = usageFromResult(result, durationMs);
  const failure = loginFailure(result) ?? classifyResult(result) ?? (outcome.code === 0 ? undefined : exitFailure(outcome, "reported success"));
  const sessionId = typeof result.session_id === "string" ? result.session_id : undefined;
  if (failure) return { ok: false, failure, ...(sessionId ? { sessionId } : {}), usage };
  if (!sessionId) return { ok: false, failure: { kind: "runtime_error", reason: "the JSON result carried no session_id", raw: result }, usage };
  const output = readOutput(result, config);
  if ("failure" in output) return { ok: false, failure: output.failure, sessionId, usage };
  return { ok: true, output: output.value, sessionId, usage, init: initFrom(result) };
}

function parseResult(stdout: string): SDKResultMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const isResult = typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "result";
    return isResult ? parsed as SDKResultMessage : undefined;
  } catch {
    return undefined;
  }
}

function exitFailure(outcome: ChildOutcome, what: string): AgentFailure {
  const exit = outcome.signal ? `signal ${outcome.signal}` : `code ${String(outcome.code)}`;
  const stderr = outcome.stderr.trim();
  return { kind: "runtime_error", reason: `claude -p exited with ${exit} and ${what}${stderr ? `: ${stderr}` : ""}`, raw: outcome };
}

function loginFailure(result: SDKResultMessage): AgentFailure | undefined {
  const text = result.subtype === "success" ? result.result : (result.errors ?? []).join("\n");
  if (!result.is_error || !LOGIN_FAILURE.test(text)) return undefined;
  return { kind: "auth_misconfigured", reason: text, hint: "run `claude` once interactively and /login", raw: result };
}

/** The CLI validated against the JSON Schema already; the zod parse makes the value the one TypeScript promises. */
function readOutput<T>(result: SDKResultMessage, config: AgentRunConfig<T>): { value: T } | { failure: AgentFailure } {
  const text = result.subtype === "success" ? result.result : "";
  if (!config.outputSchema) return { value: text as T };
  const raw: unknown = (result.subtype === "success" ? result.structured_output : undefined) ?? parseJson(text);
  const parsed = config.outputSchema.safeParse(raw);
  if (parsed.success) return { value: parsed.data };
  return { failure: { kind: "schema_invalid", reason: "structured output did not match the supplied schema", error: parsed.error, raw } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `--output-format json` carries no init message, so only the model is known, from `modelUsage`. */
function initFrom(result: SDKResultMessage): AgentInit {
  const models = Object.keys(result.modelUsage ?? {});
  return { apiKeySource: undefined, model: models.length === 1 ? models[0] : undefined, tools: [], permissionMode: undefined, claudeCodeVersion: undefined };
}

function aborted(signal: AbortSignal | undefined): AgentFailure {
  return { kind: "aborted", reason: String(signal?.reason ?? "aborted by caller") };
}
