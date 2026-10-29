import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Built from "../index.js";

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));

interface BuiltHookRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

interface BuiltHookOptions {
  home: string;
  /** The hook's environment, HOME aside; this process's by default, as the spawned bin inherited it. */
  env?: Readonly<Record<string, string | undefined>>;
  /** When a spawned bin is killed; 5 s, the settings entry's timeout, by default. */
  timeoutMs?: number;
}

/** The built bin on one event, in its own node process: what Claude Code runs. */
export function spawnBuiltHook(input: string, { home, env = process.env, timeoutMs = 5000 }: BuiltHookOptions): BuiltHookRun {
  const run = spawnSync(process.execPath, [`${dist}bin.js`, "hook"], { input, env: { ...env, HOME: home }, encoding: "utf-8", timeout: timeoutMs });
  return { status: run.status, signal: run.signal, stdout: run.stdout };
}

let built: Promise<typeof Built> | undefined;

/** The built bundle's own `handle`, answering as `bin.js hook` does: the answer on one line, or nothing. */
async function inProcess(input: string, { home, env = process.env }: BuiltHookOptions): Promise<BuiltHookRun> {
  built ??= import(pathToFileURL(`${dist}index.js`).href) as Promise<typeof Built>;
  const { decide, handle, nodeContext } = await built;
  const result = await handle(input, { ...env, HOME: home }, { context: nodeContext(resolve(home)), now: () => new Date(), loadDecide: async () => decide });
  return { status: 0, signal: null, stdout: result.stdout === "" ? "" : `${result.stdout}\n` };
}

let spawned = false;

/**
 * The built hook on one event, for built-bin shape matrices. A test file's first call spawns the real bin (vitest
 * isolates each file's modules), so each file still proves the bin answers end to end; later calls run the same built
 * bundle in this process, which spares a node start-up per row (TP-4453). The deadline, the worker and the log append
 * stay with `built-hook.test.ts`, which always spawns.
 */
export async function runBuiltHook(input: string, options: BuiltHookOptions): Promise<BuiltHookRun> {
  if (spawned) return inProcess(input, options);
  spawned = true;
  return spawnBuiltHook(input, options);
}
