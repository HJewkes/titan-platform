import { GhError, octokitRest, type GatewayBudget, type GitHubClient, type RepoSlug, type Rest } from "@titan-design/github";
import { EXIT, defineCommand, type AnyCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import { coded } from "./register-args.js";

/**
 * One gateway read. `source` says where the body came from: GitHub (a 304 included), this gateway's memory within
 * `maxAgeMs`, or the PR snapshot, whose body is the port's `PullRequest`, not GitHub's JSON.
 */
interface GhReadAnswer {
  status: number;
  body: unknown;
  /** ISO time the body was read from GitHub or the snapshot. */
  at: string;
  /** True when GitHub refused or the lane is cooling down, so this is the last answer the gateway had. */
  stale: boolean;
  source: "github" | "memory" | "snapshot";
}

/** One line per call the gateway really sent, in the gh-calls v1 shape. */
export interface GhCallLine {
  v: 1;
  at: string;
  caller: string;
  method: "GET";
  route: string;
  status: number;
}

interface GhReadRequest {
  path: string;
  maxAgeMs?: number;
  caller?: string;
}

export interface GhGateway {
  read(request: GhReadRequest): Promise<GhReadAnswer>;
  budget(): GatewayBudget;
}

interface GhGatewayDeps {
  /** The process's shared client, so gateway reads spend the same throttled budget as Shepherd's own. */
  client: GitHubClient;
  snapshot?: PrSnapshot;
  now?: () => number;
  onCall?: (line: GhCallLine) => void;
  /** Last answers kept, oldest dropped first: callers name the paths, so without a cap the map grows for as long as serve runs. */
  memoryPaths?: number;
}

const MEMORY_PATHS = 500;

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9_.-]{0,99}";
const PAGING = ["per_page", "page"];

interface Route {
  template: string;
  pattern: RegExp;
  query: readonly string[];
  /** Query keys the route is refused without, so an unscoped list is never read. */
  required?: readonly string[];
}

/** Reads agents make today through `gh`; anything else, writes included, stays on their own `gh`. */
const ROUTES: readonly Route[] = [
  { template: "repos/{owner}/{repo}", pattern: /^$/, query: [] },
  { template: "repos/{owner}/{repo}/pulls", pattern: /^\/pulls$/, query: ["state", "head", "base", "sort", "direction", ...PAGING] },
  { template: "repos/{owner}/{repo}/pulls/{n}", pattern: /^\/pulls\/\d{1,9}$/, query: [] },
  { template: "repos/{owner}/{repo}/pulls/{n}/files", pattern: /^\/pulls\/\d{1,9}\/files$/, query: PAGING },
  { template: "repos/{owner}/{repo}/commits/{sha}/check-runs", pattern: /^\/commits\/[0-9a-f]{7,40}\/check-runs$/, query: ["check_name", "status", "filter", "app_id", ...PAGING] },
  { template: "repos/{owner}/{repo}/commits/{sha}/status", pattern: /^\/commits\/[0-9a-f]{7,40}\/status$/, query: PAGING },
  { template: "repos/{owner}/{repo}/actions/runs", pattern: /^\/actions\/runs$/, query: ["head_sha", "status", "event", "branch", ...PAGING], required: ["head_sha"] },
  { template: "repos/{owner}/{repo}/actions/runs/{id}", pattern: /^\/actions\/runs\/\d{1,20}$/, query: [] },
  { template: "repos/{owner}/{repo}/actions/runs/{id}/jobs", pattern: /^\/actions\/runs\/\d{1,20}\/jobs$/, query: ["filter", ...PAGING] },
];

const REPO_PREFIX = new RegExp(`^repos/(${SEGMENT})/(${SEGMENT})(.*)$`);
const QUERY_VALUE = /^[A-Za-z0-9_.:/@-]{1,200}$/;

interface Matched {
  route: Route;
  repo: RepoSlug;
  /** Set for `pulls/{n}`, the one route the snapshot can answer. */
  pull?: number;
}

