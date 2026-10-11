import { join } from "node:path";
import { z } from "zod";
import type { DeployRecord } from "../deploy.js";
import { failureOf } from "./error-class.js";

export const DEPLOY_WANTED = "deploy-wanted.json";
/** No newer green merge for this long means the burst is over. */
export const DEPLOY_QUIET_MS = 15 * 60_000;
/** Steady merges or busy runs never hold a wanted deploy longer than this. */
export const DEPLOY_MAX_WAIT_MS = 90 * 60_000;

export const DeployWanted = z.object({
  sha: z.string(),
  firstAt: z.string(),
  lastAt: z.string(),
  spawnedSha: z.string().optional(),
  spawnedAt: z.string().optional(),
});

export type DeployWanted = z.infer<typeof DeployWanted>;

type PaceDecision =
  | { kind: "idle" }
  | { kind: "clear"; why: string }
  | { kind: "wait"; why: string; until?: number }
  | { kind: "spawn"; sha: string };

interface PaceInput {
  wanted: DeployWanted | undefined;
  now: number;
  runningSha: string;
  lastDeploy?: DeployRecord | undefined;
  busy: number;
  quietMs: number;
  maxWaitMs: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (at: string): number => Date.parse(at);

/** A repeat of the same sha keeps `lastAt`, so a replayed step cannot extend the wait. */
export function noteWanted(previous: DeployWanted | undefined, sha: string, now: number): DeployWanted {
  if (previous?.sha === sha) return previous;
  return { sha, firstAt: previous?.firstAt ?? iso(now), lastAt: iso(now) };
}

/** A record before the request is an older deploy of the same sha, such as a rollback, so it does not answer this one. */
function recorded(wanted: DeployWanted, lastDeploy: DeployRecord | undefined): boolean {
  if (lastDeploy?.target !== wanted.sha) return false;
  return ms(lastDeploy.at) >= ms(wanted.spawnedAt ?? wanted.firstAt);
}

/** The pacing rules, in order; pure, so the sweep and its tests share it. */
export function paceDecision(input: PaceInput): PaceDecision {
  const { wanted, now, busy, quietMs, maxWaitMs } = input;
  if (wanted === undefined) return { kind: "idle" };
  if (wanted.sha === input.runningSha) return { kind: "clear", why: `the service runs ${wanted.sha}` };
  if (recorded(wanted, input.lastDeploy)) return { kind: "clear", why: `deploy.json records ${input.lastDeploy?.outcome} for ${wanted.sha}` };
  if (wanted.spawnedSha === wanted.sha) return { kind: "wait", why: `deployer already started for ${wanted.sha}` };
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

const wantedPath = (stateDir: string): string => join(stateDir, DEPLOY_WANTED);

/** A torn or unreadable file reads as none, so the next green merge re-arms it. */
export function readWanted(stateDir: string, store: WantedStore): DeployWanted | undefined {
  try {
    const text = store.readFile(wantedPath(stateDir));
    if (text === undefined) return undefined;
    const parsed = DeployWanted.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Written beside the record and renamed over it, so a reader never sees half a file. */
export function writeWanted(stateDir: string, store: WantedStore, wanted: DeployWanted): void {
  const path = wantedPath(stateDir);
  store.writeFile(`${path}.tmp`, `${JSON.stringify(wanted)}\n`);
  store.rename(`${path}.tmp`, path);
}

function clearWanted(stateDir: string, store: WantedStore): void {
  store.remove(wantedPath(stateDir));
}

interface PacerDeps {
  stateDir: string;
  store: WantedStore;
  now: () => number;
  runningSha: () => string;
  lastDeploy: () => DeployRecord | undefined;
  busy: () => number;
  spawn: (sha: string) => { pid?: number | undefined };
  quietMs?: number;
  maxWaitMs?: number;
  log: (line: string) => void;
}

function decide(deps: PacerDeps): { wanted: DeployWanted | undefined; decision: PaceDecision } {
  const wanted = readWanted(deps.stateDir, deps.store);
  if (wanted === undefined) return { wanted, decision: { kind: "idle" } };
  const decision = paceDecision({
    wanted,
    now: deps.now(),
    runningSha: deps.runningSha(),
    lastDeploy: deps.lastDeploy(),
    busy: deps.busy(),
    quietMs: deps.quietMs ?? DEPLOY_QUIET_MS,
    maxWaitMs: deps.maxWaitMs ?? DEPLOY_MAX_WAIT_MS,
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
  writeWanted(deps.stateDir, deps.store, { ...wanted, spawnedSha: decision.sha, spawnedAt: iso(deps.now()) });
  const { pid } = deps.spawn(decision.sha);
  deps.log(pid === undefined ? `deploy pacer: the deployer for ${decision.sha} did not start` : `deploy pacer: deployer pid ${pid} deploys ${decision.sha}`);
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
}

export function pacerStatus(wanted: DeployWanted | undefined, maxWaitMs = DEPLOY_MAX_WAIT_MS): PacerStatus | null {
  if (wanted === undefined) return null;
  return { sha: wanted.sha, since: wanted.firstAt, deploysBy: iso(ms(wanted.firstAt) + maxWaitMs) };
}
