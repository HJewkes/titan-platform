import { randomUUID } from "node:crypto";
import type { Logger } from "@titan-design/daemon";
import { githubApiPool, memoryPoolStateStore, type BackstopSnapshot } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { ciKey, type CiKeyFn } from "../../event-log/ci-keys.js";
import { headSeq, readEvents } from "../../event-log/event-log.js";
import { factoryMigrations } from "../../host.js";
import { resolveSources, type SOURCES_MODES, type SourcesReader } from "../../github-sources/mode.js";
import { DUE_CHECK_TICK_MS } from "../../github-sources/schedule.js";
import { answerDelivery, type IngressAnswer, type IngressDeps } from "../../ingress/answer.js";
import { projectDelivery } from "../../ingress/kinds.js";
import { INGRESS_PATH } from "../../ingress/paths.js";
import { signDelivery } from "../../ingress/signature.js";
import { createObserve } from "../../reconciler/observe.js";
import { startReconcilerSweep, type BackstopAnswer, type BackstopCall, type BotPorts } from "../../reconciler/service.js";
import type { Sweep } from "../../sweep.js";
import { fakePoolClock, rateLimitAnswer } from "../pool-clock.js";
import { checkRunDelivery, rollupContext, statusDelivery, type CiFact } from "./ci-shapes.js";
import { rekeyedObservation, rekeyedProjection } from "./rekey.js";

export type A17Mode = (typeof SOURCES_MODES)[number];

/** How an append resolved: a new row, a repeat of a delivery id, or a repeat of the occurrence. */
export type Step = "inserted" | "delivery" | "occurrence";

/**
 * What an A17 case sees of GitHub. It has no `mode` field: a case writes its scenario once as facts on a timeline and the
 * feed turns them into the mode's observations, through the ingress handler and the reconciler's schedule as serve runs
 * them. Where the modes must differ, `pick` makes both answers explicit.
 */
export interface Feed {
  db: Db;
  /** Epoch milliseconds of the fake clock; moves only by `advance`. */
  now(): number;
  /** Moves the fake clock by `ms`, or by one reconciler interval of the mode, running each 15 s due-check on the way. */
  advance(ms?: number): Promise<void>;
  /**
   * A state that holds across a reconciler tick: GitHub shows it and sends its delivery, then one interval passes. Webhook:
   * the ingress stores it and the backstop re-observes it. Polling: the ingress answers 404 and the pass observes it.
   */
  fact(fact: CiFact, options?: { deliveryId?: string }): Promise<Step[]>;
  /** A state that holds between two ticks only: its delivery is sent and no pass sees it. Polling never observes it. */
  transient(fact: CiFact): Promise<Step[]>;
  /** The fact's delivery as GitHub posts it, signed with the feed's webhook secret unless `secret` says otherwise. */
  post(fact: CiFact, options?: { deliveryId?: string; secret?: string }): Promise<IngressAnswer>;
  /** Reconciler passes so far, the start pass included. */
  passes(): number;
  read(subject: string, sinceSeq: number): ReturnType<typeof readEvents>;
  headSeq(): number;
  /** The expectation for each mode, both required; the one way a case may state a divergence the modes are declared to have. */
  pick<T>(byMode: Record<A17Mode, T>): T;
  /** Stops the schedule's timer. */
  close(): void;
}

interface FeedOptions {
  key?: CiKeyFn;
  /** The config file's interval fields; `sources` and `ingress` are the mode's. */
  github?: { pollingIntervalMs?: number; backstopIntervalMs?: number };
}

/** The synthetic repos the feed's reconciler reads; a fact on any other repo is refused. */
const FEED_REPOS = ["o/r", "o/x", "o/y"] as const;

const EPOCH = Date.parse("2026-10-17T12:00:00.000Z");
const WEBHOOK_SECRET = "5e".repeat(32);
const BOT = "synthetic-bot[bot]";
const PR = 1;
const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: "2026-10-17T13:00:00Z", queries: 1 };