/** The whitelist: a path matches one route exactly, with only that route's query keys and plain values. */
function matchRoute(path: string): Matched | undefined {
  const [pathname = "", query = "", ...rest] = path.replace(/^\//, "").split("?");
  const parts = REPO_PREFIX.exec(pathname);
  if (rest.length > 0 || !parts) return undefined;
  const [, owner, name, tail = ""] = parts;
  const route = ROUTES.find((candidate) => candidate.pattern.test(tail));
  const params = new URLSearchParams(query);
  if (!route || ![...params].every(([key, value]) => route.query.includes(key) && QUERY_VALUE.test(value))) return undefined;
  if (!(route.required ?? []).every((key) => params.has(key))) return undefined;
  const pull = route.template.endsWith("/pulls/{n}") ? Number(tail.split("/")[2]) : undefined;
  return { route, repo: `${owner}/${name}`, ...(pull !== undefined && { pull }) };
}

interface Remembered {
  answer: GhReadAnswer;
  readAt: number;
}

/** GitHub's final answers for a missing or unprocessable resource are statuses here, not failures. */
const ANSWERED_STATUSES = new Set([404, 410, 422]);

interface GatewayState {
  deps: GhGatewayDeps;
  now: () => number;
  rest: Rest;
  memory: Map<string, Remembered>;
}

export function ghGateway(deps: GhGatewayDeps): GhGateway {
  const now = deps.now ?? Date.now;
  const state: GatewayState = { deps, now, rest: octokitRest(deps.client), memory: new Map() };
  const memory = state.memory;
  const inFlight = new Map<string, Promise<GhReadAnswer>>();
  return {
    budget: () => deps.client.budget(),
    read: async ({ path, maxAgeMs = 0, caller = "unknown" }) => {
      const matched = matchRoute(path);
      if (!matched) throw coded(`shepherd.ghRead refused ${JSON.stringify(path.slice(0, 200))}: not a whitelisted read route`, EXIT.NOPERM);
      const fromSnapshot = await snapshotPull(deps.snapshot, matched, now);
      if (fromSnapshot) return fromSnapshot;
      const remembered = memory.get(path);
      if (remembered && now() - remembered.readAt < maxAgeMs) return { ...remembered.answer, source: "memory" };
      const pending = inFlight.get(path) ?? fetchFresh(state, path, matched, caller).finally(() => inFlight.delete(path));
      inFlight.set(path, pending);
      return pending;
    },
  };
}

/** A real call, unless the REST lane is cooling down; a refusal serves the last answer as stale. */
async function fetchFresh({ deps, now, rest, memory }: GatewayState, path: string, matched: Matched, caller: string): Promise<GhReadAnswer> {
  const last = memory.get(path);
  if (deps.client.budget().cooldowns.some((cooldown) => cooldown.lane === "rest")) return staleOr(last, `the REST lane is cooling down, and ${path} has no last answer`);
  const at = new Date(now()).toISOString();
  const log = (status: number) => deps.onCall?.({ v: 1, at, caller, method: "GET", route: matched.route.template, status });
  const answer = await readGitHub(rest, path, at).catch((error: unknown) => {
    if (error instanceof GhError && error.status !== undefined) log(error.status);
    return staleOr(last, `GitHub refused ${path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (answer.stale) return answer;
  log(answer.status);
  memory.delete(path);
  memory.set(path, { answer, readAt: now() });
  if (memory.size > (deps.memoryPaths ?? MEMORY_PATHS)) memory.delete(memory.keys().next().value!);
  return answer;
}

async function readGitHub(rest: Rest, path: string, at: string): Promise<GhReadAnswer> {
  try {
    return { status: 200, body: await rest.get(path), at, stale: false, source: "github" };
  } catch (error) {
    if (error instanceof GhError && error.status !== undefined && ANSWERED_STATUSES.has(error.status)) return { status: error.status, body: null, at, stale: false, source: "github" };
    throw error;
  }
}

function staleOr(last: Remembered | undefined, refusal: string): GhReadAnswer {
  if (!last) throw coded(`shepherd.ghRead: ${refusal}`, EXIT.TEMPFAIL);
  return { ...last.answer, stale: true };
}

async function snapshotPull(snapshot: PrSnapshot | undefined, matched: Matched, now: () => number): Promise<GhReadAnswer | undefined> {
  if (!snapshot || matched.pull === undefined) return undefined;
  const row = (await snapshot.openPrs(matched.repo).catch(() => [])).find((pr) => pr.number === matched.pull);
  return row && { status: 200, body: row, at: new Date(now()).toISOString(), stale: false, source: "snapshot" };
}

function gatewayOf(ctx: FactoryContext): GhGateway {
  const gateway = ctx.shepherd?.gateway;
  if (!gateway) throw coded("the GitHub gateway runs only in titan-factory serve, and this host was opened without it", EXIT.UNAVAILABLE);
  return gateway;
}

const GhReadArgs = z.object({
  path: z.string().min(1).max(500),
  /** Present so a non-GET is refused by name rather than read as a GET. */
  method: z.string().default("GET"),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional(),
  caller: z.string().min(1).max(100).default("unknown"),
});

const ghReadCommand = defineCommand<z.infer<typeof GhReadArgs>, GhReadAnswer, FactoryContext>({
  name: "shepherd.ghRead",
  description: "One whitelisted GitHub GET through serve's shared, throttled client and ETag cache; any other route or method is refused",
  args: GhReadArgs,
  result: z.custom<GhReadAnswer>(),
  run: async ({ method, ...request }, ctx) => {
    if (method.toUpperCase() !== "GET") throw coded(`shepherd.ghRead refused method ${JSON.stringify(method.slice(0, 20))}: it only reads`, EXIT.NOPERM);
    return gatewayOf(ctx).read(request);
  },
});

const ghBudgetCommand = defineCommand<Record<string, never>, GatewayBudget, FactoryContext>({
  name: "shepherd.ghBudget",
  description: "The gateway client's live GitHub rate windows and the cooldowns its throttle is waiting out",
  args: z.object({}),
  result: z.custom<GatewayBudget>(),
  run: async (_args, ctx) => gatewayOf(ctx).budget(),
});

export const GH_GATEWAY_COMMANDS: readonly AnyCommand<FactoryContext>[] = [ghReadCommand, ghBudgetCommand];
