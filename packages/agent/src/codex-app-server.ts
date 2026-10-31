import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { DEFAULT_CODEX_EXECUTABLE } from "./codex-available.js";
import { terminateProcessGroup, type CodexProcessExit } from "./codex-process.js";

export type CodexUserInput = { type: "text"; text: string } | { type: "localImage"; path: string };

export interface CodexAppServerOptions {
  cwd: string;
  env: Record<string, string>;
  executablePath?: string;
  /** Replaces `["app-server"]`, for `-c` overrides or a stand-in server. */
  args?: readonly string[];
  clientInfo?: { name: string; version: string };
}

export interface CodexInitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexThreadOptions {
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}

export interface CodexThreadResult {
  threadId: string;
  model: string;
  cwd: string;
  /** The full thread/start or thread/resume result, for fields this client does not type. */
  raw: Record<string, unknown>;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: readonly CodexUserInput[];
  clientUserMessageId?: string;
}

export interface CodexTurnSteerParams extends CodexTurnStartParams {
  expectedTurnId: string;
}

const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"] as const;
const THREAD_STATUSES = ["notLoaded", "idle", "systemError", "active"] as const;
export type CodexTurnStatus = (typeof TURN_STATUSES)[number];
export type CodexThreadStatus = (typeof THREAD_STATUSES)[number];

export type CodexAppServerEvent =
  | { kind: "turn_started"; threadId: string; turnId: string }
  | {
      kind: "turn_completed";
      threadId: string;
      turnId: string;
      status: CodexTurnStatus;
    }
  | {
      kind: "thread_status";
      threadId: string;
      status: CodexThreadStatus;
      activeFlags: readonly string[];
    }
  | { kind: "notification"; method: string; params: unknown }
  | ({ kind: "exit"; stderrTail: string } & CodexProcessExit);

export interface CodexAppServer {
  /** The spawned app-server process id, also its process group id; for callers that record or reap it. */
  readonly pid: number;
  readonly initialized: CodexInitializeResult;
  readonly exited: Promise<CodexProcessExit>;
  threadStart(options?: CodexThreadOptions): Promise<CodexThreadResult>;
  threadResume(threadId: string, options?: CodexThreadOptions): Promise<CodexThreadResult>;
  turnStart(params: CodexTurnStartParams): Promise<{ turnId: string }>;
  /** Rejects with CodexSteerPreconditionError when no turn, or another turn, is active. */
  turnSteer(params: CodexTurnSteerParams): Promise<{ turnId: string }>;
  onEvent(listener: (event: CodexAppServerEvent) => void): () => void;
  close(signal?: NodeJS.Signals): Promise<CodexProcessExit>;
}

