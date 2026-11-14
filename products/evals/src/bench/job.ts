import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { JobCommand } from "./args.js";
import type { Outcome } from "./ledger.js";

export interface LaunchResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one job command to exit; injected so tests never start a model. */
export type Launcher = (command: JobCommand) => Promise<LaunchResult>;

export const spawnLauncher: Launcher = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { cwd: command.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });

/** Where claude writes the session: the cwd with every non-alphanumeric character turned into `-`. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** `timeout` exits 124 after TERM and 137 when the `-k` KILL was needed. */
const isTimeout = (code: number | null): boolean => code === 124 || code === 137;

const INFRA_TEXT = /rate.?limit|usage limit|overloaded|authenticat|not logged in|login|credit balance/i;

/** Loose: the meter reads the rest of the CLI's result (`modelUsage`, `total_cost_usd`) from the same object. */
const CliResultSchema = z.looseObject({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
});
type CliResult = z.infer<typeof CliResultSchema>;

export function parseCliResult(stdout: string): CliResult | undefined {
  try {
    const parsed = CliResultSchema.safeParse(JSON.parse(stdout.trim()));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** No JSON result means claude died before answering (OOM, auth, spawn): infra, re-run once on resume. */
export function classifyLaunch(result: LaunchResult): Outcome {
  if (isTimeout(result.code)) return "timeout";
  const cli = parseCliResult(result.stdout);
  if (cli === undefined) return "infra";
  if (cli.is_error !== true) return result.code === 0 ? "ok" : "error";
  const status = cli.api_error_status ?? 0;
  return status === 429 || status === 401 || status >= 500 || INFRA_TEXT.test(cli.result ?? "") ? "infra" : "error";
}

function findOnPath(name: string, searchPath: string): string | undefined {
  return searchPath
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate));
}

/** System tools a job may call by name; resolved from the system dirs only, never through an operator wrapper. */
const SYSTEM_TOOLS = [
  "timeout", "sh", "bash", "ls", "cat", "git", "rg", "grep", "sed", "awk", "find", "head", "tail", "wc", "sort", "uniq",
  "diff", "mkdir", "rm", "cp", "mv", "touch", "printf", "echo", "pwd", "dirname", "basename", "xargs", "tr", "cut", "tee",
  "date", "test", "true", "false", "pnpm", "bwrap", "socat",
];
const SYSTEM_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
/** Installed per user, so they come from the runner's PATH. */
const RUNTIME_TOOLS = ["claude", "node"];

/**
 * Links an allowlist of commands into `<runDir>/bin` and returns that dir as the job's whole PATH, so a job finds no
 * `gh`, `curl`, `ssh` or operator CLI by name. The deny rules are the first guard; this one holds if a rule is evaded.
 */
export function prepareRunBin(runDir: string, runnerPath: string): string {
  const bin = join(runDir, "bin");
  mkdirSync(bin, { recursive: true });
  const wanted: [string, string][] = [...SYSTEM_TOOLS.map((name): [string, string] => [name, SYSTEM_DIRS]), ...RUNTIME_TOOLS.map((name): [string, string] => [name, runnerPath])];
  for (const [name, searchPath] of wanted) {
    const target = findOnPath(name, searchPath);
    if (target === undefined && (name === "claude" || name === "timeout")) throw new Error(`job PATH: ${name} was not found`);
    if (target !== undefined && !existsSync(join(bin, name))) symlinkSync(target, join(bin, name));
  }
  return bin;
}
