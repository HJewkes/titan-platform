import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { AccountProfile } from "../profile.js";
import type { NativeQuotaProcessInput } from "./native-transport.js";

export { createNativeQuotaWorkspace, type NativeQuotaWorkspace } from "./native-workspace.js";

const ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR",
  "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
export function nativeEnvironment(profile: AccountProfile, source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && ENV_KEYS.has(key)) env[key] = value;
  env.CODEX_HOME = profile.codeHome;
  return env;
}
export async function resolveNativeExecutable(executable: string, env: Record<string, string>): Promise<string> {
  const candidates = isAbsolute(executable) ? [executable] : executable === "codex" ?
    (env.PATH ?? "").split(delimiter).filter(isAbsolute).map(directory => join(directory, process.platform === "win32" ? "codex.exe" : "codex")) : [];
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK); return path;
    } catch { /* Try only explicit absolute PATH entries, never a default home. */ }
  }
  throw new Error("native quota executable unavailable");
}
export function nativeVersionSupported(output: string): boolean {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(output);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major > 0 || minor > 162 || minor === 162 && (patch > 1 || patch === 1 && !match[4]);
}
export function inspectNativeVersion(input: NativeQuotaProcessInput): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(input.executablePath, ["--version"], { cwd: input.cwd, env: input.env, signal: input.signal,
      encoding: "utf8", maxBuffer: 4096, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) reject(new Error("native quota version failed")); else resolve(stdout);
    });
  });
}