export class CodexAppServerRpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message} (${code})`);
    this.name = "CodexAppServerRpcError";
  }
}

/** The turn ended, or a different one is active, before the steer arrived; fall back to turnStart. */
export class CodexSteerPreconditionError extends CodexAppServerRpcError {
  override name = "CodexSteerPreconditionError";
}

export class CodexAppServerExitedError extends Error {
  constructor(readonly method: string, readonly exit: CodexProcessExit) {
    super(`${method}: codex app-server exited (code ${String(exit.exitCode)}, signal ${String(exit.signal)})`);
    this.name = "CodexAppServerExitedError";
  }
}

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
// Observed from codex-cli 0.162.1: "no active turn to steer" and "expected active turn id `…` …".
const STEER_PRECONDITION = /^(no active turn to steer|expected active turn id)/;
const STDERR_TAIL_CHARS = 16_384;

export async function startCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServer> {
  const child = spawn(options.executablePath ?? DEFAULT_CODEX_EXECUTABLE, options.args ?? ["app-server"], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new AppServerClient(child);
  try {
    const clientInfo = options.clientInfo ?? {
      name: "titan-design-agent",
      version: "0",
    };
    const initialized = readInitialize(await client.request("initialize", { clientInfo }));
    client.notify("initialized");
    return client.surface(initialized);
  } catch (error) {
    await client.close("SIGKILL");
    throw error;
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CodexAppServerEvent) => void>();
  private exit: CodexProcessExit | undefined;
  private stderrTail = "";
  readonly exited: Promise<CodexProcessExit>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdin.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    this.exited = new Promise((resolve) => {
      child.once("error", (error) => {
        this.stderrTail = `${this.stderrTail}${error.message}\n`.slice(-STDERR_TAIL_CHARS);
      });
      child.once("close", (exitCode, signal) => resolve(this.settle({ exitCode, signal })));
    });
  }

  surface(initialized: CodexInitializeResult): CodexAppServer {
    const { pid } = this.child;
    if (pid === undefined) throw new CodexAppServerRpcError("spawn", 0, "app-server has no pid");
    return {
      pid,
      initialized,
      exited: this.exited,
      threadStart: async (options = {}) => readThread("thread/start", await this.request("thread/start", options)),
      threadResume: async (threadId, options = {}) =>
        readThread("thread/resume", await this.request("thread/resume", { ...options, threadId })),
      turnStart: async (params) => ({
        turnId: readTurnStart(await this.request("turn/start", params)),
      }),
      turnSteer: async (params) => ({
        turnId: readSteer(await this.request("turn/steer", params)),
      }),
      onEvent: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      close: (signal) => this.close(signal),
    };
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exit) return Promise.reject(new CodexAppServerExitedError(method, this.exit));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  async close(signal: NodeJS.Signals = "SIGTERM"): Promise<CodexProcessExit> {
    if (!this.exit) terminateProcessGroup(this.child, signal);
    return this.exited;
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private receive(line: string): void {
    const message = parseMessage(line);
    // Codex writes only JSON-RPC to stdout; anything else is noise with no request to settle.
    if (!message) return;
    if (typeof message.method === "string") {
      if (typeof message.id === "string" || typeof message.id === "number")
        this.declineServerRequest(message.id, message.method);
      else this.emit(eventOf(message.method, message.params));
      return;
    }
    if (typeof message.id === "number") this.settleResponse(message.id, message);
  }

  private settleResponse(id: number, message: JsonRpcMessage): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    if (message.error) call.reject(rpcError(call.method, message.error));
    else call.resolve(message.result);
  }

  /** Approval and elicitation requests need a policy this client does not own; decline so Codex never waits. */
  private declineServerRequest(id: string | number, method: string): void {
    this.write({
      id,
      error: {
        code: METHOD_NOT_FOUND,
        message: `${method} is not handled by this client`,
      },
    });
  }

  private emit(event: CodexAppServerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private settle(exit: CodexProcessExit): CodexProcessExit {
    this.exit = exit;
    for (const call of this.pending.values()) call.reject(new CodexAppServerExitedError(call.method, exit));
    this.pending.clear();
    this.emit({ kind: "exit", ...exit, stderrTail: this.stderrTail });
    return exit;
  }
}

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function parseMessage(line: string): JsonRpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function rpcError(method: string, error: unknown): CodexAppServerRpcError {
  const fields = isRecord(error) ? error : {};
  const code = typeof fields.code === "number" ? fields.code : 0;
  const message = typeof fields.message === "string" ? fields.message : "unknown error";
  const precondition = method === "turn/steer" && code === INVALID_REQUEST && STEER_PRECONDITION.test(message);
  const Kind = precondition ? CodexSteerPreconditionError : CodexAppServerRpcError;
  return new Kind(method, code, message, fields.data);
}

function text(value: Record<string, unknown>, key: string, method: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new CodexAppServerRpcError(method, 0, `result has no string ${key}`);
  return field;
}

function fieldsOf(value: unknown, key?: string): Record<string, unknown> {
  const outer = isRecord(value) ? value : {};
  if (key === undefined) return outer;
  return isRecord(outer[key]) ? outer[key] : {};
}

function readInitialize(result: unknown): CodexInitializeResult {
  const value = fieldsOf(result);
  const read = (key: string) => text(value, key, "initialize");
  return {
    userAgent: read("userAgent"),
    codexHome: read("codexHome"),
    platformFamily: read("platformFamily"),
    platformOs: read("platformOs"),
  };
}

function readThread(method: string, result: unknown): CodexThreadResult {
  const raw = fieldsOf(result);
  return {
    threadId: text(fieldsOf(raw, "thread"), "id", method),
    model: text(raw, "model", method),
    cwd: text(raw, "cwd", method),
    raw,
  };
}

function readTurnStart(result: unknown): string {
  return text(fieldsOf(result, "turn"), "id", "turn/start");
}

function readSteer(result: unknown): string {
  return text(fieldsOf(result), "turnId", "turn/steer");
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

type StateEvent = Exclude<CodexAppServerEvent, { kind: "notification" | "exit" }>;

function eventOf(method: string, params: unknown): CodexAppServerEvent {
  const value = fieldsOf(params);
  const { threadId } = value;
  const state = typeof threadId === "string" ? stateEvent(method, threadId, value) : undefined;
  return state ?? { kind: "notification", method, params };
}

function stateEvent(method: string, threadId: string, value: Record<string, unknown>): StateEvent | undefined {
  const turn = fieldsOf(value, "turn");
  const status = fieldsOf(value, "status");
  const turnId = typeof turn.id === "string" ? turn.id : undefined;
  if (method === "turn/started" && turnId) return { kind: "turn_started", threadId, turnId };
  if (method === "turn/completed" && turnId && oneOf(TURN_STATUSES, turn.status)) {
    return { kind: "turn_completed", threadId, turnId, status: turn.status };
  }
  if (method !== "thread/status/changed" || !oneOf(THREAD_STATUSES, status.type)) return undefined;
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  const activeFlags = flags.filter((flag) => typeof flag === "string");
  return { kind: "thread_status", threadId, status: status.type, activeFlags };
}
