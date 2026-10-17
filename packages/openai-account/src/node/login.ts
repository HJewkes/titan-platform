import { execFile } from "node:child_process";
import { loginStateFromStatus, type LoginState, type LoginStatusOutput } from "../login.js";
import type { AccountProfile } from "../profile.js";
import { validateProfile } from "./profile.js";

export interface LoginProbeInput {
  executablePath: string;
  args: readonly ["login", "status"];
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface ReadLoginOptions {
  executablePath?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  runStatus?: (input: LoginProbeInput) => Promise<LoginStatusOutput>;
}

function probe(input: LoginProbeInput): Promise<LoginStatusOutput> {
  return new Promise((resolve, reject) => {
    execFile(input.executablePath, [...input.args], {
      env: input.env, timeout: input.timeoutMs, signal: input.signal,
      encoding: "utf8", maxBuffer: 16 * 1024, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== "number" || error.killed || error.signal)) reject(new Error("login status probe failed"));
      else resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

function environment(profile: AccountProfile, source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_HOME"].includes(key)) env[key] = value;
  }
  env.CODEX_HOME = profile.codeHome;
  return env;
}

/** Model-free login status only. No auth-file reads, provisioning, login or fallback. */
export async function readLoginState(profile: AccountProfile, options: ReadLoginOptions = {}): Promise<LoginState> {
  validateProfile(profile);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError("timeoutMs must be between 1 and 60000");
  try {
    const output = await (options.runStatus ?? probe)({ executablePath: options.executablePath ?? "codex",
      args: ["login", "status"], env: environment(profile, options.env ?? process.env), timeoutMs, signal: options.signal });
    return loginStateFromStatus(output);
  } catch { return { status: "refused", reason: "probe-failed" }; }
}
