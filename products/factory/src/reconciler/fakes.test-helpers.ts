import type { Logger } from "@titan-design/daemon";
import { githubApiPool, memoryPoolStateStore, type BackstopCommit, type BackstopSnapshot, type CallClass, type GithubApiPool, type PoolPriority } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { botIntentMigration } from "../bot-intent.js";
import { eventLogMigration } from "../event-log/event-log.js";
import { mergeLogMigration } from "../merge-log.js";
import { fakePoolClock, rateLimitAnswer, type FakePoolClock } from "../test-support/pool-clock.js";
import { reconcilerCursorMigration, sqliteReconcilerCursor, type ReconcilerCursorStore } from "./cursor.js";
import type { BackstopAnswer, BackstopCall, BotPorts, Observation, Observe, ReconcilerDeps } from "./service.js";

const BOT = "synthetic-bot[bot]";
export const BOT_LOGIN = "synthetic-bot";
export const REPO = "example-org/widgets";
export const OTHER_REPO = "example-org/gadgets";

export function commit(oid: string, conclusion: string | null = "SUCCESS"): BackstopCommit {
  const completed = conclusion !== null;
  const databaseId = Number.parseInt(oid.replace(/\D/g, "") || "0", 10) + 1000;
  return { oid, contexts: [{ kind: "check", databaseId, name: "build", status: completed ? "COMPLETED" : "IN_PROGRESS", conclusion, completedAt: completed ? "2027-01-15T07:00:00Z" : null }] };
}

/** A synthetic GitHub: main's history newest first, read back to the request's cursor as the real snapshot read does. */
class FakeGithub {
  main: BackstopCommit[] = [commit("c1")];
  /** Kinds answered 429 until cleared. */
  readonly limited = new Set<BackstopCall["kind"]>();
  gatesChanged = false;
  readonly calls: BackstopCall[] = [];
  /** Holds every snapshot answer until released; for the non-blocking start pass. */
  hold: Promise<void> | null = null;
  /** Replaces the main-only answer with a whole repo, as TP-3099's kind scenario reads it. */
  snapshot: (() => BackstopSnapshot) | null = null;

  async send(call: BackstopCall): Promise<BackstopAnswer> {
    this.calls.push(call);
    if (this.hold) await this.hold;
    if (this.limited.has(call.kind)) return { status: 429, headers: {} };
    if (call.kind === "gates") return { status: 200, headers: {}, gates: { changed: this.gatesChanged, etags: { pulls: "\"e1\"" } } };
    if (this.snapshot) return { status: 200, headers: {}, snapshot: this.snapshot() };
    const stop = this.main.findIndex((c) => c.oid === call.request.mainCursor);
    const commits = stop >= 0 ? this.main.slice(0, stop) : this.main;
    return { status: 200, headers: {}, snapshot: snapshotOf(this.main[0]?.oid ?? "c0", commits) };
  }

  count(kind: BackstopCall["kind"], repo = REPO): number {
    return this.calls.filter((call) => call.kind === kind && (call.kind === "gates" ? call.repo : call.request.repo) === repo).length;
  }
}

function snapshotOf(tip: string, commits: BackstopCommit[]): BackstopSnapshot {
  return { open: [], done: [], main: { tip, commits }, trains: [], rateLimit: { cost: 1, remaining: 4999, resetAt: "2027-01-15T09:00:00Z", queries: 1 } };
}

/** Stands in for S3: one identity row per main check context, plus whatever disagreements a test plants. */
export function fakeObserve(disagreements: Observation["disagreements"] = []): Observe {
  return (repo, snapshot) => ({
    events: snapshot.main.commits.flatMap((c) =>
      c.contexts.flatMap((context) =>
        context.kind === "check" && context.conclusion !== null
          ? [
              {
                rule: "identity" as const,
                kind: "CIConcluded",
                repo,
                subject: `${repo}@${c.oid}`,
                keys: { checkRunId: context.databaseId },
                occurrenceKey: `v1|CIConcluded|${repo}|check|${context.databaseId}`,
                observedAt: "2027-01-15T08:00:00Z",
                payload: { conclusion: context.conclusion },
              },
            ]
          : [],
      ),
    ),
    disagreements,
    cursor: { main: snapshot.main.tip, done: "2027-01-15T07:30:00Z" },
  });
}

interface Claim {
  priority: PoolPriority;
  callClass: CallClass;
  kind: BackstopCall["kind"];
}

/** The real pool, with every claim recorded on its way in. */
function recordingPool(pool: GithubApiPool<BackstopCall, BackstopAnswer>, claims: Claim[]): GithubApiPool<BackstopCall, BackstopAnswer> {
  return {
    run: (priority, callClass, call) => (claims.push({ priority, callClass, kind: call.kind }), pool.run(priority, callClass, call)),
    tokenChanged: () => pool.tokenChanged(),
  };
}

interface Rig {
  github: FakeGithub;
  clock: FakePoolClock;
  claims: Claim[];
  bot: BotPorts;
  db: Db;
  cursor: ReconcilerCursorStore;
  lines: { level: "info" | "warn"; msg: string; fields: Record<string, unknown> }[];
  log: Logger;
  deps: ReconcilerDeps;
  rows(): number;
}

export function rig(options: { conditionalGates?: boolean; observe?: Observe } = {}): Rig {
  const github = new FakeGithub();
  const clock = fakePoolClock();
  const claims: Claim[] = [];
  const poolState = memoryPoolStateStore();
  const pool = githubApiPool<BackstopCall, BackstopAnswer>({ identity: BOT, send: (call) => github.send(call), clock, state: poolState, probe: () => Promise.resolve(rateLimitAnswer(4999, 4999)) });
  const observe = options.observe ?? fakeObserve();
  const bot: BotPorts = { identity: BOT, login: BOT_LOGIN, pool: recordingPool(pool, claims), poolState, conditionalGates: options.conditionalGates ?? false, observe };
  const db = openDatabase(":memory:");
  runMigrations(db, [mergeLogMigration(), eventLogMigration(), reconcilerCursorMigration(), botIntentMigration()]);
  const cursor = sqliteReconcilerCursor(db, clock.now);
  const lines: Rig["lines"] = [];
  const record = (level: "info" | "warn") => (fields: Record<string, unknown>, msg: string) => void lines.push({ level, msg, fields });
  const log: Logger = { info: record("info"), warn: record("warn"), error: record("warn") };
  const rows = () => db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM factory_event").get()?.n ?? 0;
  return { github, clock, claims, bot, db, cursor, lines, log, deps: { ...bot, db, cursor, log, now: clock.now }, rows };
}
