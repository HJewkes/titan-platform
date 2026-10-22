import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { nativeRecord } from "../native-usage.js";

export type NativeQuotaMethod = "initialize" | "account/read" | "account/rateLimits/read";
export interface NativeQuotaProcessInput { executablePath: string; cwd: string; env: Record<string, string>; signal: AbortSignal }
export interface NativeQuotaConnection {
  request(method: NativeQuotaMethod, params: Record<string, unknown>): Promise<unknown>;
  initialized(): void;
  close(): void;
}
interface NativeChild {
  stdin: { write(chunk: string): boolean; on(event: "error", listener: () => void): unknown };
  stdout: { on(event: "data" | "error", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data" | "error", listener: (chunk: Buffer) => void): unknown };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal: "SIGKILL"): boolean;
}
export type NativeQuotaSpawn = (executable: string, args: readonly string[], options: {
  cwd: string; env: Record<string, string>; stdio: ["pipe", "pipe", "pipe"];
}) => NativeChild;
export type ConnectNativeQuota = (input: NativeQuotaProcessInput, invalidated: () => void) => NativeQuotaConnection;
const failError = (): Error => new Error("native quota protocol failed");

class StdioQuotaConnection implements NativeQuotaConnection {
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1; private failed = false; private closed = false;
  private stdoutBytes = 0; private stderrBytes = 0; private messages = 0; private buffer = "";
  private decoder = new StringDecoder("utf8");
  private child: NativeChild;
  private onAbort = () => this.fail();
  constructor(private input: NativeQuotaProcessInput, private invalidated: () => void, start: NativeQuotaSpawn) {
    this.child = start(input.executablePath, ["app-server", "--listen", "stdio://"], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", chunk => this.data(chunk));
    this.child.stderr.on("data", chunk => { this.stderrBytes += chunk.byteLength; if (this.stderrBytes > 16384) this.fail(); });
    this.child.stdin.on("error", this.onAbort); this.child.stdout.on("error", this.onAbort); this.child.stderr.on("error", this.onAbort);
    this.child.on("error", this.onAbort); this.child.on("exit", () => { if (!this.closed) this.fail(); });
    input.signal.addEventListener("abort", this.onAbort, { once: true });
    if (input.signal.aborted) this.fail();
  }
  private stop() { try { this.child.kill("SIGKILL"); } catch { /* Native errors never cross the boundary. */ } }
  private isFailed() { return this.failed; }
  private rejectPending() { for (const waiter of this.pending.values()) waiter.reject(failError()); this.pending.clear(); }
  private fail() { if (this.closed || this.failed) return; this.failed = true; this.invalidated(); this.rejectPending(); this.stop(); }
  private message(line: string) {
    if (++this.messages > 32) { this.fail(); return; }
    const value: unknown = JSON.parse(line);
    if (!nativeRecord(value)) { this.fail(); return; }
    if ("method" in value) {
      if ("id" in value || typeof value.method !== "string") { this.fail(); return; }
      if (value.method === "account/updated") this.invalidated();
      else if (value.method !== "account/rateLimits/updated") this.fail();
      return;
    }
    const waiter = typeof value.id === "number" ? this.pending.get(value.id) : undefined;
    if (!waiter || !("result" in value) || "error" in value) { this.fail(); return; }
    this.pending.delete(Number(value.id)); waiter.resolve(value.result);
  }
  private data(chunk: Buffer) {
    if (this.closed || this.failed) return;
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > 65536) { this.fail(); return; }
    this.buffer += this.decoder.write(chunk);
    try {
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 32768) { this.fail(); return; }
        if (line.trim()) this.message(line);
        if (this.isFailed()) return;
      }
      if (Buffer.byteLength(this.buffer) > 32768) this.fail();
    } catch { this.fail(); }
  }
  private write(value: unknown) {
    if (this.closed || this.failed) throw failError();
    try { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
    catch { this.fail(); throw failError(); }
  }
  request(method: NativeQuotaMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!["initialize", "account/read", "account/rateLimits/read"].includes(method) || this.pending.size || this.closed || this.failed) return Promise.reject(failError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch { this.fail(); }
    });
  }
  initialized() { this.write({ method: "initialized" }); }
  close() { this.closed = true; this.input.signal.removeEventListener("abort", this.onAbort); this.rejectPending(); this.stop(); }
}

/** Private stdio only; output is bounded and never returned as an error or log. */
export function connectNativeQuota(
  input: NativeQuotaProcessInput, invalidated: () => void, start: NativeQuotaSpawn = spawn,
): NativeQuotaConnection {
  if (input.signal.aborted) throw failError();
  return new StdioQuotaConnection(input, invalidated, start);
}
