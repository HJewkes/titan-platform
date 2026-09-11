import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { runCodexExecSession } from "./codex-exec-session.js";
import {
  createCodexSchemaFile,
  inspectCodexVersion,
  startCodexProcess,
  type CodexProcessInput,
  type CodexSchemaFile,
  type SupervisedCodexProcess,
  type CodexVersionInspectionOptions,
} from "./codex-process.js";
import { EXECUTION_CAPABILITIES } from "./harness-contracts.js";
import type {
  CapabilityAssessment,
  CodexRunRequest,
  HarnessAdapter,
  HarnessCapabilityDescriptor,
  HarnessRunFailure,
  HarnessRunResult,
  LimitCapability,
} from "./harness-contracts.js";
import { preflightHarnessRun } from "./preflight.js";

export const DEFAULT_CODEX_EXECUTABLE = "/Applications/ChatGPT.app/Contents/Resources/codex";
export const SUPPORTED_CODEX_EXEC_VERSION = "0.154.0-alpha.6.1";
export const STRIPPED_CODEX_AUTH_VARS = ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"] as const;

export interface CodexExecAdapterOptions {
  auth: "cached-cli";
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}

export interface CodexExecDeps {
  inspectVersion?: (
    executablePath: string,
    env: Record<string, string>,
    options: CodexVersionInspectionOptions,
  ) => Promise<string>;
  start?: (input: CodexProcessInput) => SupervisedCodexProcess;
  createSchemaFile?: (schema: Record<string, unknown>) => Promise<CodexSchemaFile>;
  executionId?: () => string;
  now?: () => number;
  deadlineNow?: () => number;
}

export function createCodexExecAdapter(
  options: CodexExecAdapterOptions,
  deps: CodexExecDeps = {},
): HarnessAdapter<"codex"> {
  validateOptions(options);
  const executablePath = options.executablePath ?? DEFAULT_CODEX_EXECUTABLE;
  const env = prepareCodexEnv(options.env ?? process.env);
  const descriptor = codexExecCapabilities();
  return {
    descriptor,
    async run<T>(request: CodexRunRequest<T>): Promise<HarnessRunResult<T, "codex">> {
      const preflight = preflightHarnessRun(request, descriptor);
      if (preflight) return failed(preflight);
      const invalid = validateAdapterRequest(request);
      if (invalid) return failed(invalid);
      try {
        return await runSupervised(request, { executablePath, env, killGraceMs: options.killGraceMs }, deps);
      } catch (error) {
        return failed({ kind: "runtime_error", reason: messageOf(error), native: error });
      }
    },
  };
}

export function prepareCodexEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const prepared: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !(STRIPPED_CODEX_AUTH_VARS as readonly string[]).includes(name)) prepared[name] = value;
  }
  return prepared;
}

export function codexExecCapabilities(): HarnessCapabilityDescriptor<"codex"> {
  const supported = (evidence: string): CapabilityAssessment => ({ status: "supported", evidence });
  const unsupported = (reason: string): CapabilityAssessment => ({ status: "unsupported", reason });
  const capabilities = Object.fromEntries(
    EXECUTION_CAPABILITIES.map((capability) => [
      capability,
      unsupported("not implemented by the supervised exec adapter"),
    ]),
  ) as HarnessCapabilityDescriptor<"codex">["capabilities"];
  capabilities.fresh_run = supported("codex exec starts a persisted thread");
  capabilities.resume = supported("codex exec resume uses an explicit native thread ID");
  capabilities.structured_output = supported("native output schema plus caller parser validation");
  capabilities.external_cancellation = supported("owned local process group receives termination signals");
  capabilities.persisted_transcript = supported("adapter never passes --ephemeral");
  capabilities.token_reporting = supported("turn.completed usage is normalized with source provenance");
  const limits = limitCapabilities(supported, unsupported);
  return {
    harness: "codex",
    adapter: { name: "codex-exec-json", version: SUPPORTED_CODEX_EXEC_VERSION },
    capabilities,
    limits,
  };
}

function limitCapabilities(
  supported: (evidence: string) => CapabilityAssessment,
  unsupported: (reason: string) => CapabilityAssessment,
): LimitCapability[] {
  const limits: LimitCapability[] = [
    {
      unit: "milliseconds",
      scope: "execution",
      enforcement: "hard",
      assessment: supported("local process deadline"),
    },
  ];
  for (const unit of ["usd", "model_requests", "agent_iterations", "tokens"] as const) {
    for (const scope of ["execution", "conversation"] as const) {
      limits.push({
        unit,
        scope,
        enforcement: "hard",
        assessment: unsupported("codex exec has no verified hard cap in this unit"),
      });
    }
  }
  return limits;
}

function validateOptions(options: CodexExecAdapterOptions): void {
  if (options.auth !== "cached-cli") throw new TypeError("Codex exec adapter supports only cached-cli authentication");
  if (options.executablePath !== undefined) {
    if (options.executablePath.trim().length === 0) throw new TypeError("executablePath must be a nonempty string");
    if (!isAbsolute(options.executablePath)) throw new TypeError("executablePath must be absolute");
  }
  if (options.killGraceMs !== undefined && (!Number.isFinite(options.killGraceMs) || options.killGraceMs < 0)) {
    throw new TypeError("killGraceMs must be a finite nonnegative number");
  }
}