interface LogLine {
  msg: string;
  fields: Record<string, unknown>;
}

function sourcesFor(mode: A17Mode, github: FeedOptions["github"] = {}): SourcesReader {
  const resolved = resolveSources({ github: mode === "webhook" ? { ...github, sources: "webhook", ingress: "on" } : { ...github, sources: "polling" } });
  if (resolved.effective !== mode) throw new Error(`harness config resolved to ${resolved.effective}, not ${mode}`);
  return () => resolved;
}

function recordingLog(lines: LogLine[]): Logger {
  const record = (fields: Record<string, unknown>, msg: string) => void lines.push({ msg, fields });
  return { info: record, warn: record, error: record };
}

/** GitHub as the snapshot read answers it: each repo's latest fact sits on open PR #1's head, and main has no history. */
function snapshotOf(fact: CiFact | undefined): BackstopSnapshot {
  const open = fact === undefined ? [] : [{ number: PR, headRefOid: fact.head, baseRefName: "main", updatedAt: fact.at, head: { oid: fact.head, contexts: [rollupContext(fact)] }, reviews: [] }];
  return { open, done: [], main: { tip: "0".repeat(40), commits: [] }, rateLimit: RATE_LIMIT };
}

/** The bot's real pool over a fake transport; the tip guard confirms nothing, since no fact moves main. */
function botPorts(world: Map<string, CiFact>, onSnapshot: (repo: string) => void, now: () => number, key: CiKeyFn): BotPorts {
  const send = (call: BackstopCall): Promise<BackstopAnswer> => {
    if (call.kind === "gates") return Promise.resolve({ status: 200, headers: {}, gates: { changed: true, etags: {} } });
    onSnapshot(call.request.repo);
    return Promise.resolve({ status: 200, headers: {}, snapshot: snapshotOf(world.get(call.request.repo)) });
  };
  const poolState = memoryPoolStateStore();
  const pool = githubApiPool<BackstopCall, BackstopAnswer>({ identity: BOT, send, clock: fakePoolClock(EPOCH), state: poolState, probe: () => Promise.resolve(rateLimitAnswer(4999, 4999)) });
  const observe = createObserve({ guard: { confirmHead: () => ({ kind: "confirmed" }), confirmTip: () => ({ kind: "pending" }) }, now });
  return { identity: BOT, pool, poolState, conditionalGates: false, observe: (repo, snapshot, cursor) => rekeyedObservation(observe(repo, snapshot, cursor), key) };
}

function signedRequest(fact: CiFact, guid: string, secret: string) {
  const body = Buffer.from(JSON.stringify(fact.type === "check" ? checkRunDelivery(fact) : statusDelivery(fact)));
  const headers = { "content-type": "application/json", "x-github-event": fact.type === "check" ? "check_run" : "status", "x-github-delivery": guid, "x-hub-signature-256": signDelivery(secret, body) };
  return { method: "POST", path: INGRESS_PATH, headers, body };
}

/** An append's `by`, with a re-observed transition value counted as a repeat of the occurrence. */
function duplicateStep(by: unknown): Step {
  if (by === "unchanged" || by === "occurrence") return "occurrence";
  if (by === "delivery") return "delivery";
  throw new Error(`not an append result: ${String(by)}`);
}

