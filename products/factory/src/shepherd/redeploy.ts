import { join } from "node:path";
import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { AncestryProbe } from "../build-ancestry.js";
import { buildSha, FACTORY_REPO } from "../build-info.js";
import { codeRoute, step } from "../workflows/land.js";
import { DEPLOY_MAX_WAIT_MS, DEPLOY_QUIET_MS, noteWanted, readWanted, writeWanted, type DeployPacerOptions, type WantedStore } from "./deploy-pacer.js";
import { failureOf } from "./error-class.js";
import type { DeployerPorts } from "./redeploy-adapter.js";

export type { DeployerPorts };

export const REDEPLOY_STEP = "sh-redeploy";
export const REDEPLOY_LOG = "redeploy.log";

export const RedeployResult = z.looseObject({ spawned: z.boolean(), queued: z.boolean().optional(), pid: z.number().optional(), log: z.string().optional(), detail: z.string() });

export type Redeploy = z.infer<typeof RedeployResult>;

export interface RedeployInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
  /**
   * The green main commit sh-main-ci read when it was not the merge sha: a burst whose own runs were cancelled is
   * acknowledged on one tip, and queueing each merge sha would let the oldest overwrite that tip.
   */
  greenSha?: string;
}

/** Starts `service deploy` for a sha and returns at once; the deployer outlives the service that started it. */
export interface Deployer {
  /** The sha the running service was built from. */
  runningSha: () => string;
  /** Always passes `--expect`, so the unit's name and the sha it builds never come apart (TP-4279). */
  spawn: (mergeSha: string) => { pid: number | undefined; log: string };
  /** Queues the sha for serve's deploy pacer instead of spawning; absent means every merge spawns. */
  request?: (mergeSha: string) => Redeploy | Promise<Redeploy>;
}

export const isFactoryRepo = (repo: string, factoryRepo = FACTORY_REPO): boolean => factoryRepo !== undefined && repo.toLowerCase() === factoryRepo.toLowerCase();

/** Only a merge into the factory's own repo redeploys it; any other repo records no step. */
export async function redeployStep(ctx: WorkflowContext, input: RedeployInput): Promise<Redeploy | undefined> {
  if (!isFactoryRepo(input.repo)) return undefined;
  return step(ctx, `${REDEPLOY_STEP}:${input.mergeSha}`, input, RedeployResult);
}

/** A service already built from the sha is the restart this step caused, so it spawns nothing. Never throws, so a failed spawn cannot stop unfreeze and cleanup. */
export async function redeploy(deployer: Deployer | undefined, input: RedeployInput): Promise<Redeploy> {
  if (!deployer) return { spawned: false, detail: "no deployer wired" };
  const sha = input.greenSha ?? input.mergeSha;
  if (deployer.runningSha() === sha) return { spawned: false, detail: `the service already runs ${sha}` };
  if (deployer.request) return requestDeploy(deployer.request, sha);
  let started: ReturnType<Deployer["spawn"]>;
  try {
    started = deployer.spawn(sha);
  } catch (error) {
    return { spawned: false, detail: `the deployer did not start: ${failureOf(error)}` };
  }
  const { pid, log } = started;
  if (pid === undefined) return { spawned: false, log, detail: `the deployer did not start; see ${log}` };
  return { spawned: true, pid, log, detail: `deployer pid ${pid} deploys ${sha}, logging to ${log}` };
}

async function requestDeploy(request: NonNullable<Deployer["request"]>, mergeSha: string): Promise<Redeploy> {
  try {
    return await request(mergeSha);
  } catch (error) {
    return { spawned: false, detail: `the deploy was not queued: ${failureOf(error)}` };
  }
}

export function redeployRoute(now: () => number, deployer?: Deployer): StepRoute {
  return codeRoute(REDEPLOY_STEP, now, (input: RedeployInput) => redeploy(deployer, input));
}

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
  /** The program that runs `bin`; the host wiring passes the running node. */
  node: string;
  now: () => Date;
  platform: NodeJS.Platform;
  /** Lets the queue keep a newer queued sha over an older merge it contains; absent means the last merge queued wins. */
  isAncestor?: AncestryProbe;
}

/** What queueing a sha needs; it spawns nothing, so the program, bin and platform are optional. */
type QueueOptions = Pick<DeployerOptions, "stateDir" | "now" | "isAncestor"> & Partial<DeployerOptions>;

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

const minutes = (ms: number): number => ms / 60_000;
const QUEUED_DETAIL = `deploys after ${minutes(DEPLOY_QUIET_MS)} min with no newer merge, at most ${minutes(DEPLOY_MAX_WAIT_MS)} min after the first`;

/** The queued sha when git shows it contains `mergeSha`; no answer leaves it to be replaced, as before. */
async function queuedHolding(options: QueueOptions, store: WantedStore, mergeSha: string): Promise<string | undefined> {
  const queued = readWanted(options.stateDir, store)?.sha;
  if (queued === undefined || options.isAncestor === undefined) return undefined;
  return (await options.isAncestor(mergeSha, queued)) === true ? queued : undefined;
}

/** Serve's deploy pacer spawns later, through `deployPacerPorts`. The record is read again after the probe, so a sha queued meanwhile is not kept by a stale answer. */
async function queueDeploy(options: QueueOptions, ports: DeployerPorts, store: WantedStore, mergeSha: string): Promise<Redeploy> {
  const now = options.now().getTime();
  ports.mkdir(options.stateDir);
  const heldBy = await queuedHolding(options, store, mergeSha);
  writeWanted(options.stateDir, store, noteWanted(readWanted(options.stateDir, store), mergeSha, now, heldBy));
  const detail = heldBy === undefined ? `queued ${mergeSha}; ${QUEUED_DETAIL}` : `kept the queued ${heldBy}, which contains ${mergeSha}`;
  return { spawned: false, queued: true, detail };
}

/** A green main sha no Shepherd run merged (seat-merge, bin/merge, the owner) queues through the record Shepherd's redeploy step writes (TP-3474). */
export function mainDeployQueue(options: QueueOptions, ports: DeployerPorts, store: WantedStore): (sha: string) => Promise<Redeploy> {
  return (sha) => queueDeploy(options, ports, store, sha);
}

/** The pacer spawns through the same deployer, so both paths share A0's unit naming and log. */
export function deployPacerPorts(options: DeployerOptions, ports: DeployerPorts, store: WantedStore): Pick<DeployPacerOptions, "stateDir" | "spawn"> {
  const deployer = systemDeployer(options, ports, store);
  return { stateDir: options.stateDir, spawn: (sha) => deployer.spawn(sha) };
}

/** On systemd the returned pid is systemd-run's, which exits once the transient unit has started. */
export function systemDeployer(options: DeployerOptions, ports: DeployerPorts, store: WantedStore): Deployer {
  return {
    runningSha: buildSha,
    request: mainDeployQueue(options, ports, store),
    spawn: (mergeSha) => {
      const log = join(options.stateDir, REDEPLOY_LOG);
      const at = options.now();
      const command = { file: options.node, args: [options.bin, "service", "deploy", "--expect", mergeSha] };
      ports.mkdir(options.stateDir);
      ports.append(log, `${at.toISOString()} ${command.args.slice(1).join(" ")}\n`);
      const onSystemd = options.platform === "linux";
      const child = onSystemd ? startUnderSystemd(ports, log, options.stateDir, deployUnitName(mergeSha, at), command) : startDeployer(ports, log, options.stateDir, command);
      return { pid: child.pid, log };
    },
  };
}
