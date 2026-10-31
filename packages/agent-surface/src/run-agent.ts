import { spawn } from "node:child_process";
import fs from "node:fs";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { clearOutputTail, tailKeeper, writeOutputTail } from "./launch-output.js";
import { NO_PANE_SOURCES, paneEscapes, type PaneSources } from "./pane-identity.js";
import { SURFACE_NAMES, type LaunchPlan, type SurfaceName } from "./types.js";

/**
 * The fixed command every surface launches. It reads the plan, sets the terminal
 * title, and runs the binary with an argv ARRAY. No shell is involved at any
 * point, which is what makes it safe for a model-authored brief to be in the
 * plan at all.
 */

/** The default name of the variable that carries the launcher's own pid to the process it launched. */
export const LAUNCHER_PID_ENV = "TITAN_AGENT_LAUNCHER_PID";

/** The launcher pid comes last so no plan can forge it. */
export const launchEnv = (
  planEnv: Record<string, string>,
  base: Record<string, string>,
  launcherPid: number = process.pid,
  unset: readonly string[] = [],
  launcherPidEnv: string = LAUNCHER_PID_ENV,
): Record<string, string> => {
  const env: Record<string, string> = { ...base, ...planEnv };
  for (const name of unset) delete env[name];
  return { ...env, [launcherPidEnv]: String(launcherPid) };
};

/** A `bin` the launcher could not turn into something to exec; the launcher exits 127 with this message. */
export class LaunchBinUnresolved extends Error {
  override readonly name = "LaunchBinUnresolved";
}

export interface RunAgentOptions {
  /** The agent's own directory, where the stderr tail is left for the host. */
  agentDir: string;
  /** The env the plan's env is layered over. Defaults to this process's env; a host passes its scrubbed env. */
  baseEnv?: Record<string, string>;
  /** Turns `plan.bin` into what is exec'd, in the process that execs. Throw `LaunchBinUnresolved` to exit 127. */
  resolveBin?: (bin: string) => string;
  launcherPidEnv?: string;
  paneSources?: PaneSources;
  /** Prefix for the launcher's own messages on stderr. */
  label?: string;
}

const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string");

const isOptionalStringArray = (value: unknown): value is string[] | undefined =>
  value === undefined || isStringArray(value);

const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

const wrongType = (file: string, fields: string): Error =>
  new Error(`launch plan at ${file} has an ${fields} of the wrong type`);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isObjectLike(value) && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");

const isSurfaceName = (value: unknown): value is SurfaceName => SURFACE_NAMES.some(name => name === value);

/** Reads a plan the host wrote; the host owns its shape, so only the fields the launcher execs are checked. */
export function readLaunchPlan(file: string): LaunchPlan {
  if (!fs.existsSync(file)) throw new Error(`no launch plan at ${file}`);
  const plan: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !isObjectLike(plan) ||
    typeof plan.agentId !== "string" ||
    typeof plan.bin !== "string" ||
    !isStringArray(plan.args) ||
    typeof plan.cwd !== "string"
  )
    throw new Error(`launch plan at ${file} lacks agentId, bin, args or cwd`);
  const { agentId, bin, args, cwd, unsetEnv, stdin } = plan;
  const env = plan.env ?? {};
  const title = plan.title ?? agentId;
  const surface = plan.surface ?? "headless";
  if (!isStringRecord(env) || typeof title !== "string" || !isSurfaceName(surface)) throw wrongType(file, "env, title or surface");
  if (!isOptionalStringArray(unsetEnv) || !isOptionalString(stdin)) throw wrongType(file, "unsetEnv or stdin");
  return {
    agentId,
    bin,
    args,
    cwd,
    env,
    title,
    surface,
    ...(unsetEnv === undefined ? {} : { unsetEnv }),
    ...(stdin === undefined ? {} : { stdin }),
  };
}

/** Writes the pane escapes and execs the plan; this process exits the way the launched one did. */
export function runAgent(plan: LaunchPlan, options: RunAgentOptions): void {
  process.stdout.write(paneEscapes(plan, process.env, options.paneSources ?? NO_PANE_SOURCES));
  exec(plan, options);
}

function resolvedBin(bin: string, options: RunAgentOptions, label: string): string {
  try {
    return options.resolveBin?.(bin) ?? bin;
  } catch (err) {
    if (!(err instanceof LaunchBinUnresolved)) throw err;
    process.stderr.write(`${label}: ${err.message}\n`);
    process.exit(127);
  }
}

/** Longest the launcher waits for stderr to drain after the child exits; a grandchild holding fd 2 must not stall it. */
const STDERR_FLUSH_MS = 250;

function exec(plan: LaunchPlan, options: RunAgentOptions): void {
  const label = options.label ?? "titan-agent-launch";
  clearOutputTail(options.agentDir);
  const bin = resolvedBin(plan.bin, options, label);
  const base = options.baseEnv ?? definedEnv(process.env);
  const child = spawn(bin, plan.args, {
    cwd: plan.cwd,
    // `plan.env` wins over the base deliberately: it is what the SPAWNER chose for this agent.
    env: launchEnv(plan.env, base, process.pid, plan.unsetEnv, options.launcherPidEnv),
    // The brief goes in on stdin for headless; an interactive surface hands the terminal straight through.
    stdio: plan.stdin === undefined ? "inherit" : ["pipe", "inherit", "pipe"],
  });
  const stderrTail = tailKeeper();
  // Headless only. Drained and passed on so the pipe never fills; the tail is what the host reads.
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.append(chunk.toString("utf8"));
    process.stderr.write(chunk);
  });
  if (plan.stdin !== undefined) writeBrief(child.stdin, plan.stdin, bin, label);

  child.on("error", err => {
    process.stderr.write(`${label}: could not start ${bin}: ${err.message}\n`);
    process.exit(127);
  });
  // Exit the way the child did, so whatever watches the surface sees the agent's outcome, not the launcher's.
  child.on("exit", (code, signal) => {
    const finish = (): never => {
      writeOutputTail(options.agentDir, stderrTail.text());
      process.exit(signal !== null ? 128 : (code ?? 0));
    };
    if (child.stderr === null || child.stderr.readableEnded) return finish();
    child.stderr.once("end", finish);
    setTimeout(finish, STDERR_FLUSH_MS);
  });
}

function writeBrief(stdin: NodeJS.WritableStream | null, brief: string, bin: string, label: string): void {
  // A child that exits before reading its brief closes the pipe; its exit code is what matters, not the failed write.
  stdin?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") process.stderr.write(`${label}: could not write the brief to ${bin}: ${err.message}\n`);
  });
  stdin?.end(brief);
}
