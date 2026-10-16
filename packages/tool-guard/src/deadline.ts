import { Worker } from "node:worker_threads";
import { unfinishedResult } from "./hook.js";
import type { HookResult } from "./hook.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Milliseconds after node starts by which the hook has answered. Claude Code kills a hook at its
 * `timeout` (5 s in `SETTINGS_ENTRY`) and then runs the call unchecked, so the deny for an
 * unfinished check must be written well before that: start-up before node's clock, the deny, the
 * log append and stopping the worker all fit in the 1.5 s left over.
 */
export const HOOK_DEADLINE_MS = 3500;

/** A check running off the main thread; `stop` ends it wherever it is. */
export interface Running {
  result: Promise<HookResult>;
  stop(): void;
}

export interface WithinPort {
  env: Env;
  now(): Date;
  /** How long the check may run from now. */
  deadlineMs: number;
  start(input: string): Running;
}

/** What the worker thread reads from `workerData`. */
export interface WorkerInput {
  input: string;
  env: Record<string, string | undefined>;
  home: string;
  /** Reads names case-insensitively whatever the platform; the bin leaves it to the platform. */
  foldCase?: boolean;
}

/** The time left of the hook's deadline, given node's clock (`performance.now()`), never below zero. */
export function remainingMs(sinceStartMs: number): number {
  return Math.max(0, HOOK_DEADLINE_MS - sinceStartMs);
}

/**
 * Answers `input` with the check running in another thread, so a timer on this thread still fires
 * during a long synchronous classification. Past the deadline, or when that thread throws or exits
 * without an answer, it denies; the first outcome wins and a later answer is dropped (TP-3224).
 */
export async function answerWithin(input: string, port: WithinPort): Promise<HookResult> {
  const deny = (why: "timeout" | "crash") => unfinishedResult(input, port.env, () => port.now(), why);
  let running: Running;
  try {
    running = port.start(input);
  } catch {
    return deny("crash");
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<HookResult>((resolve) => {
    timer = setTimeout(() => resolve(deny("timeout")), port.deadlineMs);
  });
  try {
    return await Promise.race([running.result.then(checked).catch(() => deny("crash")), late]);
  } finally {
    clearTimeout(timer);
    running.stop();
  }
}

/** An answer with the wrong shape is no answer: a broken worker must not pass a call. */
function checked(answer: unknown): HookResult {
  const result = answer as Partial<HookResult> | null;
  const log: unknown = result?.log;
  const ok = typeof result?.stdout === "string" && Array.isArray(log) && log.every((line) => typeof line === "string");
  if (!ok) throw new TypeError("malformed worker answer");
  return result as HookResult;
}

/** Starts the check of `input` in the worker at `url`, the built `hook-worker.js` beside this module by default. */
export function startWorker(data: WorkerInput, url: URL = new URL("./hook-worker.js", import.meta.url)): Running {
  const worker = new Worker(url, { workerData: data });
  const result = new Promise<HookResult>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("messageerror", reject);
    worker.once("exit", (code) => reject(new Error(`worker exited with code ${code} and no answer`)));
  });
  return {
    result,
    stop: () => {
      // Unreferenced, a worker still inside a classification cannot hold the process open past the deny.
      worker.unref();
      void worker.terminate();
    },
  };
}
