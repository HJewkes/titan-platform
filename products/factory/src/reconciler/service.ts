import type { Logger } from "@titan-design/daemon";
import { POOL_PRIORITY, isPoolUnavailable, type BackstopRequest, type BackstopSnapshot, type CallClass, type GithubApiPool, type PoolAnswer, type PoolStateStore, type RulesetList } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { appendEvent, type NewEvent } from "../event-log/event-log.js";
import { startSweep, type Sweep } from "../sweep.js";
import type { ReconcilerConfig } from "./config.js";
import { sqliteReconcilerCursor, type ReconcilerCursorStore, type RepoCursor } from "./cursor.js";

/** With no cursor, `main` and `done` are read this far back. */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRANCH = "main";

/** S2's conditional gates (TP-3428): whether the open list, the branch ref or the rulesets changed since `etags`. */
interface GateRead {
  changed: boolean;
  etags: Record<string, string | null>;
}

/** Every GitHub read the reconciler makes is one of these, sent only through the bot's pool. */
export type BackstopCall = { kind: "gates"; repo: string; etags: Record<string, string | null> } | { kind: "snapshot"; request: BackstopRequest };

/** The pool classifies status and headers; the service reads the one value its call asked for. */
export interface BackstopAnswer extends PoolAnswer {
  gates?: GateRead;
  snapshot?: BackstopSnapshot;
}

type WithoutSource<E> = E extends NewEvent ? Omit<E, "source" | "deliveryId"> : never;

/** The service stamps `source: backstop` and no delivery id, so an observation cannot pass for a webhook row. */
type BackstopEvent = WithoutSource<NewEvent>;

/** Plan §3 D3, D5, D7 and D8: the disagreements that append nothing of their own. */
type DisagreeClass = "stale-read" | "field-parity" | "main-ancestry-lost" | "unconfirmed";

export interface Observation {
  events: BackstopEvent[];
  disagreements: { class: DisagreeClass; subject: string; detail?: string }[];
  /**
   * `main`: the sha scanned to, held behind a commit whose checks still run so the next read sees them finish; `done`: the
   * newest closed-PR `updatedAt` read; `rulesets`: the id to `updated_at` map as JSON. An absent stream keeps its stored value.
   */
  cursor: { main?: string; done?: string; rulesets?: string };
}

/** S3's pure step (TP-3429): a snapshot and S2's ruleset read against the repo's cursor, as appends and the next cursor. */
export type Observe = (repo: string, snapshot: BackstopSnapshot, cursor: RepoCursor, rulesets?: RulesetList) => Observation;

/** What the bot side supplies (TP-3431 wires the real ones); no other GitHub handle reaches the service. */
export interface BotPorts {
  identity: string;
  pool: GithubApiPool<BackstopCall, BackstopAnswer>;
  /** The pool's pair state: a backstop claim waits while any pair is closed, so the service refuses itself instead. */
  poolState: PoolStateStore;
  /** False until S2 lands: every tick then snapshots every repo. */
  conditionalGates: boolean;
  observe: Observe;
}

export interface ReconcilerDeps extends BotPorts {
  db: Db;
  cursor: ReconcilerCursorStore;
  log: Logger;
  now: () => number;
}

interface RepoState {
  /** Set at start and kept until a snapshot of the repo lands, so a start pass the pool refused is forced again. */
  forced: boolean;
  quietTicks: number;
  pending: boolean;
  etags: Record<string, string | null>;
  refused: { count: number; since: number; starvedLogged: boolean } | null;
}

interface Reconciler {
  tick(signal?: AbortSignal): Promise<void>;
}

const CALL_CLASSES: readonly CallClass[] = ["core-read", "graphql", "mutation"];

export function createReconciler(config: Pick<ReconcilerConfig, "repos" | "fullEvery">, deps: ReconcilerDeps): Reconciler {
  const states = new Map(config.repos.map((repo): [string, RepoState] => [repo, { forced: true, quietTicks: 0, pending: false, etags: {}, refused: null }]));
  return {
    async tick(signal) {
      for (const [repo, state] of states) {
        if (signal?.aborted) return;
        await runUnit(repo, state, config.fullEvery, deps).catch((err: unknown) => deps.log.warn({ repo, err }, "reconciler.unit-failed"));
      }
    },
  };
}

type Claimed<K extends keyof BackstopAnswer> = { refused: true } | { refused: false; value: NonNullable<BackstopAnswer[K]> };

