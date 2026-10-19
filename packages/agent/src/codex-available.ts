import { isAbsolute } from "node:path";
import { inspectCodexVersion, type CodexVersionInspectionOptions } from "./codex-process.js";
import { checkCodexVersion, checkCodexCapabilities, inspectCodexCapabilities,
  type CodexCapabilityInspectionOptions, type CodexRuntimeCapability, type CodexRuntimeInspection } from "./codex-runtime.js";
import type { HarnessRunFailure } from "./harness-contracts.js";

export const DEFAULT_CODEX_EXECUTABLE = "codex";
export interface CodexAvailabilityOptions {
  executablePath?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  resume?: boolean;
  sandbox?: string;
  requiredCapabilities?: readonly CodexRuntimeCapability[];
}
export interface CodexAvailabilityDeps {
  inspectVersion?: (path: string, env: Record<string, string>, options: CodexVersionInspectionOptions) => Promise<string>;
  inspectCapabilities?: (path: string, env: Record<string, string>, options: CodexCapabilityInspectionOptions) => Promise<CodexRuntimeInspection>;
}
export type CodexAvailability =
  | { ok: true; executablePath: string; versionOutput: string; inspection: CodexRuntimeInspection }
  | { ok: false; failure: HarnessRunFailure };

export function resolveCodexExecutable(override?: string): string {
  if (override !== undefined && (!isAbsolute(override) || !override.trim() || override.includes("\0"))) {
    throw new TypeError("executablePath must be an absolute path");
  }
  return override ?? DEFAULT_CODEX_EXECUTABLE;
}

/** Model-free runtime admission only; cached login and policy enforcement are separate. */
export async function checkCodexAvailable(options: CodexAvailabilityOptions = {}, deps: CodexAvailabilityDeps = {}): Promise<CodexAvailability> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, failure: { kind: "wall_time_exceeded", reason: "Codex availability deadline exhausted", wallTimeMs: timeoutMs } };
  const deadline = performance.now() + timeoutMs;
  let phase = "Codex CLI version";
  try {
    const executablePath = resolveCodexExecutable(options.executablePath);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[key] = value;
    const versionOutput = await (deps.inspectVersion ?? inspectCodexVersion)(executablePath, env, { signal: options.signal, timeoutMs });
    const versionFailure = checkCodexVersion(versionOutput);
    if (versionFailure) return { ok: false, failure: versionFailure };
    phase = "Codex runtime capabilities";
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Object.assign(new Error("deadline exhausted"), { code: "ETIMEDOUT" });
    const inspection = await (deps.inspectCapabilities ?? inspectCodexCapabilities)(executablePath, env, {
      signal: options.signal, timeoutMs: remaining, resume: options.resume ?? false,
    });
    const required: CodexRuntimeCapability[] = ["json_events", "config_overrides", "user_config_isolation", "strict_config", "model_selection",
      ...(!options.resume ? ["working_directory" as const] : []), ...(options.requiredCapabilities ?? [])];
    const failure = checkCodexCapabilities(inspection, options.sandbox ?? "read-only", required);
    return failure ? { ok: false, failure } : { ok: true, executablePath, versionOutput, inspection };
  } catch (error) { return { ok: false, failure: probeFailure(error, options, phase) }; }
}

function probeFailure(error: unknown, options: CodexAvailabilityOptions, phase: string): HarnessRunFailure {
  if (options.signal?.aborted) return { kind: "aborted", reason: "Codex availability check aborted" };
  if (typeof error === "object" && error !== null &&
      (("code" in error && error.code === "ETIMEDOUT") || ("killed" in error && error.killed === true && "signal" in error && error.signal === "SIGKILL"))) {
    return { kind: "wall_time_exceeded", wallTimeMs: options.timeoutMs ?? 5000, reason: "Codex availability deadline exceeded" };
  }
  return { kind: "runtime_error", reason: `could not verify ${phase}: ${error instanceof Error ? error.message : String(error)}`, native: error };
}
