import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AncestryProbe } from "../build-ancestry.js";
import type { DeployRecord } from "../deploy.js";
import type { WatchIntent } from "../deploy-watch-window.js";
import { failureOf } from "./error-class.js";

export const DEPLOY_WANTED = "deploy-wanted.json";
/** No newer green merge for this long means the burst is over. */
export const DEPLOY_QUIET_MS = 15 * 60_000;
/** Steady merges or busy runs never hold a wanted deploy longer than this. */
export const DEPLOY_MAX_WAIT_MS = 45 * 60_000;
/** Longer than a deployer's own worst case (45 min drain, install, build, watch), so a live deployer is never asked twice. */
export const DEPLOY_STALE_SPAWN_MS = 2 * 60 * 60_000;
/** Past the window end, longer than the watch can run on (10 min of unavailable reads, three slow misses, the rollback restart), so only a deployer that died is outwaited. */
export const DEPLOY_WATCH_GRACE_MS = 30 * 60_000;
/** How often serve runs `pacerTick`. */
export const PACER_SWEEP_MS = 60_000;
/** The owner's express lane (TP-2338): a merged PR with this label skips the quiet window, and nothing else. */
export const DEPLOY_NOW_LABEL = "deploy:now";

/** Whether the PR merged as `sha` carries `DEPLOY_NOW_LABEL`; settled before the tick since it asks GitHub. */
export type ExpressProbe = (sha: string) => Promise<boolean>;

/**
 * The only sha the pacer may deploy for an ask: one whose own ci.yml push run on main concluded success (TP-4279).
 * `sha` is the ask itself when its run did, else the newest older green sha, with `why` naming the ask's own run; no `sha` holds the ask.
 */
export type GreenRead = { sha: string; why?: string } | { sha?: undefined; why: string };

/** Settled before the tick since it asks GitHub; a failed read answers with no `sha`, so the pacer fails closed. */
export type GreenProbe = (wanted: string) => Promise<GreenRead>;

/** Times must parse: an unparseable one would make every window comparison false and spawn at once. */
const instant = z.iso.datetime({ offset: true });

export const DeployWanted = z.object({
  sha: z.string(),
  firstAt: instant,
  lastAt: instant,
  spawnedSha: z.string().optional(),
  spawnedAt: instant.optional(),
  /** Set by the one spawn after a stale one, so a deployer that never records an answer cannot spawn every timeout. */
  respawned: z.boolean().optional(),
});

export type DeployWanted = z.infer<typeof DeployWanted>;

type PaceDecision =
  | { kind: "idle" }
  | { kind: "clear"; why: string }
  /** `key` names the reason when `why` carries a count, so a count that moves is not a new reason. */
  | { kind: "wait"; why: string; until?: number; key?: string }
  /** `fallback` says why the spawned sha is an older green one in place of the ask. */
  | { kind: "spawn"; sha: string; stale?: boolean; express?: boolean; fallback?: string };

/** A wait as `/health` shows it; `until` is absent for a wait with no end, such as the pause. */
interface PaceWait {
  sha: string;
  why: string;
  until?: string;
  key: string;
}

/** The wait the last sweep decided, kept between sweeps so a standing wait is logged once instead of every minute. */
export interface PacerMemo {
  wait?: PaceWait | undefined;
}

