import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { buildSha, FACTORY_REPO } from "../build-info.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";

export const REDEPLOY_STEP = "sh-redeploy";
export const REDEPLOY_LOG = "redeploy.log";

export const RedeployResult = z.looseObject({ spawned: z.boolean(), pid: z.number().optional(), log: z.string().optional(), detail: z.string() });

export type Redeploy = z.infer<typeof RedeployResult>;

export interface RedeployInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
}

/** Starts `service deploy` for a sha and returns at once; the deployer outlives the service that started it. */
export interface Deployer {
  /** The sha the running service was built from. */
  runningSha: () => string;
  spawn: (mergeSha: string) => { pid: number | undefined; log: string };
}

export const isFactoryRepo = (repo: string, factoryRepo = FACTORY_REPO): boolean => factoryRepo !== undefined && repo.toLowerCase() === factoryRepo.toLowerCase();

/** Only a merge into the factory's own repo redeploys it; any other repo records no step. */
export async function redeployStep(ctx: WorkflowContext, input: RedeployInput): Promise<Redeploy | undefined> {
  if (!isFactoryRepo(input.repo)) return undefined;
  return step(ctx, `${REDEPLOY_STEP}:${input.mergeSha}`, input, RedeployResult);
}

/** A service already built from the sha is the restart this step caused, so it spawns nothing. Never throws, so a failed spawn cannot stop unfreeze and cleanup. */
export function redeploy(deployer: Deployer | undefined, input: RedeployInput): Redeploy {
  if (!deployer) return { spawned: false, detail: "no deployer wired" };
  if (deployer.runningSha() === input.mergeSha) return { spawned: false, detail: `the service already runs ${input.mergeSha}` };
  let started: ReturnType<Deployer["spawn"]>;
  try {
    started = deployer.spawn(input.mergeSha);
  } catch (error) {
    return { spawned: false, detail: `the deployer did not start: ${failureOf(error)}` };
  }
  const { pid, log } = started;
  if (pid === undefined) return { spawned: false, log, detail: `the deployer did not start; see ${log}` };
  return { spawned: true, pid, log, detail: `deployer pid ${pid} deploys ${input.mergeSha}, logging to ${log}` };
}

export function redeployRoute(now: () => number, deployer?: Deployer): StepRoute {
  return codeRoute(REDEPLOY_STEP, now, async (input: RedeployInput) => redeploy(deployer, input));
}

/** The effects `systemDeployer` has; tests pass fakes, so none of them starts a process. */
export interface DeployerPorts {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, "pid" | "unref" | "on">;
  mkdir: (dir: string) => void;
  append: (path: string, text: string) => void;
  openAppend: (path: string) => number;
  close: (fd: number) => void;
}

export const nodeDeployerPorts: DeployerPorts = {
  spawn: (file, args, options) => spawn(file, args, options),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  append: (path, text) => appendFileSync(path, text),
  openAppend: (path) => openSync(path, "a"),
  close: (fd) => closeSync(fd),
};

/** An async spawn error lands outside any step, so a throw here would crash the service. */
function appendQuietly(ports: DeployerPorts, path: string, text: string): void {
  try {
    ports.append(path, text);
  } catch {
    // Best effort: a lost line beats a crashed service.
  }
}

export interface DeployerOptions {
  /** The factory bin the deployer runs as `service deploy`. */
  bin: string;
  /** Holds the deployer's log. */
  stateDir: string;
  node?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export const SYSTEMD_RUN = "systemd-run";

/** The timestamp keeps a redeploy of the same sha from colliding with a unit that is still running. */
export const deployUnitName = (mergeSha: string, at: Date): string => `titan-factory-deploy-${mergeSha.slice(0, 8)}-${at.getTime().toString(36)}`;

/** A transient unit sits in its own cgroup, so `systemctl restart titan-factory` (KillMode=control-group) no longer kills the deployer mid-deploy. */
function systemdRunArgs(unit: string, log: string, cwd: string, command: readonly string[]): string[] {
  const output = [`--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`];
  return ["--user", "--collect", "--quiet", "--unit", unit, `--working-directory=${cwd}`, "--setenv=PATH", ...output, "--", ...command];
}

type Started = ReturnType<DeployerPorts["spawn"]>;

/** Detached is setsid(2): the deployer leads its own process group, so launchd's kill of the service's group misses it. */
function startDetached(ports: DeployerPorts, log: string, cwd: string, file: string, args: readonly string[]): Started {
  const fd = ports.openAppend(log);
  try {
    const child = ports.spawn(file, args, { cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return child;
  } finally {
    ports.close(fd);
  }
}

/** deploy-health reads this line as a refusal, so only the deployer itself writes it, never the systemd-run launcher. */
function startDeployer(ports: DeployerPorts, log: string, cwd: string, command: DeployCommand): Started {
  const child = startDetached(ports, log, cwd, command.file, command.args);
  child.on("error", (error: Error) => appendQuietly(ports, log, `deployer did not start: ${error.message}\n`));
  return child;
}

interface DeployCommand {
  file: string;
  args: readonly string[];
}

const fallbackNote = (why: string): string => `${SYSTEMD_RUN} did not start the deployer (${why}); starting it in its own session instead\n`;

/** systemd-run reports a missing binary or a refused unit only after spawn returns, so the fallback runs from its error and exit events. */
function startUnderSystemd(ports: DeployerPorts, log: string, cwd: string, unit: string, command: DeployCommand): Started {
  let fellBack = false;
  const fallBack = (why: string) => {
    if (fellBack) return;
    fellBack = true;
    appendQuietly(ports, log, fallbackNote(why));
    try {
      startDeployer(ports, log, cwd, command);
    } catch (error) {
      appendQuietly(ports, log, `deployer did not start: ${failureOf(error)}\n`);
    }
  };
  try {
    const launcher = startDetached(ports, log, cwd, SYSTEMD_RUN, systemdRunArgs(unit, log, cwd, [command.file, ...command.args]));
    launcher.on("error", (error: Error) => fallBack(error.message));
    launcher.on("exit", (code: number | null) => code !== 0 && fallBack(`exit ${code}`));
    return launcher;
  } catch (error) {
    appendQuietly(ports, log, fallbackNote(failureOf(error)));
    return startDeployer(ports, log, cwd, command);
  }
}

/** On systemd the returned pid is systemd-run's, which exits once the transient unit has started. */
export function systemDeployer(options: DeployerOptions, ports: DeployerPorts = nodeDeployerPorts): Deployer {
  return {
    runningSha: buildSha,
    spawn: (mergeSha) => {
      const log = join(options.stateDir, REDEPLOY_LOG);
      const at = options.now?.() ?? new Date();
      const command = { file: options.node ?? process.execPath, args: [options.bin, "service", "deploy", "--expect", mergeSha] };
      ports.mkdir(options.stateDir);
      ports.append(log, `${at.toISOString()} ${command.args.slice(1).join(" ")}\n`);
      const onSystemd = (options.platform ?? process.platform) === "linux";
      const child = onSystemd ? startUnderSystemd(ports, log, options.stateDir, deployUnitName(mergeSha, at), command) : startDeployer(ports, log, options.stateDir, command);
      return { pid: child.pid, log };
    },
  };
}