function validateAdapterRequest<T>(request: CodexRunRequest<T>): HarnessRunFailure | undefined {
  if (!request.prompt.trim()) return { kind: "invalid_request", reason: "Codex exec requires a nonempty prompt" };
  if (!isAbsolute(request.cwd)) return { kind: "invalid_request", reason: "Codex exec requires an absolute cwd" };
  if (!request.native?.model) return { kind: "invalid_request", reason: "Codex exec requires an explicit model" };
  if (request.native.approvalPolicy && request.native.approvalPolicy !== "never") {
    return { kind: "invalid_request", reason: "Codex exec supports only the noninteractive never approval policy" };
  }
  return undefined;
}

async function checkVersion(
  inspect: () => Promise<string>,
  expected: string,
): Promise<HarnessRunFailure | undefined> {
  try {
    const actual = parseVersion(await inspect());
    if (actual === expected) return undefined;
    return { kind: "runtime_error", reason: `unsupported Codex CLI version ${actual}; expected ${expected}` };
  } catch (error) {
    const reason = `could not verify Codex CLI version: ${messageOf(error)}`;
    return { kind: "runtime_error", reason, native: error };
  }
}

function parseVersion(output: string): string {
  const match = /^codex-cli\s+(\S+)/m.exec(output.trim());
  if (!match?.[1]) throw new Error(`unrecognized version output: ${output.trim()}`);
  return match[1];
}

async function runSupervised<T>(
  request: CodexRunRequest<T>,
  config: {
    executablePath: string;
    env: Record<string, string>;
    killGraceMs?: number;
  },
  deps: CodexExecDeps,
): Promise<HarnessRunResult<T, "codex">> {
  const deadlineNow = deps.deadlineNow ?? performance.now.bind(performance);
  const startedAt = deadlineNow();
  const remaining = () => Math.max(0, request.wallTimeMs - (deadlineNow() - startedAt));
  let schemaFile: CodexSchemaFile | undefined;
  try {
    const versionOutput = await setupStep(
      (deps.inspectVersion ?? inspectCodexVersion)(config.executablePath, config.env, {
        signal: request.signal,
        timeoutMs: remaining(),
      }),
      request.signal,
      remaining(),
    );
    const versionFailure = await checkVersion(async () => versionOutput, SUPPORTED_CODEX_EXEC_VERSION);
    if (versionFailure) return failed(versionFailure);

    if (request.native?.outputSchema) {
      schemaFile = await setupStep(
        (deps.createSchemaFile ?? createCodexSchemaFile)(request.native.outputSchema.jsonSchema),
        request.signal,
        remaining(),
        (lateFile) => lateFile.dispose(),
      );
    }

    if (request.signal?.aborted) return failed(abortFailure(request.signal));
    const processWallTimeMs = remaining();
    if (processWallTimeMs <= 0) return failed(timeoutFailure(request.wallTimeMs));
    const input = {
      executablePath: config.executablePath,
      args: buildCodexExecArgs(request, schemaFile?.path),
      cwd: request.cwd,
      env: config.env,
    };
    const executionId = (deps.executionId ?? randomUUID)();
    const processHandle = (deps.start ?? startCodexProcess)(input);
    const cleanup = async () => {
      const file = schemaFile;
      schemaFile = undefined;
      await file?.dispose();
    };
    return await runCodexExecSession(
      request,
      processHandle,
      executionId,
      deps.now ?? Date.now,
      config.killGraceMs,
      processWallTimeMs,
      cleanup,
    );
  } catch (error) {
    if (request.signal?.aborted) return failed(abortFailure(request.signal));
    if (error instanceof SetupTimeoutError || isProcessTimeout(error)) {
      return failed(timeoutFailure(request.wallTimeMs));
    }
    return failed({ kind: "runtime_error", reason: messageOf(error), native: error });
  } finally {
    await schemaFile?.dispose();
  }
}

export function buildCodexExecArgs<T>(request: CodexRunRequest<T>, schemaPath?: string): string[] {
  const native = request.native!;
  const args = ["exec"];
  if (request.target.kind === "resume") args.push("resume");
  args.push("--json", "--strict-config", "--ignore-user-config", "--model", native.model!);
  args.push("--config", `approval_policy=${JSON.stringify(native.approvalPolicy ?? "never")}`);
  args.push("--config", `sandbox_mode=${JSON.stringify(native.sandbox ?? "read-only")}`);
  if (native.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(native.reasoningEffort)}`);
  }
  if (request.target.kind === "fresh") args.push("--cd", request.cwd);
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (request.target.kind === "resume") args.push(request.target.conversation.nativeId);
  args.push("--", request.prompt);
  return args;
}

function failed<T>(failure: HarnessRunFailure): HarnessRunResult<T, "codex"> {
  return { ok: false, harness: "codex", failure, usage: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutFailure(wallTimeMs: number): HarnessRunFailure {
  return { kind: "wall_time_exceeded", reason: "Codex execution exceeded its wall deadline", wallTimeMs };
}

function abortFailure(signal: AbortSignal): HarnessRunFailure {
  return { kind: "aborted", reason: String(signal.reason ?? "aborted by caller") };
}

class SetupTimeoutError extends Error {}

function setupStep<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  disposeLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
      return true;
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error("aborted by caller")));
    const timer = setTimeout(
      () => finish(() => reject(new SetupTimeoutError("Codex setup exceeded its wall deadline"))),
      Math.max(0, timeoutMs),
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    work.then(
      (value) => {
        if (!finish(() => resolve(value)) && disposeLateValue) {
          void Promise.resolve(disposeLateValue(value)).catch(() => undefined);
        }
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function isProcessTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return value.code === "ETIMEDOUT" || (value.killed === true && value.signal === "SIGKILL");
}