interface PaceInput {
  wanted: DeployWanted | undefined;
  now: number;
  runningSha: string;
  /** The running build descends from the wanted sha, so a later commit deployed by hand already answered it. */
  runningHoldsWanted?: boolean;
  lastDeploy?: DeployRecord | undefined;
  /** deploy-window.json: the open or last health watch, so a build still being watched does not answer an ask before a rollback can undo it. */
  deployWindow?: WatchIntent | undefined;
  busy: number;
  /** TP-2268's rollback pause: the deployer would refuse, so nothing is spawned until a person clears it. */
  paused: boolean;
  /** The wanted sha carries `DEPLOY_NOW_LABEL`: the quiet window is skipped, while the pause, a live deployer and busy runs still hold it. */
  express?: boolean;
  /** What main CI says may deploy for the ask, read at this tick. */
  green: GreenRead;
  /** The running build descends from `green.sha`, so a fallback it already holds is not deployed again. */
  runningHoldsGreen?: boolean;
  quietMs: number;
  maxWaitMs: number;
  staleSpawnMs: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (at: string): number => Date.parse(at);

/**
 * A repeat of the same sha keeps `lastAt`, so a replayed step cannot extend the wait.
 * A sha after a spawn starts its own window: the old `firstAt` is past the cap, and keeping it would spawn once per merge while the spawned deploy drains.
 * `heldBy` is a sha git showed contains `sha`: an older merge whose own run went green late keeps that queued sha, since deploying it would roll the newer one back.
 */
export function noteWanted(previous: DeployWanted | undefined, sha: string, now: number, heldBy?: string): DeployWanted {
  if (previous?.sha === sha || (previous !== undefined && previous.sha === heldBy)) return previous;
  const firstAt = previous?.spawnedSha === undefined ? previous?.firstAt : undefined;
  return { sha, firstAt: firstAt ?? iso(now), lastAt: iso(now) };
}

/** A record before the request is an older deploy of the same sha, such as a rollback, so it does not answer this one. */
function recorded(wanted: DeployWanted, sha: string, lastDeploy: DeployRecord | undefined): boolean {
  if (lastDeploy?.target !== sha) return false;
  return ms(lastDeploy.at) >= ms(wanted.spawnedAt ?? wanted.firstAt);
}

/**
 * Why the running build's deploy is still in its health watch, or undefined once it has passed.
 * The deployer writes deploy.json only after the watch, so a window for the running build with no record of it means the watch, and a possible rollback, are still ahead.
 * No window for the running build means no deployer put it there, so a build started by hand answers as before.
 * A deployer that died mid-watch never writes its record, so past `DEPLOY_WATCH_GRACE_MS` after the window the running build answers as it did before the watch existed.
 */
function inWatch({ runningSha, lastDeploy, deployWindow, now }: PaceInput): string | undefined {
  if (deployWindow?.sha !== runningSha) return undefined;
  if (lastDeploy?.target !== runningSha) return now < deployWindow.windowEnd + DEPLOY_WATCH_GRACE_MS ? `the deploy of ${runningSha} is still in its health watch` : undefined;
  return now < deployWindow.windowEnd ? `the health watch of ${runningSha} runs until ${iso(deployWindow.windowEnd)}` : undefined;
}

/** A build left running by a rollback that failed answers nothing, so the ask goes on to the pause and spawn rules. */
function heldRule(wanted: DeployWanted, input: PaceInput): PaceDecision | undefined {
  const runsWanted = wanted.sha === input.runningSha;
  if (!runsWanted && input.runningHoldsWanted !== true) return undefined;
  if (input.lastDeploy?.target === input.runningSha && input.lastDeploy.outcome === "rolled-back") return undefined;
  const why = inWatch(input);
  if (why !== undefined) return { kind: "wait", why };
  return { kind: "clear", why: runsWanted ? `the service runs ${wanted.sha}` : `the service runs ${input.runningSha}, which contains ${wanted.sha}` };
}

/**
 * A green fallback the service already holds, or that its deployer answered, leaves the ask waiting on its own run: a later read finding it green deploys it, and the next merge replaces it.
 * No `until`, so the wait is never outrun into a deploy of a sha whose own run did not succeed.
 */
function fallbackRule(wanted: DeployWanted, green: { sha: string; why?: string }, input: PaceInput): PaceDecision | undefined {
  if (green.sha === wanted.sha) return undefined;
  const answered = wanted.spawnedSha === green.sha && recorded(wanted, green.sha, input.lastDeploy);
  if (!answered && input.runningHoldsGreen !== true) return undefined;
  const state = answered ? `deploy.json records ${input.lastDeploy?.outcome} for ${green.sha}` : `the service already holds ${green.sha}`;
  return { kind: "wait", why: `${ownRun(wanted, green)}; ${state}, the newest green sha` };
}

const ownRun = (wanted: DeployWanted, green: { why?: string }): string => green.why ?? `the own CI run of ${wanted.sha} has not succeeded`;

/** A deployer that refused, answered "already deployed" or died writes no deploy.json; it is asked once more, then the record is dropped until the next merge. */
function spawnedRule(wanted: DeployWanted, target: string, input: PaceInput): PaceDecision | undefined {
  if (wanted.spawnedSha !== target) return undefined;
  const staleAt = ms(wanted.spawnedAt ?? wanted.firstAt) + input.staleSpawnMs;
  if (input.now < staleAt) return { kind: "wait", why: `deployer already started for ${target}`, until: staleAt };
  if (wanted.respawned === true) return { kind: "clear", why: `two deployers for ${target} recorded nothing; the next merge re-arms it` };
  return { kind: "spawn", sha: target, stale: true };
}

/** The quiet window and busy runs, which hold every first spawn, fallback or not. */
function pacedRule(wanted: DeployWanted, input: PaceInput): PaceDecision | { express: boolean } {
  const { now, busy } = input;
  const quietEnds = ms(wanted.lastAt) + input.quietMs;
  const capEnds = ms(wanted.firstAt) + input.maxWaitMs;
  const quiet = now < quietEnds && now < capEnds;
  const express = quiet && input.express === true;
  if (quiet && !express) return { kind: "wait", why: "inside the quiet window", until: Math.min(quietEnds, capEnds) };
  if (busy > 0 && now < capEnds) return { kind: "wait", why: `${busy} busy run(s)`, until: capEnds, key: "busy runs" };
  return { express };
}

/** The pacing rules, in order; pure, so the sweep and its tests share it. */
export function paceDecision(input: PaceInput): PaceDecision {
  const { wanted, green } = input;
  if (wanted === undefined) return { kind: "idle" };
  const held = heldRule(wanted, input);
  if (held !== undefined) return held;
  if (recorded(wanted, wanted.sha, input.lastDeploy)) return { kind: "clear", why: `deploy.json records ${input.lastDeploy?.outcome} for ${wanted.sha}` };
  if (input.paused) return { kind: "wait", why: "deploys are paused; titan-factory service pause --clear lifts it" };
  if (green.sha === undefined) return { kind: "wait", why: `no green sha to deploy: ${green.why}` };
  const settled = fallbackRule(wanted, green, input) ?? spawnedRule(wanted, green.sha, input);
  if (settled !== undefined) return settled;
  const paced = pacedRule(wanted, input);
  if ("kind" in paced) return paced;
  const fallback = green.sha === wanted.sha ? undefined : ownRun(wanted, green);
  return { kind: "spawn", sha: green.sha, ...(paced.express && { express: true }), ...(fallback !== undefined && { fallback }) };
}

/** The file effects the wanted record has; tests pass fakes. */
export interface WantedStore {
  /** Undefined when the file is absent. */
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
}

const absent = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

export const nodeWantedStore: WantedStore = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    }
  },
  writeFile: (path, text) => writeFileSync(path, text),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

