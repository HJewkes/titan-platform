import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Forks a sleeper and records its pid, one per line, in `$0/children`. */
export const FORKS_SLEEPER = 'sleep 600 & echo $! >> "$0/children"; wait';

/** Node strips the source's types; this hook points a source file's relative `.js` specifiers at their `.ts` siblings. */
const SOURCE_HOOK = `import { registerHooks } from "node:module";
registerHooks({ resolve: (s, c, next) => next(c.parentURL?.endsWith(".ts") && s.startsWith(".") && s.endsWith(".js") ? s.slice(0, -3) + ".ts" : s, c) });`;

export const scratch = (): string => mkdtempSync(join(tmpdir(), "run-command-"));

/** A killed process whose parent has not reaped it yet is a zombie: dead, though signal 0 still finds it. `read` is injectable so the exit-between-check-and-read race can be simulated. */
export const alive = (pid: number, read: (path: string) => string = (path) => readFileSync(path, "utf8")): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = `/proc/${pid}/stat`;
  if (!existsSync(stat)) return true;
  try {
    return read(stat).split(") ").at(-1)?.[0] !== "Z";
  } catch (error) {
    // The process can exit between the existence check and the read.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "ENOENT") return false;
    throw error;
  }
};

/** A driver process running `body` as an ES module, with `dir` in scope and `imports` bound from source files. */
export function forkDriver(imports: Record<string, string>, body: string, dir: string): ChildProcess {
  const bound = Object.entries(imports).map(([names, url]) => `const { ${names} } = await import(${JSON.stringify(url)});`);
  const code = [...bound, "const dir = process.argv[1];", body].join("\n");
  const hook = `data:text/javascript,${encodeURIComponent(SOURCE_HOOK)}`;
  const driver = spawn(process.execPath, ["--import", hook, "--input-type=module", "-e", code, dir], { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => {
    driver.kill("SIGKILL");
    for (const pid of readPids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return driver;
}

/** Process death lands just after the pipes close; a pid that never dies leaves this pending until the test's timeout fails it. */
export async function dead(pids: readonly number[]): Promise<boolean> {
  while (pids.some((pid) => alive(pid))) await new Promise((done) => setTimeout(done, 10));
  return true;
}

/** Bounds a test that waits on real processes, so a survivor fails it instead of hanging the run. */
export const PROCESS_TEST_MS = 20_000;

export function readPids(dir: string): number[] {
  const file = join(dir, "children");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

export async function recordedPids(dir: string, atLeast: number): Promise<number[]> {
  while (readPids(dir).length < atLeast) await new Promise((done) => setTimeout(done, 20));
  return readPids(dir);
}

export function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
}
