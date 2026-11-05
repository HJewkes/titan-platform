import type { Logger } from "@titan-design/daemon";
import { GitHubRequestError, githubApiPool, memoryPoolStateStore, type Ancestry, type BackstopCommit, type GitHubClient, type BackstopSnapshot, type CallClass, type GithubApiPool, type PoolPriority, type RulesetList } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { BotAccess, BotIdentity } from "../bot-identity.js";
import { botIntentMigration } from "../bot-intent.js";
import { eventLogMigration } from "../event-log/event-log.js";
import { headEpochMigration } from "../head-guard/epoch-store.js";
import { mergeLogMigration } from "../merge-log.js";
import { fakePoolClock, rateLimitAnswer, type FakePoolClock } from "../test-support/pool-clock.js";
import { reconcilerCursorMigration, sqliteReconcilerCursor, type ReconcilerCursorStore } from "./cursor.js";
import type { RemoteRef } from "./guard-verdicts.js";
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
  gateEtag = "\"e1\"";
  /** The ruleset list the gates carry when it changed. */
  rulesets: RulesetList | undefined = undefined;
  readonly calls: BackstopCall[] = [];
  /** Holds every snapshot answer until released; for the non-blocking start pass. */
  hold: Promise<void> | null = null;
  /** Replaces the main-only answer with a whole repo, as TP-3099's kind scenario reads it. */
  snapshot: (() => BackstopSnapshot) | null = null;
  /** GitHub's compare; by default every read head descends from the one before it. */
  ancestry: (base: string, head: string) => Ancestry = () => "ahead";
  /** What `ls-remote` answers; by default the ref as the next snapshot shows it. */
  remote: ((ref: RemoteRef) => string | null) | null = null;

  async send(call: BackstopCall): Promise<BackstopAnswer> {
    this.calls.push(call);
    if (this.hold) await this.hold;
    if (this.limited.has(call.kind)) return { status: 429, headers: {} };
    const gates = { changed: this.gatesChanged, etags: { pulls: this.gateEtag }, reads: 3, notModified: this.gatesChanged ? 0 : 3 };
    if (call.kind === "gates") return { status: 200, headers: {}, gates: { ...gates, ...(this.rulesets && { rulesets: this.rulesets }) } };
    if (call.kind === "ancestry") return { status: 200, headers: {}, ancestry: this.ancestry(call.base, call.head) };
    if (this.snapshot) return { status: 200, headers: {}, snapshot: this.snapshot() };
    const stop = this.main.findIndex((c) => c.oid === call.request.mainCursor);
    const commits = stop >= 0 ? this.main.slice(0, stop) : this.main;
    return { status: 200, headers: {}, snapshot: snapshotOf(this.main[0]?.oid ?? "c0", commits) };
  }

  lsRemote(ref: RemoteRef): string | null {
    if (this.remote) return this.remote(ref);
    const shown = this.snapshot?.() ?? snapshotOf(this.main[0]?.oid ?? "c0", []);
    return "pr" in ref ? (shown.open.find((pr) => pr.number === ref.pr)?.headRefOid ?? null) : shown.main.tip;
  }

  count(kind: BackstopCall["kind"], repo = REPO): number {
    return this.calls.filter((call) => call.kind === kind && (call.kind === "snapshot" ? call.request.repo : call.repo) === repo).length;
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
  const lsRemote: BotPorts["lsRemote"] = (_repo, ref) => Promise.resolve(github.lsRemote(ref));
  const bot: BotPorts = { identity: BOT, login: BOT_LOGIN, pool: recordingPool(pool, claims), poolState, conditionalGates: options.conditionalGates ?? false, lsRemote, observe };
  const db = openDatabase(":memory:");
  runMigrations(db, [mergeLogMigration(), eventLogMigration(), headEpochMigration(), reconcilerCursorMigration(), botIntentMigration()]);
  const cursor = sqliteReconcilerCursor(db, clock.now);
  const lines: Rig["lines"] = [];
  const record = (level: "info" | "warn") => (fields: Record<string, unknown>, msg: string) => void lines.push({ level, msg, fields });
  const log: Logger = { info: record("info"), warn: record("warn"), error: record("warn") };
  const rows = () => db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM factory_event").get()?.n ?? 0;
  return { github, clock, claims, bot, db, cursor, lines, log, deps: { ...bot, db, cursor, log, now: clock.now }, rows };
}

/** The REST reads the gates send, and GraphQL; each gate read is named by the etag key it revalidates. */
type BotRoute = "pulls" | "ref" | "rulesets" | "graphql" | "rate_limit" | "compare";

interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface BotRequest {
  route: BotRoute;
  method: string;
  ifNoneMatch: string | undefined;
}

/**
 * A synthetic GitHub client, answering as `octokitClient` does: a 2xx resolves, anything else (a 304 included) throws
 * `GitHubRequestError`, and a `network` failure throws a plain error. Each gate read answers 304 to the ETag of its
 * current version and 200 with that ETag otherwise.
 */
interface FakeBotGithub {
  client: GitHubClient;
  requests: BotRequest[];
  /** Bump a read's version and its next conditional read answers 200 with a new ETag. */
  versions: Record<"pulls" | "ref" | "rulesets", number>;
  /** Answers each read of a route with this until deleted. */
  fail: Map<BotRoute, FakeAnswer | "network">;
  /** Main's newest commit's check; `null` is a check still running. */
  conclusion: string | null;
  /** The `status` GitHub's compare answers. */
  compare: Ancestry;
  count(route: BotRoute): number;
}

