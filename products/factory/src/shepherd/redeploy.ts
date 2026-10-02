import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { buildSha, FACTORY_REPO } from "../build-info.js";
import { codeRoute, step } from "../workflows/land.js";

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

/** A service already built from the sha is the restart this step caused, so it spawns nothing. */
export function redeploy(deployer: Deployer | undefined, input: RedeployInput): Redeploy {
  if (!deployer) return { spawned: false, detail: "no deployer wired" };
  if (deployer.runningSha() === input.mergeSha) return { spawned: false, detail: `the service already runs ${input.mergeSha}` };
  const { pid, log } = deployer.spawn(input.mergeSha);
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

export interface DeployerOptions {
  /** The factory bin the deployer runs as `service deploy`. */
  bin: string;
  /** Holds the deployer's log. */
  stateDir: string;
  node?: string;
  now?: () => Date;
}

/** Detached is setsid(2): the deployer leads its own process group, so launchd's kill of the service's group misses it. */
export function systemDeployer(options: DeployerOptions, ports: DeployerPorts = nodeDeployerPorts): Deployer {
  return {
    runningSha: buildSha,
    spawn: (mergeSha) => {
      const log = join(options.stateDir, REDEPLOY_LOG);
      const args = [options.bin, "service", "deploy", "--expect", mergeSha];
      ports.mkdir(options.stateDir);
      ports.append(log, `${(options.now?.() ?? new Date()).toISOString()} ${args.slice(1).join(" ")}\n`);
      const fd = ports.openAppend(log);
      try {
        const child = ports.spawn(options.node ?? process.execPath, args, { cwd: options.stateDir, detached: true, stdio: ["ignore", fd, fd] });
        child.on("error", (error: Error) => ports.append(log, `deployer did not start: ${error.message}\n`));
        child.unref();
        return { pid: child.pid, log };
      } finally {
        ports.close(fd);
      }
    },
  };
}
