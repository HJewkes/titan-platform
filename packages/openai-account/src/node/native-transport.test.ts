import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { connectNativeQuota, type NativeQuotaSpawn } from "./native-transport.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn((_signal: "SIGKILL") => true);
}
function fixture() {
  const child = new FakeChild(); const controller = new AbortController(); const changed = vi.fn();
  const start = vi.fn<NativeQuotaSpawn>(() => child);
  const input = { executablePath: "codex", cwd: "/fixture/empty-workspace", env: { CODEX_HOME: "/fixture/home" }, signal: controller.signal };
  const channel = connectNativeQuota(input, changed, start);
  return { child, controller, changed, start, channel };
}
function reply(child: FakeChild, value: unknown) { child.stdout.write(`${JSON.stringify(value)}\n`); }

describe("bounded native stdio quota transport", () => {
  it("starts only private app-server stdio and correlates matching fresh request replies", async () => {
    const f = fixture();
    expect(f.start).toHaveBeenCalledWith("codex", ["app-server", "--listen", "stdio://"], {
      cwd: "/fixture/empty-workspace", env: { CODEX_HOME: "/fixture/home" }, stdio: ["pipe", "pipe", "pipe"] });
    const writes: unknown[] = [];
    f.child.stdin.on("data", (chunk: Buffer) => { const data: unknown = JSON.parse(chunk.toString()); writes.push(data); });
    const first = f.channel.request("initialize", { clientInfo: { name: "test", version: "1" } });
    reply(f.child, { id: 1, result: { first: true } }); expect(await first).toEqual({ first: true });
    f.channel.initialized();
    const second = f.channel.request("account/rateLimits/read", { excludeResetCreditDetails: true });
    reply(f.child, { id: 2, result: { second: true } }); expect(await second).toEqual({ second: true });
    expect(writes).toEqual([{ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } },
      { method: "initialized" }, { id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } }]);
    f.channel.close(); expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("does not confuse cached sparse notifications with a matching read response", async () => {
    const f = fixture(); let settled = false;
    const waiting = f.channel.request("account/rateLimits/read", {}).then(value => { settled = true; return value; });
    reply(f.child, { method: "account/rateLimits/updated", params: { written_at: 9999999999 } });
    await Promise.resolve(); expect(settled).toBe(false);
    reply(f.child, { method: "account/updated", params: {} }); expect(f.changed).toHaveBeenCalledOnce();
    reply(f.child, { id: 1, result: {} }); expect(await waiting).toEqual({}); f.channel.close();
  });
  it("preserves split UTF8 response data", async () => {
    const f = fixture(); const result = f.channel.request("initialize", {});
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { value: "cafè" } })}\n`);
    const cut = bytes.indexOf(Buffer.from("è")) + 1;
    f.child.stdout.write(bytes.subarray(0, cut)); f.child.stdout.write(bytes.subarray(cut));
    expect(await result).toEqual({ value: "cafè" }); f.channel.close();
  });
  it.each([
    { id: 1, error: { code: -32603, message: "secret-token" } },
    { id: 1, result: {}, error: {} }, { id: 9, result: {} },
    { id: 1, method: "account/chatgptAuthTokens/refresh", params: {} },
    { method: "unknown/notification" }, null,
  ])("refuses unsupported or malformed native message without error contents %s", async value => {
    const f = fixture(); const result = f.channel.request("initialize", {}); reply(f.child, value);
    await expect(result).rejects.toThrow("native quota protocol failed");
    expect(f.child.kill).toHaveBeenCalled(); expect(f.changed).toHaveBeenCalled(); f.channel.close();
  });
  it("refuses reused responses instead of renewing observation time", async () => {
    const f = fixture(); const first = f.channel.request("initialize", {});
    reply(f.child, { id: 1, result: {} }); await first;
    const next = f.channel.request("account/rateLimits/read", {});
    reply(f.child, { id: 1, result: {} }); await expect(next).rejects.toThrow("native quota protocol failed"); f.channel.close();
  });
  it.each(["stdout", "stderr", "malformed", "exit", "error", "stdin-error", "abort"]) ("bounds and closes native transport on %s", async mode => {
    const f = fixture(); const result = f.channel.request("initialize", {});
    if (mode === "stdout") f.child.stdout.write(Buffer.alloc(65537, 65));
    else if (mode === "stderr") f.child.stderr.write(Buffer.alloc(16385, 65));
    else if (mode === "malformed") f.child.stdout.write("private-invalid-json\n");
    else if (mode === "exit") f.child.emit("exit", 0);
    else if (mode === "error") f.child.emit("error", new Error("secret"));
    else if (mode === "stdin-error") f.child.stdin.emit("error", new Error("secret"));
    else f.controller.abort();
    await expect(result).rejects.toThrow("native quota protocol failed"); expect(f.child.kill).toHaveBeenCalled(); f.channel.close();
  });
  it("refuses excessive messages and concurrent requests without orphaning the first", async () => {
    const f = fixture(); const first = f.channel.request("initialize", {});
    await expect(f.channel.request("account/read", {})).rejects.toThrow("native quota protocol failed");
    for (let i = 0; i < 33; i++) reply(f.child, { method: "account/rateLimits/updated" });
    await expect(first).rejects.toThrow("native quota protocol failed"); f.channel.close();
  });
  it("never spawns on an already aborted input", () => {
    const controller = new AbortController(); controller.abort(); const start = vi.fn<NativeQuotaSpawn>(() => new FakeChild());
    expect(() => connectNativeQuota({ executablePath: "codex", cwd: "/fixture/empty-workspace", env: {}, signal: controller.signal }, () => {}, start)).toThrow();
    expect(start).not.toHaveBeenCalled();
  });
});
