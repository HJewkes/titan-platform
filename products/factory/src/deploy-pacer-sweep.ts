import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "@titan-design/daemon";
import { z } from "zod";
import { cachedAncestry, gitAncestry, runningHolds } from "./build-ancestry.js";
import { FACTORY_REPO } from "./build-info.js";
import { factoryStateDir } from "./config.js";
import { readDeployHolds } from "./deploy-pause.js";
import { readDeployWindow, readLastDeploy } from "./deploy-ports.js";
import { nodeMorningHoldPorts, syncMorningHold, type MorningHoldAction } from "./morning-deploy-hold.js";
import { morningQueuesDir } from "./needs/morning-source.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";
import {
  DEPLOY_NOW_LABEL,
  nodeWantedStore,
  PACER_SWEEP_MS,
  pacerStatus,
  pacerTick,
  readWanted,
  withWaiting,
  type DeployPacerOptions,
  type ExpressProbe,
  type GreenProbe,
  type GreenRead,
  type PacerMemo,
} from "./shepherd/deploy-pacer.js";
import { failureOf } from "./shepherd/error-class.js";
import { deployPacerPorts } from "./shepherd/redeploy.js";
import { startSweep, type Sweep } from "./sweep.js";

/** What the sweep reads from the running service. */
interface ServiceView {
  now: () => number;
  runningSha: string;
  /** The `/health` busy count, so a deploy waits for review and merge steps to finish. */
  busy: () => number;
}

const pauseReadPorts = { exists: existsSync, readFile: (path: string) => readFileSync(path, "utf8") };

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

const LabelNames = z.array(z.string());

/** Any gh failure reads as unlabelled, so a GitHub outage falls back to normal pacing instead of deploying early. */
async function carriesDeployNow(run: Run, repo: string, sha: string): Promise<boolean> {
  const result = await run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", "[.[].labels[].name]"]);
  if (result?.code !== 0) return false;
  try {
    return LabelNames.parse(JSON.parse(result.stdout)).includes(DEPLOY_NOW_LABEL);
  } catch {
    return false;
  }
}

/** A label found stays found for that sha; a miss is asked again, since the label may be added after the merge. */
export function ghDeployNow(repo: string, run: Run = runCommand): ExpressProbe {
  const labelled = new Set<string>();
  return async (sha) => {
    if (labelled.has(sha)) return true;
    const found = await carriesDeployNow(run, repo, sha);
    if (found) labelled.add(sha);
    return found;
  };
}

const MainRuns = z.array(z.object({ sha: z.string(), status: z.string(), conclusion: z.string().nullable() }));
type MainRun = z.infer<typeof MainRuns>[number];

/**
 * `runs` is newest first, as GitHub lists them. Only the ask's own newest run counts for it, and a fallback must be older than it and green on its own newest run,
 * so neither an in_progress, cancelled nor skipped run, nor another sha's success, ever stands in for it (TP-4279).
 */
export function greenAmong(wanted: string, runs: readonly MainRun[]): GreenRead {
  const at = runs.findIndex((run) => run.sha === wanted);
  const own = runs[at];
  if (own === undefined) return { why: `no ci.yml push run on main is listed for ${wanted}` };
  if (own.conclusion === "success") return { sha: wanted };
  const why = `the own CI run of ${wanted} is ${own.conclusion ?? own.status}`;
  const fallback = runs.slice(at + 1).find((run) => run.conclusion === "success" && runs.find((other) => other.sha === run.sha) === run);
  return fallback === undefined ? { why: `${why}, and no older listed main sha has a green run` } : { sha: fallback.sha, why };
}

/** Any gh failure answers with no sha, so a GitHub outage holds the deploy instead of passing it unchecked. */
export function ghMainGreen(repo: string, run: Run = runCommand): GreenProbe {
  return async (wanted) => {
    const jq = "[.workflow_runs[] | {sha: .head_sha, status, conclusion}]";
    const result = await run("gh", ["api", `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=50`, "--jq", jq]);
    if (result?.code !== 0) return { why: `main's ci.yml runs could not be read${result === undefined ? "" : `: ${result.stderr.trim()}`}` };
    try {
      return greenAmong(wanted, MainRuns.parse(JSON.parse(result.stdout)));
    } catch (error) {
      return { why: `main's ci.yml runs did not parse: ${failureOf(error)}` };
    }
  };
}

const NO_REPO: GreenProbe = async () => ({ why: "this build names no factory repo, so main CI cannot be read" });

/** What the tick needs that only an async probe can answer, keyed by the wanted sha it was asked about. */
interface Settled {
  held: Set<string>;
  express?: string;
  green?: { wanted: string; read: GreenRead };
}

const holds = async (options: DeployPacerOptions, runningSha: string, sha: string): Promise<boolean> =>
  options.isAncestor !== undefined && (await runningHolds(options.isAncestor, runningSha, sha)) === true;