const wantedPath = (stateDir: string): string => join(stateDir, DEPLOY_WANTED);

/** `unreadable` says why a file that exists gave no record. */
interface WantedRead {
  wanted: DeployWanted | undefined;
  unreadable?: string;
}

function loadWanted(stateDir: string, store: WantedStore): WantedRead {
  try {
    const text = store.readFile(wantedPath(stateDir));
    if (text === undefined) return { wanted: undefined };
    const parsed = DeployWanted.safeParse(JSON.parse(text));
    return parsed.success ? { wanted: parsed.data } : { wanted: undefined, unreadable: "it does not match the record shape" };
  } catch (error) {
    return { wanted: undefined, unreadable: failureOf(error) };
  }
}

/** A torn or unreadable file reads as none, so the next green merge re-arms it. */
export function readWanted(stateDir: string, store: WantedStore): DeployWanted | undefined {
  return loadWanted(stateDir, store).wanted;
}

/**
 * Written beside the record and renamed over it, so a reader never sees half a file.
 * The temp name carries the pid, so two processes writing at once cannot rename each other's half-written file.
 */
export function writeWanted(stateDir: string, store: WantedStore, wanted: DeployWanted): void {
  const path = wantedPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  store.writeFile(tmp, `${JSON.stringify(wanted)}\n`);
  store.rename(tmp, path);
}

