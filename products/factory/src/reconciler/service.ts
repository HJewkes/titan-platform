import type { Logger } from "@titan-design/daemon";
import { POOL_PRIORITY, isPoolUnavailable, type Ancestry, type BackstopRequest, type BackstopSnapshot, type CallClass, type GithubApiPool, type PoolAnswer, type PoolStateStore, type RulesetList } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { hasBotIntent, markNotFactory } from "../bot-intent.js";
import { appendEvent, type NewEvent } from "../event-log/event-log.js";
import { startReconcilerSchedule } from "../github-sources/schedule.js";
import type { PassStamp, SourcesReader } from "../github-sources/mode.js";
import type { Sweep } from "../sweep.js";
import type { ReconcilerConfig } from "./config.js";
import { sqliteReconcilerCursor, type ReconcilerCursorStore, type RepoCursor } from "./cursor.js";
import { guardVerdicts, type GuardVerdictDeps } from "./guard-verdicts.js";
import type { HeadTipGuard } from "./observe.js";
import { botActions, unloggedActions } from "./unlogged.js";

/** With no cursor, `main` and `done` are read this far back. */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRANCH = "main";

/** S2's conditional gates (TP-3428): whether the open list, the branch ref or the rulesets changed since `etags`. */
interface GateRead {
  changed: boolean;
  etags: Record<string, string | null>;
  /** The REST reads the gate sent, and how many of them answered 304, for the cost line. */
  reads: number;
  notModified: number;
  /** The ruleset list, present only when it changed and was readable; observe diffs it against the cursor. */
  rulesets?: RulesetList;
}

/** Every GitHub read the reconciler makes is one of these, sent only through the bot's pool. */
export type BackstopCall =
  | { kind: "gates"; repo: string; etags: Record<string, string | null> }
  | { kind: "snapshot"; request: BackstopRequest }
  | { kind: "ancestry"; repo: string; base: string; head: string };

/** The pool classifies status and headers; the service reads the one value its call asked for. */
export interface BackstopAnswer extends PoolAnswer {
  gates?: GateRead;
  snapshot?: BackstopSnapshot;
  ancestry?: Ancestry;
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
export type Observe = (repo: string, snapshot: BackstopSnapshot, cursor: RepoCursor, rulesets: RulesetList | undefined, guard: HeadTipGuard) => Observation;

/** What the bot side supplies (TP-3431 wires the real ones); no other GitHub handle reaches the service. */
export interface BotPorts {
  identity: string;
  /** The bot's GitHub login, so C7 can tell its reviews, statuses and merges from everyone else's. */
  login: string;
  pool: GithubApiPool<BackstopCall, BackstopAnswer>;
  /** The pool's pair state: a backstop claim waits while any pair is closed, so the service refuses itself instead. */
  poolState: PoolStateStore;
  /** False until S2 lands: every tick then snapshots every repo. */
  conditionalGates: boolean;
  /** `git ls-remote`, TP-3097's second opinion on a head or tip; it spends no rate-limit point, so it is no pool claim. */
  lsRemote: GuardVerdictDeps["lsRemote"];
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
        await costedUnit(repo, state, config.fullEvery, deps).catch((err: unknown) => deps.log.warn({ repo, err }, "reconciler.unit-failed"));
      }
    },
  };
}

/** With no gate wired, every tick reads as a change. */
const UNGATED: GateRead = { changed: true, etags: {}, reads: 0, notModified: 0 };

/** What one repo's pass spent, for F11's API-use reading: GraphQL points, REST reads, 304s among them, and the rows it appended by kind. */
interface PassCost {
  graphqlCost: number;
  restCalls: number;
  notModified: number;
  appended: Record<string, number>;
}

/** One `reconciler.cost` line per repo per pass, a skipped or failed one included, so a pass that spent nothing says so. */
async function costedUnit(repo: string, state: RepoState, fullEvery: number, deps: ReconcilerDeps): Promise<void> {
  const cost: PassCost = { graphqlCost: 0, restCalls: 0, notModified: 0, appended: {} };
  try {
    await runUnit(repo, state, fullEvery, deps, cost);
  } finally {
    deps.log.info({ repo, ...cost }, "reconciler.cost");
  }
}

type Claimed<K extends keyof BackstopAnswer> = { refused: true } | { refused: false; value: NonNullable<BackstopAnswer[K]> };

/**
 * The start pass reads the gates too, so its ETags vouch for the next tick. A read's ETags are kept only once its pass
 * lands: a refused or failed snapshot leaves the old ones, and the next read answers the same change again.
 */
