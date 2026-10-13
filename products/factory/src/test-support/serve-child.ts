import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowEvent, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";

const MAIN = fileURLToPath(new URL("./serve-child-main.ts", import.meta.url));
const READY_MS = 20_000;

/**
 * Everything a serve child and its successor share: one database, one state dir, the dispatch log
 * (one JSON line per dispatch of the blocking step, so dispatches are counted across processes), and
 * the release file the blocking step waits for.
 */
export const serveChildPathsSchema = z.object({ dbPath: z.string(), stateDir: z.string(), dispatchLog: z.string(), releaseFile: z.string() });
export type ServeChildPaths = z.infer<typeof serveChildPathsSchema>;

const dispatchSchema = z.object({ pid: z.number(), attempt: z.number(), restarts: z.number().optional() });
export type Dispatch = z.infer<typeof dispatchSchema>;

export type ParentMessage = { kind: "start" } | { kind: "status"; runId: string };

export type ChildMessage =
  | { kind: "ready"; port: number }
  | { kind: "started"; runId: string }
  | { kind: "status"; status: WorkflowStatus | null }
  | { kind: "event"; event: WorkflowEvent };

export interface ServeChild {
  readonly pid: number;
  readonly port: number;
  /** Every workflow event the child's runtime emitted, in order. */
  readonly events: readonly WorkflowEvent[];
  /** Starts one run of the blocking workflow; resolves with its id. */
  start(): Promise<string>;
  status(runId: string): Promise<WorkflowStatus | null>;
  /** Sends `signal` to this child's own pid and resolves once it has exited. */
  kill(signal: "SIGKILL" | "SIGTERM"): Promise<void>;
}

export function serveChildPaths(dir: string): ServeChildPaths {
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  return { dbPath: join(stateDir, "factory.sqlite3"), stateDir, dispatchLog: join(dir, "dispatches.jsonl"), releaseFile: join(dir, "release") };
}

export function releaseBlockedStep(paths: ServeChildPaths): void {
  writeFileSync(paths.releaseFile, "");
}

export function dispatches(paths: ServeChildPaths): Dispatch[] {
  if (!existsSync(paths.dispatchLog)) return [];
  return readFileSync(paths.dispatchLog, "utf8").trim().split("\n").filter(Boolean).map((line) => dispatchSchema.parse(JSON.parse(line)));
}

/** The run's stored lease; read it only while no serve child is running. */
export function storedOwner(paths: ServeChildPaths, runId: string): WorkflowRun["owner"] {
  const db = openDatabase(paths.dbPath);
  try {
    return new WorkflowRunStore(db).get(runId)?.owner;
  } finally {
    db.close();
  }
}

/** Forks a real `startFactoryServer` on an ephemeral port; `forked` records the pid so a test kills only what it started. */
export async function forkServeChild(paths: ServeChildPaths, forked: Set<ChildProcess>): Promise<ServeChild> {
  const child = fork(MAIN, [JSON.stringify(paths)], { execArgv: ["--experimental-transform-types"], stdio: ["ignore", "ignore", "pipe", "ipc"], env: hermeticEnv(paths) });
  forked.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const events: WorkflowEvent[] = [];
  child.on("message", (message: ChildMessage) => {
    if (message.kind === "event") events.push(message.event);
  });
  const { port } = await reply(child, "ready", READY_MS, () => stderr);
  const ask = <K extends ChildMessage["kind"]>(message: ParentMessage, kind: K) => {
    const answer = reply(child, kind, READY_MS, () => stderr);
    child.send(message);
    return answer;
  };
  return {
    pid: child.pid!,
    port,
    events,
    start: async () => (await ask({ kind: "start" }, "started")).runId,
    status: async (runId) => (await ask({ kind: "status", runId }, "status")).status,
    kill: async (signal) => {
      if (child.exitCode === null && child.signalCode === null) process.kill(child.pid!, signal);
      await exited;
    },
  };
}

/** The child never reads the owner's XDG state or config, so it cannot touch a live serve's files. */
function hermeticEnv(paths: ServeChildPaths): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: paths.stateDir, XDG_STATE_HOME: paths.stateDir, XDG_CONFIG_HOME: paths.stateDir, NODE_NO_WARNINGS: "1" };
}

function reply<K extends ChildMessage["kind"]>(child: ChildProcess, kind: K, timeoutMs: number, stderr: () => string): Promise<Extract<ChildMessage, { kind: K }>> {
  return new Promise((resolve, reject) => {
    const settle = (done: () => void) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      done();
    };
    const isAnswer = (message: ChildMessage): message is Extract<ChildMessage, { kind: K }> => message.kind === kind;
    const onMessage = (message: ChildMessage) => {
      if (isAnswer(message)) settle(() => resolve(message));
    };
    const onExit = (code: number | null, signal: string | null) => settle(() => reject(new Error(`serve child exited (${code ?? signal}) before "${kind}": ${stderr()}`)));
    const timer = setTimeout(() => settle(() => reject(new Error(`serve child sent no "${kind}" within ${timeoutMs} ms: ${stderr()}`))), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
