import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RATE_FLOOR, ghCliWire, githubPort, sharedRateBudget, type GitHubPort, type GitHubWire, type PrFile, type RateBudget } from "@titan-design/github";
import { EXIT, defineCommand } from "@titan-design/registry";
import { listMergedPrRefs, parsePrRef, type PrDiff } from "@titan-design/session-analytics";
import { openSessionGraph } from "@titan-design/session-graph";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { isoTime } from "../insights/define.js";
import { loggedGitHubPort } from "../insights/gh-call-log.js";

const CACHE_FILE = "pr-diffs.json";
const DEFAULT_CONCURRENCY = 4;

/** A PR GitHub answered 404 for; cached so a re-run does not ask again. */
interface PrDiffMissing {
  prRef: string;
  missing: true;
}

type CacheEntry = PrDiff | PrDiffMissing;

const changedFile = z.object({ path: z.string(), previousPath: z.string().optional(), additions: z.number(), deletions: z.number() });
const prDiff = z.object({ prRef: z.string(), repo: z.string(), pr: z.number().int(), head: z.string(), files: z.array(changedFile), truncated: z.boolean() });
const prDiffMissing = z.object({ prRef: z.string(), missing: z.literal(true) });
const cacheFile = z.object({ v: z.literal(1), prs: z.record(z.string(), z.union([prDiffMissing, prDiff])) });

export const prDiffCachePath = (stateDir: string): string => path.join(stateDir, CACHE_FILE);

function readCacheEntries(file: string): Map<string, CacheEntry> {
  if (!existsSync(file)) return new Map();
  const parsed = cacheFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw Object.assign(new Error(`invalid PR diff cache ${file}: ${z.prettifyError(parsed.error)}`), { code: EXIT.DATAERR });
  return new Map(Object.entries(parsed.data.prs));
}

/** The cached diffs by PR ref, for `taskActuals`' `prDiffs`; 404s are left out so their tasks read as missing. */
export function readPrDiffCache(file: string): Map<string, PrDiff> {
  const diffs = new Map<string, PrDiff>();
  for (const [ref, entry] of readCacheEntries(file)) if (!("missing" in entry)) diffs.set(ref, entry);
  return diffs;
}

