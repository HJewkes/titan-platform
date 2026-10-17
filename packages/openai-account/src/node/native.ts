import { isAbsolute, normalize } from "node:path";
import { nativeRecord, usageFromNativeResponse } from "../native-usage.js";
import type { AccountProfile } from "../profile.js";
import { MAX_READING_AGE_SECONDS, quotaAdmission, type UsageResult } from "../usage.js";
import { createNativeQuotaWorkspace, type NativeQuotaWorkspace, inspectNativeVersion, nativeEnvironment, nativeVersionSupported, resolveNativeExecutable } from "./native-process.js";
import { connectNativeQuota, type ConnectNativeQuota, type NativeQuotaConnection, type NativeQuotaProcessInput } from "./native-transport.js";
import { validateProfile } from "./profile.js";

export interface ReadNativeUsageOptions {
  /** Nonsecret account binding from the caller account authority; never infer from label/email. */
  expectedAccountId: string;
  executablePath?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  createWorkspace?: () => Promise<NativeQuotaWorkspace>;
  resolveExecutable?: (executable: string, env: Record<string, string>) => Promise<string>;
  inspectVersion?: (input: NativeQuotaProcessInput) => Promise<string>;
  connect?: ConnectNativeQuota;
  now?: () => number;
  monotonicNow?: () => number;
}
function chatgpt(value: unknown): boolean {
  return nativeRecord(value) && nativeRecord(value.account) && value.account.type === "chatgpt";
}
const unknown = (): UsageResult => ({ status: "unknown", reason: "unreadable" });
function deadline(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController(); const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  const cancelled = new Promise<UsageResult>(resolve => {
    if (controller.signal.aborted) resolve(unknown());
    else controller.signal.addEventListener("abort", () => resolve(unknown()), { once: true });
  });
  return { signal: controller.signal, cancelled, dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}
async function fetchQuota(
  connection: NativeQuotaConnection, profile: AccountProfile, options: ReadNativeUsageOptions, signal: AbortSignal, generation: () => number,
): Promise<UsageResult> {
  const aborted = () => signal.aborted;
  const before = generation();
  const now = options.now ?? (() => Date.now() / 1000);
  const monotonic = options.monotonicNow ?? (() => performance.now() / 1000);
  const startedAt = now(); const startedMono = monotonic();
  const response = await connection.request("account/rateLimits/read", { supportsLunaReserve: false, excludeResetCreditDetails: true });
  if (aborted() || !chatgpt(await connection.request("account/read", { refreshToken: false })) || generation() !== before) return unknown();
  const elapsed = monotonic() - startedMono; const finishedAt = now();
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_READING_AGE_SECONDS || !Number.isFinite(finishedAt) ||
      Math.abs(finishedAt - startedAt - elapsed) > 1 || aborted()) return unknown();
  const result = usageFromNativeResponse(response, { account: profile.label, expectedAccountId: options.expectedAccountId, startedAt });
  const admission = quotaAdmission(result, finishedAt);
  return !admission.allowed && admission.reason !== "weekly-reserve" && admission.reason !== "five-hour-ceiling" ?
    (result.status === "known" ? { status: "unknown", reason: "inconsistent" } : result) : result;
}
async function readProtocol(
  profile: AccountProfile, options: ReadNativeUsageOptions, signal: AbortSignal, cwd: string, opened: (connection: NativeQuotaConnection) => void,
): Promise<UsageResult> {
  const aborted = () => signal.aborted;
  if (aborted()) return unknown();
  const env = nativeEnvironment(profile, options.env ?? process.env);
  const executablePath = await (options.resolveExecutable ?? resolveNativeExecutable)(options.executablePath ?? "codex", env);
  if (aborted() || !isAbsolute(executablePath)) return unknown();
  const input = { executablePath, cwd, env, signal };
  if (!nativeVersionSupported(await (options.inspectVersion ?? inspectNativeVersion)(input)) || aborted()) return unknown();
  let generation = 0;
  const connection = (options.connect ?? connectNativeQuota)(input, () => { generation++; }); opened(connection);
  const initialized = await connection.request("initialize", { clientInfo: { name: "titan_openai_account", version: "1" }, capabilities: { experimentalApi: false } });
  if (aborted() || !nativeRecord(initialized) || typeof initialized.userAgent !== "string" || !initialized.userAgent ||
      typeof initialized.codexHome !== "string" || normalize(initialized.codexHome) !== normalize(profile.codeHome)) return unknown();
  connection.initialized();
  if (!chatgpt(await connection.request("account/read", { refreshToken: false })) || aborted()) return unknown();
  return fetchQuota(connection, profile, options, signal, () => generation);
}

/** Opt-in native backend fetch. Native may refresh its own credentials; no login or model operation is requested. */
export async function readNativeUsage(profile: AccountProfile, options: ReadNativeUsageOptions): Promise<UsageResult> {
  validateProfile(profile);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError("timeoutMs must be between 1 and 60000");
  if (typeof options.expectedAccountId !== "string" || !options.expectedAccountId.trim() || options.expectedAccountId.length > 256) return { status: "unknown", reason: "inconsistent" };
  const bound = deadline(timeoutMs, options.signal); const aborted = () => bound.signal.aborted;
  let connection: NativeQuotaConnection | undefined; let workspace: NativeQuotaWorkspace | undefined; let result = unknown();
  const run = async (): Promise<UsageResult> => {
    if (aborted()) return unknown();
    const created = await (options.createWorkspace ?? createNativeQuotaWorkspace)();
    if (aborted()) { await created.dispose(); return unknown(); }
    workspace = created;
    if (!isAbsolute(created.cwd)) return unknown();
    return readProtocol(profile, options, bound.signal, created.cwd, value => { connection = value; });
  };
  try { result = await Promise.race([run(), bound.cancelled]); }
  catch { result = unknown(); }
  finally {
    bound.dispose(); try { connection?.close(); } catch { /* Native teardown errors never escape. */ }
    try { await workspace?.dispose(); } catch { result = unknown(); }
  }
  return result;
}
