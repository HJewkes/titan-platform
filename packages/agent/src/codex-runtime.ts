import { execFile } from "node:child_process";
import type { CodexVersionInspectionOptions } from "./codex-process.js";
import type { HarnessRunFailure } from "./harness-contracts.js";

export const MIN_CODEX_EXEC_VERSION = "0.162.1";
export const CODEX_RUNTIME_CAPABILITIES = [
  "json_events", "config_overrides", "user_config_isolation", "strict_config",
  "output_schema", "model_selection", "working_directory", "mcp_config", "tool_policy", "rollout_rate_limits",
] as const;
export type CodexRuntimeCapability = (typeof CODEX_RUNTIME_CAPABILITIES)[number];

/** Only explicit true is evidence. Missing/unknown capabilities fail a requirement. */
export interface CodexRuntimeInspection {
  capabilities: Partial<Record<CodexRuntimeCapability, boolean>>;
  sandboxes: readonly string[];
}

export interface CodexCapabilityInspectionOptions extends CodexVersionInspectionOptions {
  resume: boolean;
}

export function checkCodexVersion(output: string): HarnessRunFailure | undefined {
  const match = /^codex-cli\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(output.trim());
  const version = match?.[1];
  if (!version || !validVersion(version)) return failure("unrecognized Codex CLI version output");
  const [core, prerelease] = version.split("+")[0]!.split("-");
  const parts = core!.split(".").map(Number);
  const minimum = MIN_CODEX_EXEC_VERSION.split(".").map(Number);
  const difference = parts.map((value, index) => value - minimum[index]!).find(value => value !== 0) ?? 0;
  if (difference > 0 || (difference === 0 && prerelease === undefined)) return undefined;
  return failure(`unsupported Codex CLI version ${version}; requires >=${MIN_CODEX_EXEC_VERSION}`);
}

function validVersion(version: string): boolean {
  const [main, metadata] = version.split("+");
  const hyphen = main!.indexOf("-");
  const core = hyphen < 0 ? main! : main!.slice(0, hyphen);
  if (!core.split(".").every(value => Number.isSafeInteger(Number(value)))) return false;
  const prerelease = hyphen < 0 ? undefined : main!.slice(hyphen + 1);
  if (prerelease?.split(".").some(value => !value || (/^\d+$/.test(value) && value.length > 1 && value.startsWith("0")))) return false;
  return metadata === undefined || metadata.split(".").every(Boolean);
}

export function checkCodexCapabilities(
  inspection: CodexRuntimeInspection,
  sandbox: string,
  required: readonly CodexRuntimeCapability[],
): HarnessRunFailure | undefined {
  if (!Array.isArray(inspection.sandboxes) || !inspection.sandboxes.includes(sandbox)) {
    return failure(`Codex runtime preflight cannot verify sandbox ${sandbox}`);
  }
  for (const capability of required) {
    if (inspection.capabilities[capability] !== true) {
      return failure(`Codex runtime preflight cannot verify required capability ${capability}`);
    }
  }
  return undefined;
}

/** Model-free surface probe; it never starts a turn, app-server, or MCP server. */
export async function inspectCodexCapabilities(
  executablePath: string,
  env: Record<string, string>,
  options: CodexCapabilityInspectionOptions,
): Promise<CodexRuntimeInspection> {
  const args = options.resume ? ["exec", "resume", "--help"] : ["exec", "--help"];
  const help = await new Promise<string>((resolve, reject) => {
    execFile(executablePath, args, {
      env, encoding: "utf8", signal: options.signal, maxBuffer: 256 * 1024,
      timeout: Math.max(1, Math.ceil(options.timeoutMs)), killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  return codexCapabilitiesFromHelp(help);
}

export function codexCapabilitiesFromHelp(help: string): CodexRuntimeInspection {
  const flag = (name: string) => optionBlock(help, name) !== undefined;
  // An exec help page cannot establish MCP configuration, hook coverage or a rollout codec.
  // Those requirements need their own trusted probe, never a version-number inference.
  const sandbox = optionBlock(help, "sandbox") ?? "";
  const values = /\[possible values: ([^\]]+)\]/.exec(sandbox)?.[1]?.split(",").map(value => value.trim()) ?? [];
  return {
    capabilities: {
      json_events: flag("json"), config_overrides: flag("config"),
      user_config_isolation: flag("ignore-user-config"), strict_config: flag("strict-config"),
      output_schema: flag("output-schema"),
      model_selection: flag("model"), working_directory: flag("cd"),
    },
    sandboxes: values.filter(value => ["read-only", "workspace-write", "danger-full-access"].includes(value)),
  };
}

function optionBlock(help: string, name: string): string | undefined {
  const lines = help.split(/\r?\n/);
  const pattern = new RegExp(`^[ \\t]*(?:-\\w,[ \\t]*)?--${name}(?:[ \\t=<]|$)`);
  const start = lines.findIndex(line => pattern.test(line));
  if (start < 0) return undefined;
  const next = lines.slice(start + 1).findIndex(line => /^[ \t]*(?:-\w,[ \t]*)?--[\w-]+/.test(line));
  return lines.slice(start, next < 0 ? undefined : start + next + 1).join("\n");
}

function failure(reason: string): HarnessRunFailure {
  return { kind: "runtime_error", reason };
}