interface RequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
}

export function fakeBotGithub(): FakeBotGithub {
  const state: Omit<FakeBotGithub, "client" | "count"> = { requests: [], versions: { pulls: 1, ref: 1, rulesets: 1 }, fail: new Map(), conclusion: "SUCCESS", compare: "ahead" };
  const request = async (route: string | RequestOptions) => {
    const options = typeof route === "string" ? { method: route.split(" ")[0]!, url: route.split(" ")[1]! } : route;
    const sent = { route: routeOf(new URL(options.url, "https://api.github.com").pathname), method: options.method, ifNoneMatch: options.headers?.["if-none-match"] };
    state.requests.push(sent);
    const answered = state.fail.get(sent.route) ?? answer(state, sent);
    if (answered === "network") throw new TypeError("fetch failed");
    const headers = answered.headers ?? {};
    if (answered.status >= 300) throw new GitHubRequestError(`${JSON.stringify(answered.body ?? {})}`, answered.status, headers);
    return { status: answered.status, headers, data: answered.body, url: options.url };
  };
  const client = Object.assign(partialFake<GitHubClient>({ budget: () => ({ lanes: {}, cooldowns: [] }) }), { request });
  return Object.assign(state, { client, count: (route: BotRoute) => state.requests.filter((sent) => sent.route === route).length });
}

function routeOf(path: string): BotRoute {
  if (path === "/graphql") return "graphql";
  if (path === "/rate_limit") return "rate_limit";
  if (path.includes("/compare/")) return "compare";
  if (path.endsWith("/pulls")) return "pulls";
  if (path.endsWith("/git/ref/heads/main")) return "ref";
  if (path.endsWith("/rulesets")) return "rulesets";
  throw new Error(`the fake bot GitHub has no route for ${path}`);
}

function answer(fake: Pick<FakeBotGithub, "versions" | "conclusion" | "compare">, request: BotRequest): FakeAnswer {
  if (request.route === "rate_limit") return { status: 200, body: rateLimitAnswer(4999, 4999).body };
  if (request.route === "compare") return { status: 200, body: { status: fake.compare } };
  if (request.route === "graphql") return { status: 200, body: { data: snapshotData(fake.conclusion) } };
  const etag = `"${request.route}-${fake.versions[request.route]}"`;
  if (request.ifNoneMatch === etag) return { status: 304, headers: { etag } };
  const bodies = { pulls: [], ref: { object: { sha: "c1" } }, rulesets: [{ id: 7, updated_at: `2027-01-15T07:0${fake.versions.rulesets}:00Z` }] };
  return { status: 200, body: bodies[request.route], headers: { etag } };
}

const NO_MORE = { hasNextPage: false, endCursor: null };

/** One page of the snapshot query: no open or closed PRs, main at `c1` with one check, no trains. */
function snapshotData(conclusion: string | null) {
  const running = conclusion === null;
  const check = { __typename: "CheckRun", databaseId: 1001, name: "build", status: running ? "IN_PROGRESS" : "COMPLETED", conclusion, completedAt: running ? null : "2027-01-15T07:00:00Z" };
  const c1 = { oid: "c1", statusCheckRollup: { contexts: { pageInfo: NO_MORE, nodes: [check] } } };
  return {
    rateLimit: { cost: 1, remaining: 4999, resetAt: "2027-01-15T09:00:00Z" },
    repository: {
      open: { pageInfo: NO_MORE, nodes: [] },
      done: { pageInfo: NO_MORE, nodes: [] },
      ref: { target: { oid: "c1", history: { pageInfo: NO_MORE, nodes: [c1] } } },
      trains: { pageInfo: NO_MORE, nodes: [] },
    },
  };
}

/** A capability fake: serve's bot identity, open, with a synthetic client and login; it holds no token. */
export function fakeBotIdentity(client: GitHubClient = fakeBotGithub().client, lsRemote: BotPorts["lsRemote"] = () => Promise.resolve(null)): BotIdentity {
  const access: BotAccess = { state: "ok", client, login: BOT_LOGIN, lsRemote };
  return { access: () => access, health: () => ({ state: "ok", expiresAt: null }), capabilities: {} };
}

interface FetchedRequest {
  route: BotRoute;
  method: string;
  authorization: string | null;
}

/** `fakeBotGithub`'s answers as a `fetch`, for a real `octokitClient` such as the bot identity's; records the credential each request carried. */
export function fakeBotFetch(): { fetch: typeof globalThis.fetch; requests: FetchedRequest[] } {
  const fake = { versions: { pulls: 1, ref: 1, rulesets: 1 }, conclusion: "SUCCESS", compare: "ahead" as Ancestry };
  const requests: FetchedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const route = routeOf(new URL(input instanceof Request ? input.url : String(input)).pathname);
    const method = init?.method ?? "GET";
    requests.push({ route, method, authorization: headers.get("authorization") });
    const answered = answer(fake, { route, method, ifNoneMatch: headers.get("if-none-match") ?? undefined });
    const body = answered.status === 304 ? null : JSON.stringify(answered.body ?? {});
    return new Response(body, { status: answered.status, headers: { "content-type": "application/json", ...answered.headers } });
  };
  return { fetch, requests };
}
