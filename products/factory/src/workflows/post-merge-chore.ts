import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SYSTEMD_RUN } from "../shepherd/redeploy.js";

const CHORE_POLL_MS = 1_000;

/** Everything one chore leaves on disk, keyed by the step's request key so a successor finds it from the stored step alone. */
export interface ChoreFiles {
  marker: string;
  spec: string;
  result: string;
  unit: string;
}

/** Hashed because a request key holds characters a unit name may not; the attempt in the key keeps each try apart. */
export function choreFiles(dir: string, requestKey: string): ChoreFiles {
  const id = createHash("sha256").update(requestKey).digest("hex").slice(0, 16);
  return { marker: join(dir, `${id}.json`), spec: join(dir, `${id}.spec.json`), result: join(dir, `${id}.result.json`), unit: `titan-factory-chore-${id}` };
}

/** What the wrapper runs; `vars` are the chore's own variables, and a null one is removed from the inherited environment. */
export const ChoreSpec = z.object({
  argv: z.tuple([z.string()], z.string()),
  cwd: z.string().optional(),
  timeoutMs: z.number(),
  vars: z.record(z.string(), z.string().nullable()),
  result: z.string(),
});
export type ChoreSpec = z.infer<typeof ChoreSpec>;

const ChoreHandle = z.union([z.object({ unit: z.string() }), z.object({ pid: z.number() })]);
type ChoreHandle = z.infer<typeof ChoreHandle>;

const StepTrace = z.object({ runId: z.string(), stepId: z.string(), iteration: z.number(), attempt: z.number() });
type StepTrace = z.infer<typeof StepTrace>;

/** Written before the launch, then again with its handle: a marker with no handle means the launch may or may not have happened. */
const ChoreMarker = z.object({ started: z.string(), step: StepTrace, handle: ChoreHandle.optional() });
type ChoreMarker = z.infer<typeof ChoreMarker>;

export interface ChorePorts {
  /** `<stateDir>/chores`, which outlives serve. */
  dir: string;
  launch(files: ChoreFiles): Promise<ChoreHandle>;
  alive(handle: ChoreHandle): Promise<boolean>;
  pollMs?: number;
}

type ChoreState =
  | { kind: "done"; result: unknown; step: StepTrace }
  | { kind: "running"; handle: ChoreHandle; step: StepTrace }
  | { kind: "never-started" }
  | { kind: "lost"; why: string };

/** Atomic, so a reader never sees half a file, whichever process dies mid-write. */
export function writeJson(file: string, value: unknown): void {
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(value));
  renameSync(partial, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function launchChore(ports: ChorePorts, files: ChoreFiles, spec: ChoreSpec, step: StepTrace, startedAt: string): Promise<ChoreHandle> {
  mkdirSync(ports.dir, { recursive: true });
  writeJson(files.spec, spec);
  writeJson(files.marker, { started: startedAt, step } satisfies ChoreMarker);
  const handle = await ports.launch(files);
  writeJson(files.marker, { started: startedAt, step, handle } satisfies ChoreMarker);
  return handle;
}

/** Undefined when the chore ended without a result; the result is read again after the liveness check, so an exit right after writing it is not lost. */
export async function awaitChoreResult(ports: ChorePorts, files: ChoreFiles, handle: ChoreHandle, signal: AbortSignal): Promise<unknown> {
  for (;;) {
    const result = readJson(files.result);
    if (result !== undefined) return result;
    if (!(await ports.alive(handle))) return readJson(files.result);
    await pause(ports.pollMs ?? CHORE_POLL_MS, signal);
  }
}

export async function choreState(ports: ChorePorts, files: ChoreFiles): Promise<ChoreState> {
  const raw = readJson(files.marker);
  if (raw === undefined) return { kind: "never-started" };
  const marker = ChoreMarker.safeParse(raw);
  if (!marker.success) return { kind: "lost", why: `chore marker ${files.marker} is unreadable` };
  const result = readJson(files.result);
  if (result !== undefined) return { kind: "done", result, step: marker.data.step };
  const { handle, step } = marker.data;
  if (!handle) return { kind: "lost", why: "the chore's launch was interrupted, so it may or may not have run" };
  if (await ports.alive(handle)) return { kind: "running", handle, step };
  return { kind: "lost", why: `the chore (${handleName(handle)}) is gone and wrote no result` };
}

export const handleName = (handle: ChoreHandle): string => ("unit" in handle ? `unit ${handle.unit}` : `pid ${handle.pid}`);

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted while waiting on the post-merge chore"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted while waiting on the post-merge chore"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const exitCodeOf = (file: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve) => execFile(file, args, (error) => resolve(error ? (typeof error.code === "number" ? error.code : 1) : 0)));

/**
 * A transient unit sits in its own cgroup, so a restart of serve (KillMode=control-group) leaves the chore running. Off
 * Linux, or when systemd-run refuses, a detached spawn leads its own session, which launchd's kill of serve's group misses.
 */
export function systemChorePorts(options: { dir: string; wrapper: readonly [string, ...string[]]; systemd?: boolean }): ChorePorts {
  const { dir, wrapper } = options;
  const systemd = options.systemd ?? process.platform === "linux";
  return {
    dir,
    async launch(files) {
      const args = ["--user", "--collect", "--quiet", "--unit", files.unit, "--setenv=PATH", "--", ...wrapper, files.spec];
      if (systemd && (await exitCodeOf(SYSTEMD_RUN, args)) === 0) return { unit: files.unit };
      const child = spawn(wrapper[0], [...wrapper.slice(1), files.spec], { detached: true, stdio: "ignore" });
      // A spawn failure is reported by the missing pid below; unheard, its later error event would crash serve.
      child.on("error", () => undefined);
      child.unref();
      if (child.pid === undefined) throw new Error(`post-merge chore wrapper did not start: ${wrapper.join(" ")}`);
      return { pid: child.pid };
    },
    alive: async (handle) => ("unit" in handle ? (await exitCodeOf("systemctl", ["--user", "--quiet", "is-active", handle.unit])) === 0 : pidAlive(handle.pid)),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