/** Written whole to a temp file and renamed, so a stop mid-write never leaves a cache that will not parse. */
function writeCache(file: string, entries: ReadonlyMap<string, CacheEntry>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const prs = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(tmp, `${JSON.stringify({ v: 1, prs })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export interface BackfillDeps {
  wire: GitHubWire;
  /** Defaults to the port's unlogged read; the command passes the gh-calls-logged one. */
  getPr?: GitHubPort["getPr"];
  /** Read before each batch; the run stops at `floor` rather than let the wire sleep out the hour. */
  budget: Pick<RateBudget, "remaining">;
  floor?: number;
  concurrency?: number;
  /** Uncached PRs to fetch this run; cached refs never count against it. */
  limit?: number;
}

interface BackfillResult {
  cachePath: string;
  refs: number;
  alreadyCached: number;
  fetched: number;
  missing: number;
  truncated: number;
  /** Refs still uncached when the run ended: past `limit`, or left by a stop at the rate floor. */
  remaining: number;
  stoppedAtFloor: boolean;
  rateRemaining: number | null;
}

/** A capped list or a file without counts makes the line total short, so either marks the diff truncated. */
function toPrDiff(prRef: string, repo: string, pr: number, head: string, listed: { files: PrFile[]; changedFiles: number }): PrDiff {
  const files = listed.files.map((f) => ({ path: f.path, ...(f.previousPath !== undefined && { previousPath: f.previousPath }), additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
  const uncounted = listed.files.some((f) => f.additions === undefined || f.deletions === undefined);
  return { prRef, repo, pr, head, files, truncated: uncounted || listed.files.length < listed.changedFiles };
}

/** The port refuses a capped file list outright, so files come off the wire, where the PR's own count says whether it was capped. */
async function fetchPrDiff(prRef: string, wire: GitHubWire, getPr: GitHubPort["getPr"]): Promise<CacheEntry> {
  const parsed = parsePrRef(prRef);
  if (!parsed) throw Object.assign(new Error(`not a PR ref: ${prRef}`), { code: EXIT.DATAERR });
  try {
    const pull = await getPr(parsed.repo, parsed.pr);
    return toPrDiff(prRef, parsed.repo, parsed.pr, pull.headSha, await wire.listPrFiles(parsed.repo, parsed.pr));
  } catch (error) {
    if (isNotFound(error)) return { prRef, missing: true };
    throw error;
  }
}

const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && "status" in error && error.status === 404;

const atFloor = (budget: BackfillDeps["budget"], floor: number): boolean => budget.remaining !== null && budget.remaining <= floor;

/** Merged PRs never change, so a cached ref costs nothing; progress is saved after every batch so a stop loses at most one. */
export async function backfillPrDiffs(refs: readonly string[], cachePath: string, deps: BackfillDeps): Promise<BackfillResult> {
  const entries = readCacheEntries(cachePath);
  const uncached = refs.filter((ref) => !entries.has(ref));
  const todo = uncached.slice(0, deps.limit);
  const getPr = deps.getPr ?? githubPort(deps.wire).getPr;
  const size = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const fresh: CacheEntry[] = [];
  let stoppedAtFloor = false;
  for (let i = 0; i < todo.length; i += size) {
    if (atFloor(deps.budget, deps.floor ?? RATE_FLOOR)) {
      stoppedAtFloor = true;
      break;
    }
    const batch = await Promise.all(todo.slice(i, i + size).map((ref) => fetchPrDiff(ref, deps.wire, getPr)));
    for (const entry of batch) entries.set(entry.prRef, entry);
    fresh.push(...batch);
    writeCache(cachePath, entries);
  }
  return summarize(cachePath, refs.length, uncached.length, fresh, stoppedAtFloor, deps.budget.remaining);
}

function summarize(cachePath: string, refs: number, uncached: number, fresh: readonly CacheEntry[], stoppedAtFloor: boolean, rateRemaining: number | null): BackfillResult {
  const missing = fresh.filter((e) => "missing" in e).length;
  const truncated = fresh.filter((e) => !("missing" in e) && e.truncated).length;
  return { cachePath, refs, alreadyCached: refs - uncached, fetched: fresh.length - missing, missing, truncated, remaining: uncached - fresh.length, stoppedAtFloor, rateRemaining };
}

interface BackfillPlan {
  cachePath: string;
  refs: number;
  alreadyCached: number;
  /** Uncached refs per repo, so personal repos are visible before any call is made. */
  toFetchByRepo: Record<string, number>;
}

function planBackfill(refs: readonly string[], cachePath: string): BackfillPlan {
  const entries = readCacheEntries(cachePath);
  const toFetchByRepo: Record<string, number> = {};
  for (const ref of refs.filter((r) => !entries.has(r))) {
    const repo = parsePrRef(ref)?.repo ?? "unparsed";
    toFetchByRepo[repo] = (toFetchByRepo[repo] ?? 0) + 1;
  }
  return { cachePath, refs: refs.length, alreadyCached: refs.filter((r) => entries.has(r)).length, toFetchByRepo };
}

const BackfillArgs = z
  .object({
    since: isoTime.optional().describe("only PRs merged at or after this ISO date"),
    limit: z.number().int().positive().optional().describe("fetch at most this many uncached PRs this run"),
    dryRun: z.boolean().optional().describe("count what would be fetched, per repo, without calling GitHub"),
  })
  .strict();
type BackfillArgs = z.infer<typeof BackfillArgs>;

/** Strictly read-only, like the throughput commands: `ctx.graph()` would migrate the miner's own index. */
function mergedRefs(dbPath: string, since: string | undefined): string[] {
  const graph = openSessionGraph(dbPath, { readonly: true });
  try {
    return listMergedPrRefs(graph.db, since);
  } finally {
    graph.db.close();
  }
}

export const throughputPrBackfill = defineCommand<BackfillArgs, BackfillResult | BackfillPlan | string, MinerContext>({
  name: "throughput.pr-backfill",
  description: "Cache head sha and changed files (paths and line counts, no diff text) of every merged PR in the index, through gh; resumable",
  args: BackfillArgs,
  result: z.union([z.custom<BackfillResult>(), z.custom<BackfillPlan>(), z.string()]),
  cli: {
    options: {
      since: { long: "--since", description: "ISO date; only PRs merged on or after it" },
      limit: { long: "--limit", description: "uncached PRs to fetch this run" },
      dryRun: { long: "--dry-run", description: "count per repo without calling GitHub" },
    },
  },
  async run(args, ctx) {
    if (ctx.surface !== "cli") throw Object.assign(new Error("throughput pr-backfill calls GitHub and writes the state dir, so it runs only on the CLI"), { code: EXIT.DATAERR });
    const cachePath = prDiffCachePath(ctx.config.stateDir);
    const refs = mergedRefs(ctx.config.dbPath, args.since);
    if (args.dryRun) return render(ctx, planBackfill(refs, cachePath));
    const wire = ghCliWire();
    const getPr = loggedGitHubPort(githubPort(wire)).getPr;
    return render(ctx, await backfillPrDiffs(refs, cachePath, { wire, getPr, budget: sharedRateBudget, ...(args.limit !== undefined && { limit: args.limit }) }));
  },
});

function render(ctx: MinerContext, result: BackfillResult | BackfillPlan): BackfillResult | BackfillPlan | string {
  if (ctx.format !== "human") return result;
  if ("toFetchByRepo" in result) {
    const repos = Object.entries(result.toFetchByRepo).sort(([a], [b]) => a.localeCompare(b)).map(([repo, n]) => `  ${repo} ${n}`);
    return [`dry run  refs ${result.refs}  cached ${result.alreadyCached}  cache ${result.cachePath}`, ...repos].join("\n");
  }
  const stop = result.stoppedAtFloor ? "  stopped at rate floor; re-run after reset" : "";
  return `fetched ${result.fetched}  cached ${result.alreadyCached}  missing ${result.missing}  truncated ${result.truncated}  remaining ${result.remaining}  rate ${result.rateRemaining ?? "unknown"}${stop}`;
}