async function runUnit(repo: string, state: RepoState, fullEvery: number, deps: ReconcilerDeps, cost: PassCost): Promise<void> {
  if (closedPair(deps) !== undefined) return skip(repo, state, deps);
  const gates = deps.conditionalGates ? await readGates(repo, state, deps, cost) : UNGATED;
  if (gates === undefined) return skip(repo, state, deps);
  if (!state.forced && !gates.changed && !state.pending && state.quietTicks + 1 < fullEvery) {
    granted(state);
    Object.assign(state, { quietTicks: state.quietTicks + 1, etags: gates.etags });
    return;
  }
  const cursor = deps.cursor.read(repo);
  const snapshot = await claim(deps, "graphql", { kind: "snapshot", request: requestFor(repo, cursor, deps.now()) }, "snapshot");
  if (snapshot.refused) return skip(repo, state, deps);
  granted(state);
  cost.graphqlCost += snapshot.value.rateLimit.cost;
  const guard = await guardVerdicts(repo, snapshot.value, cursor, { db: deps.db, now: deps.now, lsRemote: deps.lsRemote, ancestry: (...args) => readAncestry(deps, cost, ...args) });
  const observation = deps.observe(repo, snapshot.value, cursor, gates.rulesets, guard);
  appendAll(repo, observation, deps, cost);
  flagUnlogged(repo, snapshot.value, deps);
  deps.cursor.write(repo, observation.cursor);
  Object.assign(state, { forced: false, quietTicks: 0, pending: hasPending(snapshot.value), etags: gates.etags });
}

/** Undefined when the pool refused the gates claim. */
async function readGates(repo: string, state: RepoState, deps: ReconcilerDeps, cost: PassCost): Promise<GateRead | undefined> {
  const gates = await claim(deps, "core-read", { kind: "gates", repo, etags: state.etags }, "gates");
  if (gates.refused) return undefined;
  cost.restCalls += gates.value.reads;
  cost.notModified += gates.value.notModified;
  return gates.value;
}

const REFUSED = { kind: "unavailable" } as const;

/** The guard's compare, as a claim like any other read; a refused one leaves its head unconfirmed this pass. */
async function readAncestry(deps: ReconcilerDeps, cost: PassCost, repo: string, base: string, head: string): Promise<Ancestry | typeof REFUSED> {
  const answer = await claim(deps, "core-read", { kind: "ancestry", repo, base, head }, "ancestry");
  if (answer.refused) return REFUSED;
  cost.restCalls += 1;
  return answer.value;
}

async function claim<K extends "gates" | "snapshot" | "ancestry">(deps: ReconcilerDeps, callClass: CallClass, call: BackstopCall, field: K): Promise<Claimed<K>> {
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

function appendAll(repo: string, observation: Observation, deps: ReconcilerDeps, cost: PassCost): void {
  for (const event of observation.events) {
    const result = appendEvent(deps.db, { ...event, source: "backstop" });
    if (result.inserted) cost.appended[event.kind] = (cost.appended[event.kind] ?? 0) + 1;
    if (result.inserted) deps.log.info({ repo, kind: event.kind, seq: result.seq }, "reconciler.filled");
    else deps.log.info({ repo, kind: event.kind, seq: result.seq, by: result.by }, "reconciler.confirmed");
  }
  for (const { class: disagree, subject, detail } of observation.disagreements) deps.log.info({ repo, class: disagree, subject, detail }, "reconciler.disagree");
}

/**
 * TP-3094 C7: a bot write with no factory intent row. Intent rows are written before the call, so one that exists at all
 * exists by the time a pass reads the write. The mark persists, so each action alarms once, not on every pass that re-reads it.
 */
function flagUnlogged(repo: string, snapshot: BackstopSnapshot, deps: ReconcilerDeps): void {
  const observedAt = new Date(deps.now()).toISOString();
  const missing = unloggedActions(botActions(snapshot, deps.login), (kind, subject) => hasBotIntent(deps.db, repo, kind, subject));
  for (const action of missing) {
    if (!markNotFactory(deps.db, { repo, ...action, observedAt })) continue;
    deps.log.warn({ repo, kind: action.kind, id: action.id, subject: action.subject }, `ops-alarm BotActionUnlogged ${repo} ${action.kind} ${action.id}`);
  }
}

const TERMINAL_STATUS = new Set(["SUCCESS", "FAILURE", "ERROR"]);

/** A check not yet completed or a status still pending keeps the repo snapshotting each tick, because no gate sees it finish. */
export function hasPending(snapshot: BackstopSnapshot): boolean {
  const commits = [...snapshot.open.flatMap((pr) => (pr.head ? [pr.head] : [])), ...snapshot.main.commits];
  return commits.some((commit) => commit.contexts.some((context) => (context.kind === "check" ? context.status !== "COMPLETED" : !TERMINAL_STATUS.has(context.state))));
}

interface ReconcilerServeOptions {
  config: ReconcilerConfig;
  bot: BotPorts;
}

/**
 * Off unless `reconciler.enabled`. Passes run at the effective sources mode's interval (TP-3099), not `reconciler.intervalMs`.
 * The first tick is the forced start pass, and it is not awaited: serve never waits on GitHub.
 */
export function startReconcilerSweep(options: ReconcilerServeOptions | undefined, sources: SourcesReader, db: Db, log: Logger, now: () => number = Date.now, stamp?: PassStamp): Sweep | undefined {
  if (!options?.config.enabled) return undefined;
  const { config, bot } = options;
  const service = createReconciler(config, { ...bot, db, cursor: sqliteReconcilerCursor(db, now), log, now });
  const schedule = startReconcilerSchedule({ sources, pass: (signal) => service.tick(signal), now, log, stamp });
  void schedule.tick();
  const { effective, reason, intervalMs } = sources();
  log.info({ repos: config.repos, effective, reason, intervalMs }, "reconciler.started");
  return schedule;
}