/** A git failure reads as not held, so the deployer is still asked; a sha already spawned is not looked up on GitHub, since the label no longer changes anything. */
async function settle(options: DeployPacerOptions, runningSha: string): Promise<Settled> {
  const wanted = readWanted(options.stateDir, options.store ?? nodeWantedStore);
  if (wanted === undefined) return { held: new Set() };
  const green = await options.green(wanted.sha);
  const asked = green.sha === undefined || green.sha === wanted.sha ? [wanted.sha] : [wanted.sha, green.sha];
  const held = new Set<string>();
  for (const sha of asked) if (await holds(options, runningSha, sha)) held.add(sha);
  const express = options.express !== undefined && wanted.spawnedSha !== wanted.sha && (await options.express(wanted.sha));
  return { held, green: { wanted: wanted.sha, read: green }, ...(express && { express: wanted.sha }) };
}

/** A read for another sha says nothing about the one the tick found, so it holds the deploy. */
function greenFor(settled: Settled, wanted: string): GreenRead {
  return settled.green?.wanted === wanted ? settled.green.read : { why: `main CI was read for another sha than ${wanted}` };
}

function describeMorningAction(action: MorningHoldAction): string {
  switch (action.kind) {
    case "set":
      return `set from ${action.hold.source}`;
    case "replace":
      return `moved from ${action.from} to ${action.hold.source}`;
    case "clear":
      return `cleared, ${action.source} is gone`;
    case "keep":
      return `kept: ${action.why}`;
  }
}

/**
 * Runs before `pacerTick`, so a tick that sets the hold spawns nothing. The empty-read count lives only here:
 * a serve restart starts it at 0, which needs two fresh empty reads before a clear, so a restart can delay a clear but never cause one.
 * A line is logged only when it differs from the last, so a hold that stands does not log every minute.
 */
function morningHoldStep(queuesDir: string | undefined, stateDir: string, now: () => number, log: Logger): () => void {
  if (queuesDir === undefined) return () => undefined;
  let emptyReads = 0;
  let last: string | undefined;
  const note = (line: string): void => {
    if (line !== last) log.info({}, `deploy pacer: ${line}`);
    last = line;
  };
  return () => {
    try {
      const synced = syncMorningHold(nodeMorningHoldPorts, { stateDir, queuesDir, now: new Date(now()).toISOString(), emptyBefore: emptyReads });
      emptyReads = synced.emptyReads;
      note(`Morning hold ${describeMorningAction(synced.action)}${synced.failed === undefined ? "" : `; ${synced.failed}`}`);
    } catch (error) {
      emptyReads = 0;
      note(`the Morning hold sync failed: ${failureOf(error)}`);
    }
  };
}

/** Keyed by the options object serve hands both the sweep and `/health`, so the two share the last wait with no new serve option. */
const memos = new WeakMap<DeployPacerOptions, PacerMemo>();

function memoOf(options: DeployPacerOptions): PacerMemo {
  const known = memos.get(options);
  if (known !== undefined) return known;
  const memo: PacerMemo = {};
  memos.set(options, memo);
  return memo;
}

/** The first tick is not awaited, so a record a restart already answered clears soon after start without holding it up. */
export function startDeployPacer(options: DeployPacerOptions | undefined, service: ServiceView, log: Logger): Sweep | undefined {
  if (options === undefined) return undefined;
  const { stateDir, spawn } = options;
  const syncMorning = morningHoldStep(options.morningQueuesDir, stateDir, service.now, log);
  const tick = async (): Promise<void> => {
    const settled = await settle(options, service.runningSha);
    syncMorning();
    pacerTick({
      stateDir,
      store: options.store ?? nodeWantedStore,
      now: service.now,
      runningSha: () => service.runningSha,
      runningHolds: (sha) => settled.held.has(sha),
      express: (sha) => sha === settled.express,
      green: (wanted) => greenFor(settled, wanted),
      lastDeploy: () => readLastDeploy(stateDir) ?? undefined,
      deployWindow: () => readDeployWindow(stateDir),
      busy: service.busy,
      paused: () => readDeployHolds(pauseReadPorts, stateDir).held,
      spawn,
      ...(options.maxWaitMs !== undefined && { maxWaitMs: options.maxWaitMs }),
      log: (line) => log.info({}, line),
      waits: memoOf(options),
    });
  };
  const sweep = startSweep(tick, options.sweepMs ?? PACER_SWEEP_MS, "deploy pacer", log);
  void sweep.tick();
  return sweep;
}

/** Absent without a pacer, so a serve that does not pace deploys reports nothing it does not do. */
export function deployPendingHealth(options: DeployPacerOptions | undefined): { deployPending?: ReturnType<typeof pacerStatus> } {
  if (options === undefined) return {};
  return { deployPending: withWaiting(pacerStatus(readWanted(options.stateDir, options.store ?? nodeWantedStore), options.maxWaitMs), memoOf(options).wait) };
}

/** The same bin and state dir `workflows.ts` gives Shepherd's redeploy step, so the queue and the sweep share one record. */
export const configuredDeployPacer = (env: NodeJS.ProcessEnv, checkout: string): DeployPacerOptions => ({
  ...deployPacerPorts({ bin: fileURLToPath(new URL("./bin.js", import.meta.url)), stateDir: factoryStateDir(env) }),
  isAncestor: cachedAncestry(gitAncestry(checkout)),
  morningQueuesDir: morningQueuesDir(env),
  green: FACTORY_REPO === undefined ? NO_REPO : ghMainGreen(FACTORY_REPO),
  ...(FACTORY_REPO !== undefined && { express: ghDeployNow(FACTORY_REPO) }),
});