async function runUnit(repo: string, state: RepoState, fullEvery: number, deps: ReconcilerDeps): Promise<void> {
  if (closedPair(deps) !== undefined) return skip(repo, state, deps);
  const changed = state.forced || !deps.conditionalGates || (await readGates(repo, state, deps));
  if (changed === undefined) return skip(repo, state, deps);
  if (!changed && !state.pending && state.quietTicks + 1 < fullEvery) {
    granted(state);
    state.quietTicks += 1;
    return;
  }
  const cursor = deps.cursor.read(repo);
  const snapshot = await claim(deps, "graphql", { kind: "snapshot", request: requestFor(repo, cursor, deps.now()) }, "snapshot");
  if (snapshot.refused) return skip(repo, state, deps);
  granted(state);
  const observation = deps.observe(repo, snapshot.value, cursor);
  appendAll(repo, observation, deps);
  deps.cursor.write(repo, observation.cursor);
  Object.assign(state, { forced: false, quietTicks: 0, pending: hasPending(snapshot.value) });
}

/** Undefined when the pool refused the gates claim. */
async function readGates(repo: string, state: RepoState, deps: ReconcilerDeps): Promise<boolean | undefined> {
  const gates = await claim(deps, "core-read", { kind: "gates", repo, etags: state.etags }, "gates");
  if (gates.refused) return undefined;
  state.etags = gates.value.etags;
  return gates.value.changed;
}

async function claim<K extends "gates" | "snapshot">(deps: ReconcilerDeps, callClass: CallClass, call: BackstopCall, field: K): Promise<Claimed<K>> {
  const answer = await deps.pool.run(POOL_PRIORITY.backstop, callClass, call);
  if (isPoolUnavailable(answer)) return { refused: true };
  const value = answer[field];
  if (value === undefined) throw new Error(`backstop ${call.kind} answered status ${answer.status ?? "none"} with no ${field}`);
  return { refused: false, value };
}

function closedPair(deps: ReconcilerDeps): CallClass | undefined {
  return CALL_CLASSES.find((callClass) => deps.poolState.get(deps.identity, callClass)?.state === "closed");
}

function requestFor(repo: string, cursor: RepoCursor, now: number): BackstopRequest {
  const windowStart = (at: string | undefined) => new Date((at === undefined ? now : Date.parse(at)) - FIRST_WINDOW_MS).toISOString();
  return { repo, branch: BRANCH, since: windowStart(cursor.main?.at), mainCursor: cursor.main?.value ?? null, doneSince: cursor.done?.value ?? windowStart(undefined) };
}

/** A refused claim writes nothing and moves no cursor; the next granted tick reads the whole range from the cursor. */
function skip(repo: string, state: RepoState, deps: ReconcilerDeps): void {
  const refused = (state.refused ??= { count: 0, since: deps.now(), starvedLogged: false });
  refused.count += 1;
  deps.log.info({ repo, skipped: refused.count }, "reconciler.skipped");
  if (refused.count <= 2 || refused.starvedLogged) return;
  refused.starvedLogged = true;
  deps.log.warn({ repo, since: new Date(refused.since).toISOString() }, "reconciler.starved");
}

function granted(state: RepoState): void {
  state.refused = null;
}

function appendAll(repo: string, observation: Observation, deps: ReconcilerDeps): void {
  for (const event of observation.events) {
    const result = appendEvent(deps.db, { ...event, source: "backstop" });
    if (result.inserted) deps.log.info({ repo, kind: event.kind, seq: result.seq }, "reconciler.filled");
    else deps.log.info({ repo, kind: event.kind, seq: result.seq, by: result.by }, "reconciler.confirmed");
  }
  for (const { class: disagree, subject, detail } of observation.disagreements) deps.log.info({ repo, class: disagree, subject, detail }, "reconciler.disagree");
}

const TERMINAL_STATUS = new Set(["SUCCESS", "FAILURE", "ERROR"]);

/** A check not yet completed or a status still pending keeps the repo snapshotting each tick, because no gate sees it finish. */
export function hasPending(snapshot: BackstopSnapshot): boolean {
  const commits = [...snapshot.open.flatMap((pr) => (pr.head ? [pr.head] : [])), ...snapshot.main.commits];
  return commits.some((commit) => commit.contexts.some((context) => (context.kind === "check" ? context.status !== "COMPLETED" : !TERMINAL_STATUS.has(context.state))));
}

export interface ReconcilerServeOptions {
  config: ReconcilerConfig;
  bot: BotPorts;
}

/** Off unless `reconciler.enabled`. The first tick is the forced start pass, and it is not awaited: serve never waits on GitHub. */
export function startReconcilerSweep(options: ReconcilerServeOptions | undefined, db: Db, log: Logger, now: () => number = Date.now): Sweep | undefined {
  if (!options?.config.enabled) return undefined;
  const { config, bot } = options;
  const service = createReconciler(config, { ...bot, db, cursor: sqliteReconcilerCursor(db, now), log, now });
  const sweep = startSweep((signal) => service.tick(signal), config.intervalMs, "reconciler", log);
  void sweep.tick();
  log.info({ repos: config.repos, intervalMs: config.intervalMs }, "reconciler.started");
  return sweep;
}