const clearWanted = (stateDir: string, store: WantedStore): void => store.remove(wantedPath(stateDir));

interface PacerDeps {
  stateDir: string;
  store: WantedStore;
  now: () => number;
  runningSha: () => string;
  /** Whether the running build descends from `sha`, settled before the tick since git is async; absent means only an equal sha counts. */
  runningHolds?: (sha: string) => boolean;
  lastDeploy: () => DeployRecord | undefined;
  /** Absent means no window is known, so the running build answers as soon as it holds the ask. */
  deployWindow?: () => WatchIntent | undefined;
  busy: () => number;
  paused: () => boolean;
  /** Whether `sha` carries `DEPLOY_NOW_LABEL`, settled before the tick; absent means every sha is paced. */
  express?: (sha: string) => boolean;
  /** What main CI says may deploy for the wanted sha, settled before the tick. */
  green: (wanted: string) => GreenRead;
  spawn: DeploySpawn;
  quietMs?: number;
  maxWaitMs?: number;
  staleSpawnMs?: number;
  log: (line: string) => void;
  waits: PacerMemo;
}

/** An unreadable record is removed once logged, so the sweep says so once instead of idling silently every minute. */
function dropUnreadable(deps: PacerDeps, why: string): void {
  deps.log(`deploy pacer: removed an unreadable ${DEPLOY_WANTED} (${why}); the next green merge re-arms it`);
  clearWanted(deps.stateDir, deps.store);
}

function decide(deps: PacerDeps): { wanted: DeployWanted | undefined; decision: PaceDecision } {
  const { wanted, unreadable } = loadWanted(deps.stateDir, deps.store);
  if (unreadable !== undefined) dropUnreadable(deps, unreadable);
  if (wanted === undefined) return { wanted, decision: { kind: "idle" } };
  const green = deps.green(wanted.sha);
  const decision = paceDecision({
    wanted,
    now: deps.now(),
    runningSha: deps.runningSha(),
    runningHoldsWanted: deps.runningHolds?.(wanted.sha) ?? false,
    lastDeploy: deps.lastDeploy(),
    deployWindow: deps.deployWindow?.(),
    busy: deps.busy(),
    paused: deps.paused(),
    express: deps.express?.(wanted.sha) ?? false,
    green,
    runningHoldsGreen: green.sha !== undefined && (deps.runningHolds?.(green.sha) ?? false),
    quietMs: deps.quietMs ?? DEPLOY_QUIET_MS,
    maxWaitMs: deps.maxWaitMs ?? DEPLOY_MAX_WAIT_MS,
    staleSpawnMs: deps.staleSpawnMs ?? DEPLOY_STALE_SPAWN_MS,
  });
  return { wanted, decision };
}

/** The spawn is marked first, so a crash between the two can leave a sha unspawned but never spawn it twice. */
function act(deps: PacerDeps, wanted: DeployWanted, decision: PaceDecision): void {
  if (decision.kind === "clear") {
    clearWanted(deps.stateDir, deps.store);
    deps.log(`deploy pacer: cleared ${wanted.sha}: ${decision.why}`);
  }
  if (decision.kind !== "spawn") return;
  writeWanted(deps.stateDir, deps.store, { ...wanted, spawnedSha: decision.sha, spawnedAt: iso(deps.now()), ...(decision.stale === true && { respawned: true }) });
  if (decision.stale) deps.log(`deploy pacer: the deployer for ${decision.sha} recorded nothing by ${wanted.spawnedAt}; asking once more`);
  if (decision.express) deps.log(`deploy pacer: ${decision.sha} carries ${DEPLOY_NOW_LABEL}; skipping the quiet window`);
  const { pid } = deps.spawn(decision.sha);
  const what = decision.fallback === undefined ? decision.sha : `${decision.sha}, the newest green sha, for ${wanted.sha} (${decision.fallback})`;
  deps.log(pid === undefined ? `deploy pacer: the deployer for ${what} did not start` : `deploy pacer: deployer pid ${pid} deploys ${what}`);
}