/** A stored delivery is a step; the 404 of an ingress that is off is none; any other answer is a broken fixture. */
function deliveredSteps(answer: IngressAnswer): Step[] {
  if (answer.status === 404 && answer.body.error === "ingress off") return [];
  if (answer.status !== 200) throw new Error(`ingress answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return [answer.body.inserted === true ? "inserted" : duplicateStep(answer.body.by)];
}

/** The reconciler's own append results for the repo's CI row, read from the lines it logs per event. */
function passSteps(lines: LogLine[], repo: string): Step[] {
  const mine = lines.filter((line) => line.fields.repo === repo && line.fields.kind === "CIConcluded");
  return mine.map((line) => (line.msg === "reconciler.filled" ? "inserted" : duplicateStep(line.fields.by)));
}

interface Clock {
  now(): number;
  set(at: number): void;
}

/** Each 15 s mark of the fake clock is one schedule tick, as serve's timer fires it. */
function ticker(clock: Clock, sweep: Sweep) {
  return async (ms: number): Promise<void> => {
    const target = clock.now() + ms;
    for (let mark = nextMark(clock.now()); mark <= target; mark = nextMark(mark)) {
      clock.set(mark);
      await sweep.tick();
    }
    clock.set(target);
  };
}

const nextMark = (at: number): number => EPOCH + (Math.floor((at - EPOCH) / DUE_CHECK_TICK_MS) + 1) * DUE_CHECK_TICK_MS;

function openDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, factoryMigrations());
  return db;
}

export async function openFeed(mode: A17Mode, options: FeedOptions = {}): Promise<Feed> {
  const key = options.key ?? ciKey;
  const sources = sourcesFor(mode, options.github);
  const db = openDb();
  let at = EPOCH;
  const clock: Clock = { now: () => at, set: (next) => void (at = next) };
  const world = new Map<string, CiFact>();
  const lines: LogLine[] = [];
  let passes = 0;
  const bot = botPorts(world, (repo) => void (repo === FEED_REPOS[0] && (passes += 1)), clock.now, key);
  const sweep = startReconcilerSweep({ config: { enabled: true, intervalMs: 300_000, fullEvery: 1, repos: [...FEED_REPOS] }, bot }, sources, db, recordingLog(lines), clock.now);
  if (sweep === undefined) throw new Error("the harness reconciler did not start");
  await sweep.inFlight();
  const ingress: IngressDeps = { sources, secret: () => WEBHOOK_SECRET, project: (event, payload) => rekeyedProjection(projectDelivery(event, payload), key), db, now: clock.now, log: recordingLog([]) };
  return feedOver({ mode, intervalMs: sources().intervalMs, db, clock, world, lines, sweep, ingress, passes: () => passes });
}

interface FeedParts {
  mode: A17Mode;
  /** The schedule's interval for the mode, read from the same config the reconciler reads. */
  intervalMs: number;
  db: Db;
  clock: Clock;
  world: Map<string, CiFact>;
  lines: LogLine[];
  sweep: Sweep;
  ingress: IngressDeps;
  passes(): number;
}

function feedOver({ mode, intervalMs, db, clock, world, lines, sweep, ingress, passes }: FeedParts): Feed {
  const advance = ticker(clock, sweep);
  const guids = new Map<string, string>();
  const guidFor = (name: string | undefined): string => (name === undefined ? randomUUID() : guids.get(name) ?? guids.set(name, randomUUID()).get(name)!);
  const post: Feed["post"] = (f, options) => answerDelivery(signedRequest(f, guidFor(options?.deliveryId), options?.secret ?? WEBHOOK_SECRET), ingress);
  const fact: Feed["fact"] = async (f, options) => {
    if (!(FEED_REPOS as readonly string[]).includes(f.repo)) throw new Error(`the feed's reconciler does not read ${f.repo}`);
    world.set(f.repo, f);
    const delivered = deliveredSteps(await post(f, options));
    const mark = lines.length;
    await advance(intervalMs);
    return [...delivered, ...passSteps(lines.slice(mark), f.repo)];
  };
  return {
    db,
    now: clock.now,
    advance: (ms = intervalMs) => advance(ms),
    fact,
    transient: async (f) => deliveredSteps(await post(f)),
    post,
    passes,
    read: (subject, sinceSeq) => readEvents(db, { subject, sinceSeq }),
    headSeq: () => headSeq(db),
    pick: (byMode) => byMode[mode],
    close: () => sweep.halt(),
  };
}
