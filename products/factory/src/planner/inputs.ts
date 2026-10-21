import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlannerInput } from "./config.js";
import { dropSections } from "./fingerprint.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  cwd?: string;
}

export type PlannerRun = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

const RUN_TIMEOUT_MS = 120_000;

export const runProcess: PlannerRun = (file, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(file, [...args], { encoding: "utf8", cwd: options.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
    child.stdin?.end(options.input ?? "");
  });

/** An input's text with the configured sections dropped; a failed command throws, so the wake runs rather than guesses. */
export async function readInput(input: PlannerInput, run: PlannerRun): Promise<string> {
  return dropSections(await readRaw(input, run), input.dropSections);
}

async function readRaw(input: PlannerInput, run: PlannerRun): Promise<string> {
  if (input.file !== undefined) return readFileSync(input.file, "utf8");
  if (input.dir !== undefined) return readDir(input.dir, input.suffix);
  const [file, ...args] = input.command!;
  const result = await run(file!, args);
  if (result.code !== 0) throw new Error(`${input.name}: exit ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  return result.stdout;
}

function readDir(dir: string, suffix: string): string {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
  return names.map((name) => `== ${name}\n${readFileSync(join(dir, name), "utf8")}`).join("\n");
}
