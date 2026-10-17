import { describe, expect, it, vi } from "vitest";
import type { NativeQuotaWorkspace } from "./native-process.js";
import { readNativeUsage } from "./native.js";
import type { NativeQuotaConnection, NativeQuotaMethod, NativeQuotaProcessInput } from "./native-transport.js";

const now = 1_800_000_000;
const profile = { codeHome: "/fixture/code-home", label: "reporter" };
function quota(week = 20) {
  const bucket = { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: now + 5000 },
    secondary: { usedPercent: week, windowDurationMins: 10080, resetsAt: now + 6000 } };
  return { accountId: "workspace-test", ordinaryUsageAllowed: true, rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } };
}
function fixture(change: Partial<Record<NativeQuotaMethod, unknown>> = {}) {
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  let changed = () => {};
  const request = vi.fn(async (method: NativeQuotaMethod, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method in change) return change[method];
    if (method === "initialize") return { codexHome: profile.codeHome, userAgent: "codex_cli_rs/0.162.1" };
    if (method === "account/read") return { account: { type: "chatgpt", email: "private@example.test" } };
    return quota();
  });
  const close = vi.fn();
  const connect = vi.fn((_input: NativeQuotaProcessInput, accountChanged: () => void): NativeQuotaConnection => {
    changed = accountChanged;
    return { request, initialized: () => { requests.push({ method: "initialized" }); }, close };
  });
  const disposeWorkspace = vi.fn(async () => {});
  const createWorkspace = vi.fn(async (): Promise<NativeQuotaWorkspace> => ({ cwd: "/fixture/empty-workspace", dispose: disposeWorkspace }));
  const options = { createWorkspace, resolveExecutable: vi.fn(async () => "/fixture/bin/codex"), expectedAccountId: "workspace-test", inspectVersion: vi.fn(async (_input: NativeQuotaProcessInput) => "codex-cli 0.162.1\n"), connect,
    now: () => now, monotonicNow: () => 100 };
  return { options, request, close, connect, requests, disposeWorkspace, changeAccount: () => changed() };
}

