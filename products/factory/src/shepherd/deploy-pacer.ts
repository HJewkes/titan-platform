import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AncestryProbe } from "../build-ancestry.js";
import type { DeployRecord } from "../deploy.js";
import { failureOf } from "./error-class.js";

export const DEPLOY_WANTED = "deploy-wanted.json";
/** No newer green merge for this long means the burst is over. */
export const DEPLOY_QUIET_MS = 15 * 60_000;
/** Steady merges or busy runs never hold a wanted deploy longer than this. */
export const DEPLOY_MAX_WAIT_MS = 90 * 60_000;
/** Longer than a deployer's own worst case (45 min drain, install, build, watch), so a live deployer is never asked twice. */
export const DEPLOY_STALE_SPAWN_MS = 2 * 60 * 60_000;
/** How often serve runs `pacerTick`. */
export const PACER_SWEEP_MS = 60_000;

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
  | { kind: "wait"; why: string; until?: number }
  | { kind: "spawn"; sha: string; stale?: boolean };

interface PaceInput {
  wanted: DeployWanted | undefined;
  now: number;
  runningSha: string;
  /** The running build descends from the wanted sha, so a later commit deployed by hand already answered it. */
  runningHoldsWanted?: boolean;
  lastDeploy?: DeployRecord | undefined;
  busy: number;
  /** TP-2268's rollback pause: the deployer would refuse, so nothing is spawned until a person clears it. */
  paused: boolean;
  quietMs: number;
  maxWaitMs: number;
  staleSpawnMs: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (at: string): number => Date.parse(at);

/**
 * A repeat of the same sha keeps `lastAt`, so a replayed step cannot extend the wait.
 * A sha after a spawn starts its own window: the old `firstAt` is past the cap, and keeping it would spawn once per merge while the spawned deploy drains.
 */
export function noteWanted(previous: DeployWanted | undefined, sha: string, now: number): DeployWanted {
  if (previous?.sha === sha) return previous;
  const firstAt = previous?.spawnedSha === undefined ? previous?.firstAt : undefined;
  return { sha, firstAt: firstAt ?? iso(now), lastAt: iso(now) };
}

/** A record before the request is an older deploy of the same sha, such as a rollback, so it does not answer this one. */
function recorded(wanted: DeployWanted, lastDeploy: DeployRecord | undefined): boolean {
  if (lastDeploy?.target !== wanted.sha) return false;
  return ms(lastDeploy.at) >= ms(wanted.spawnedAt ?? wanted.firstAt);
}

/** A deployer that refused, answered "already deployed" or died writes no deploy.json; it is asked once more, then the record is dropped until the next merge. */
function spawnedRule(wanted: DeployWanted, input: PaceInput): PaceDecision | undefined {
  if (wanted.spawnedSha !== wanted.sha) return undefined;
  const staleAt = ms(wanted.spawnedAt ?? wanted.firstAt) + input.staleSpawnMs;
  if (input.now < staleAt) return { kind: "wait", why: `deployer already started for ${wanted.sha}`, until: staleAt };
  if (wanted.respawned === true) return { kind: "clear", why: `two deployers for ${wanted.sha} recorded nothing; the next merge re-arms it` };
  return { kind: "spawn", sha: wanted.sha, stale: true };
}

/** The pacing rules, in order; pure, so the sweep and its tests share it. */
export function paceDecision(input: PaceInput): PaceDecision {
  const { wanted, now, busy, quietMs, maxWaitMs } = input;
  if (wanted === undefined) return { kind: "idle" };
  if (wanted.sha === input.runningSha) return { kind: "clear", why: `the service runs ${wanted.sha}` };
  if (input.runningHoldsWanted === true) return { kind: "clear", why: `the service runs ${input.runningSha}, which contains ${wanted.sha}` };
  if (recorded(wanted, input.lastDeploy)) return { kind: "clear", why: `deploy.json records ${input.lastDeploy?.outcome} for ${wanted.sha}` };
  if (input.paused) return { kind: "wait", why: "deploys are paused; titan-factory service pause --clear lifts it" };
  const spawned = spawnedRule(wanted, input);
  if (spawned !== undefined) return spawned;
  const quietEnds = ms(wanted.lastAt) + quietMs;
  const capEnds = ms(wanted.firstAt) + maxWaitMs;
  if (now < quietEnds && now < capEnds) return { kind: "wait", why: "inside the quiet window", until: Math.min(quietEnds, capEnds) };
  if (busy > 0 && now < capEnds) return { kind: "wait", why: `${busy} busy run(s)`, until: capEnds };
  return { kind: "spawn", sha: wanted.sha };
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

function clearWanted(stateDir: string, store: WantedStore): void {
  store.remove(wantedPath(stateDir));
}

interface PacerDeps {
  stateDir: string;
  store: WantedStore;
  now: () => number;
  runningSha: () => string;
  /** Whether the running build descends from `sha`, settled before the tick since git is async; absent means only an equal sha counts. */
  runningHolds?: (sha: string) => boolean;
  lastDeploy: () => DeployRecord | undefined;
  busy: () => number;
  paused: () => boolean;
  spawn: (sha: string) => { pid?: number | undefined };
  quietMs?: number;
  maxWaitMs?: number;
  staleSpawnMs?: number;
  log: (line: string) => void;
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
  const decision = paceDecision({
    wanted,
    now: deps.now(),
    runningSha: deps.runningSha(),
    runningHoldsWanted: deps.runningHolds?.(wanted.sha) ?? false,
    lastDeploy: deps.lastDeploy(),
    busy: deps.busy(),
    paused: deps.paused(),
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
  writeWanted(deps.stateDir, deps.store, { ...wanted, spawnedSha: decision.sha, spawnedAt: iso(deps.now()), ...(decision.stale && { respawned: true }) });
  if (decision.stale) deps.log(`deploy pacer: the deployer for ${decision.sha} recorded nothing by ${wanted.spawnedAt}; asking once more`);
  const { pid } = deps.spawn(decision.sha);
  deps.log(pid === undefined ? `deploy pacer: the deployer for ${decision.sha} did not start` : `deploy pacer: deployer pid ${pid} deploys ${decision.sha}`);
}

/** What serve needs to run the sweep; `deployPacerPorts` builds it from the same deployer Shepherd's redeploy step uses. */
export interface DeployPacerOptions {
  stateDir: string;
  spawn: (sha: string) => { pid?: number | undefined };
  /** Lets the sweep clear a wanted sha the running build already descends from. */
  isAncestor?: AncestryProbe;
  store?: WantedStore;
  /** How often the sweep runs; defaults to `PACER_SWEEP_MS`. */
  sweepMs?: number;
}

/** One sweep: read, decide, act. Never throws; a failed tick logs and waits for the next. */
export function pacerTick(deps: PacerDeps): PaceDecision {
  try {
    const { wanted, decision } = decide(deps);
    if (wanted !== undefined) act(deps, wanted, decision);
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
}

export function pacerStatus(wanted: DeployWanted | undefined, maxWaitMs = DEPLOY_MAX_WAIT_MS): PacerStatus | null {
  if (wanted === undefined) return null;
  const spawned = wanted.spawnedSha === undefined ? {} : { spawnedSha: wanted.spawnedSha, spawnedAt: wanted.spawnedAt };
  return { sha: wanted.sha, since: wanted.firstAt, deploysBy: iso(ms(wanted.firstAt) + maxWaitMs), ...spawned };
}