/** The deployer builds exactly `sha`, whose own main CI run the pacer read as success. */
export type DeploySpawn = (sha: string) => { pid?: number | undefined };

/** What serve needs to run the sweep; `deployPacerPorts` builds it from the same deployer Shepherd's redeploy step uses. */
export interface DeployPacerOptions {
  stateDir: string;
  spawn: DeploySpawn;
  /** Lets the sweep clear a wanted sha the running build already descends from. */
  isAncestor?: AncestryProbe;
  /** Lets a `DEPLOY_NOW_LABEL` merge skip the quiet window; absent means every merge is paced. */
  express?: ExpressProbe;
  /** Reads main CI before each tick; required, so a pacer wired with no reader never deploys an unchecked sha. */
  green: GreenProbe;
  store?: WantedStore;
  /** The longest steady merges may hold a wanted deploy; defaults to `DEPLOY_MAX_WAIT_MS`. */
  maxWaitMs?: number;
  sweepMs?: number;
  /** The seat queue files whose Morning `DEPLOY HOLD:` items set and clear the manual hold each tick; absent leaves the hold to `service pause`. */
  morningQueuesDir?: string;
}

function waitOf(wanted: DeployWanted | undefined, decision: PaceDecision): PaceWait | undefined {
  if (wanted === undefined || decision.kind !== "wait") return undefined;
  return { sha: wanted.sha, why: decision.why, ...(decision.until !== undefined && { until: iso(decision.until) }), key: decision.key ?? decision.why };
}

/** Without this line a held deploy reads as stuck: nothing else says why the pacer has not spawned (TP-2427). */
function noteWait(deps: PacerDeps, wanted: DeployWanted | undefined, decision: PaceDecision): void {
  const wait = waitOf(wanted, decision);
  const last = deps.waits.wait;
  if (wait !== undefined && (wait.sha !== last?.sha || wait.key !== last.key)) {
    deps.log(`deploy pacer: waiting for ${wait.sha}: ${wait.why}${wait.until === undefined ? "" : ` until ${wait.until}`}`);
  }
  deps.waits.wait = wait;
}

/** One sweep: read, decide, act. Never throws; a failed tick logs and waits for the next. */
export function pacerTick(deps: PacerDeps): PaceDecision {
  try {
    const { wanted, decision } = decide(deps);
    if (wanted !== undefined) act(deps, wanted, decision);
    noteWait(deps, wanted, decision);
    return decision;
  } catch (error) {
    const why = `the pacer tick failed: ${failureOf(error)}`;
    deps.log(`deploy pacer: ${why}`);
    return { kind: "wait", why };
  }
}

interface PacerStatus {
  sha: string;
  since: string;
  /** The cap: a later deploy only happens when the deployer fails. */
  deploysBy: string;
  /** Set once the sweep has started a deployer for this sha. */
  spawnedSha?: string;
  spawnedAt?: string;
  /** Why the last sweep held this sha, absent once it stopped waiting. */
  waiting?: { why: string; until?: string };
}

export function pacerStatus(wanted: DeployWanted | undefined, maxWaitMs = DEPLOY_MAX_WAIT_MS): PacerStatus | null {
  if (wanted === undefined) return null;
  const spawned = wanted.spawnedSha === undefined ? {} : { spawnedSha: wanted.spawnedSha, spawnedAt: wanted.spawnedAt };
  return { sha: wanted.sha, since: wanted.firstAt, deploysBy: iso(ms(wanted.firstAt) + maxWaitMs), ...spawned };
}

/** A wait for an older sha says nothing about the one now queued, so it is shown only when the shas match. */
export function withWaiting(status: PacerStatus | null, wait: PaceWait | undefined): PacerStatus | null {
  if (status === null || wait?.sha !== status.sha) return status;
  return { ...status, waiting: { why: wait.why, ...(wait.until !== undefined && { until: wait.until }) } };
}