describe("opt-in native quota reader", () => {
  it("uses only version/account read capabilities with explicit home and no API-key fallback", async () => {
    const f = fixture();
    const result = await readNativeUsage(profile, { ...f.options, env: { PATH: "/fixture/bin", CODEX_HOME: "/wrong",
      OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", OPENAI_ACCESS_TOKEN: "secret", OPENAI_BASE_URL: "https://provider.invalid", ANTHROPIC_API_KEY: "secret", CLAUDE_CONFIG_DIR: "/wrong", AGENT_CHAT_SOCKET: "/wrong", NODE_OPTIONS: "secret", LD_PRELOAD: "secret" } });
    expect(result).toMatchObject({ status: "known", reading: { written_at: now, account: "reporter" } });
    expect(f.requests.map(r => r.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read", "account/read"]);
    expect(f.requests[3]?.params).toEqual({ supportsLunaReserve: false, excludeResetCreditDetails: true });
    expect(f.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }, { refreshToken: false }]);
    expect(f.connect.mock.calls[0]?.[0].env).toEqual({ PATH: "/fixture/bin", CODEX_HOME: profile.codeHome });
    expect(f.options.resolveExecutable).toHaveBeenCalledOnce();
    expect(f.connect.mock.calls[0]?.[0].executablePath).toBe("/fixture/bin/codex");
    expect(f.options.inspectVersion.mock.calls[0]?.[0]).toEqual(f.connect.mock.calls[0]?.[0]);
    expect(f.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/private|workspace-test|secret/);
  });
  it("uses the same isolated empty workspace for version and app-server and always cleans it", async () => {
    const f = fixture();
    expect((await readNativeUsage(profile, f.options)).status).toBe("known");
    expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ cwd: "/fixture/empty-workspace" });
    expect(f.options.inspectVersion.mock.calls[0]?.[0]).toEqual(f.connect.mock.calls[0]?.[0]);
    expect(f.disposeWorkspace).toHaveBeenCalledOnce();
  });
  it.each(["codex-cli 0.162.1", "codex-cli 0.163.0", "codex-cli 1.0.0", "codex-cli 0.170.0-alpha.1"]) ("supports floor and newer version %s after preflight", async version => {
    const f = fixture(); f.options.inspectVersion.mockResolvedValue(version);
    expect((await readNativeUsage(profile, f.options)).status).toBe("known");
  });
  it.each(["codex-cli 0.162.0", "codex-cli 0.162.1-alpha.1", "codex-cli 0.161.99", "unknown", "0.163.0"]) ("refuses unsupported version %s", async version => {
    const f = fixture(); f.options.inspectVersion.mockResolvedValue(version);
    expect((await readNativeUsage(profile, f.options)).status).toBe("unknown"); expect(f.connect).not.toHaveBeenCalled(); expect(f.disposeWorkspace).toHaveBeenCalledOnce();
  });
  it("counts request duration from start, including final account validation", async () => {
    const f = fixture(); let calls = 0; let mono = 0;
    const result = await readNativeUsage(profile, { ...f.options, now: () => now + calls++ * 200, monotonicNow: () => mono++ * 200 });
    expect(result).toMatchObject({ reading: { written_at: now } });
  });
  it("refuses clock drift, backward time, and stale or expired responses", async () => {
    for (const [wall, elapsed] of [[1, 10], [-1, 0], [901, 901], [6000, 6000]] as const) {
      const f = fixture(); let w = 0; let m = 0;
      expect((await readNativeUsage(profile, { ...f.options, now: () => now + w++ * wall, monotonicNow: () => m++ * elapsed })).status).toBe("unknown");
    }
  });
  it("does not rejuvenate a prior success when the next backend read fails", async () => {
    const f = fixture(); expect((await readNativeUsage(profile, f.options)).status).toBe("known");
    f.request.mockImplementation(async () => { throw new Error("private sk-proj-not-a-real-key"); });
    expect(await readNativeUsage(profile, f.options)).toEqual({ status: "unknown", reason: "unreadable" });
  });
  it.each([null, {}, { codexHome: "/other-home", userAgent: "codex" }])("refuses missing or mismatched initialize capability %s", async initialized => {
    const f = fixture({ initialize: initialized });
    expect((await readNativeUsage(profile, f.options)).status).toBe("unknown"); expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([{ account: { type: "apiKey" } }, { account: null }, null]) ("refuses non-ChatGPT or missing account %s", async account => {
    const f = fixture({ "account/read": account }); expect((await readNativeUsage(profile, f.options)).status).toBe("unknown");
  });
  it("refuses identity change during a matching successful quota response", async () => {
    const f = fixture(); const original = f.request.getMockImplementation();
    f.request.mockImplementation(async (method, params) => {
      const result = await original?.(method, params);
      if (method === "account/rateLimits/read") f.changeAccount();
      return result;
    });
    expect((await readNativeUsage(profile, f.options)).status).toBe("unknown");
  });
  it("refuses invalidation arriving with the final account reply", async () => {
    const f = fixture(); let reads = 0; const original = f.request.getMockImplementation();
    f.request.mockImplementation(async (method, params) => {
      const result = await original?.(method, params);
      if (method === "account/read" && ++reads === 2) f.changeAccount();
      return result;
    });
    expect((await readNativeUsage(profile, f.options)).status).toBe("unknown");
  });
  it("requires explicit binding before opening any native process", async () => {
    const f = fixture();
    expect((await readNativeUsage(profile, { ...f.options, expectedAccountId: "" })).status).toBe("unknown");
    expect(f.options.inspectVersion).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it("aborts hung injected work, closes owned connection and never opens a late process", async () => {
    const f = fixture(); f.request.mockImplementation(() => new Promise(() => {}));
    expect((await readNativeUsage(profile, { ...f.options, timeoutMs: 5 })).status).toBe("unknown");
    expect(f.close).toHaveBeenCalledOnce(); expect(f.disposeWorkspace).toHaveBeenCalledOnce();
    const late = fixture(); let resolve: ((s: string) => void) | undefined;
    late.options.inspectVersion.mockImplementation(() => new Promise(done => { resolve = done; }));
    expect((await readNativeUsage(profile, { ...late.options, timeoutMs: 5 })).status).toBe("unknown");
    resolve?.("codex-cli 0.162.1"); await Promise.resolve(); await Promise.resolve();
    expect(late.connect).not.toHaveBeenCalled();
  });
  it("cleans a workspace created after cancellation and refuses invalid workspace factories", async () => {
    const f = fixture(); let resolve: ((value: { cwd: string; dispose(): Promise<void> }) => void) | undefined;
    f.options.createWorkspace.mockImplementation(() => new Promise(done => { resolve = done; }));
    expect((await readNativeUsage(profile, { ...f.options, timeoutMs: 5 })).status).toBe("unknown");
    resolve?.({ cwd: "/fixture/late-empty", dispose: f.disposeWorkspace });
    await Promise.resolve(); await Promise.resolve(); expect(f.disposeWorkspace).toHaveBeenCalledOnce();
    expect(f.options.resolveExecutable).not.toHaveBeenCalled();
    const invalid = fixture(); invalid.options.createWorkspace.mockResolvedValue({ cwd: "relative", dispose: invalid.disposeWorkspace });
    expect((await readNativeUsage(profile, invalid.options)).status).toBe("unknown"); expect(invalid.disposeWorkspace).toHaveBeenCalledOnce();
    const broken = fixture(); broken.options.createWorkspace.mockRejectedValue(new Error("private-path"));
    expect(await readNativeUsage(profile, broken.options)).toEqual({ status: "unknown", reason: "unreadable" });
  });
  it("refuses an already aborted call and invalid timeout without real processes", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect((await readNativeUsage(profile, { ...f.options, signal: controller.signal })).status).toBe("unknown");
    expect(f.options.inspectVersion).not.toHaveBeenCalled(); expect(f.options.createWorkspace).not.toHaveBeenCalled();
    await expect(readNativeUsage(profile, { ...f.options, timeoutMs: 0 })).rejects.toThrow(RangeError);
  });
});
