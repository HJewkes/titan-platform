import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { Verbs } from "../cli-types.js";
import { readPrFiles } from "../dispatch/collision.js";
import type { Runner } from "../dispatch/runner.js";
import { EXIT } from "../exit-codes.js";
import { errorMessage } from "../narrow.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { ShepherdStore } from "../shepherd/store.js";
import { watchRow } from "../shepherd/view.js";
import { readLaneTasks } from "./active-work.js";
import { ghApiRead } from "./gh-api-read.js";
import type { Eligibility } from "./rules.js";
import type { RuleFile, ShadowLane } from "./shadow/rule-file.js";
import { capsTask, upkeepHolds, type MergedPrFiles, type UpkeepHold, type UpkeepRead } from "./upkeep.js";

/*
 * What the upkeep cap reads (TP-5755 S4): the lane's PRs Shepherd saw merge inside the window, and each one's changed
 * paths through `gh api` GETs. Merged files never change, so each PR is asked once and cached beside the shadow dir.
 */

export interface MergedLanePr {
  repo: string;
  pr: number;
}

interface MergedQuery {
  lane: ShadowLane;
  /** ISO instant; a PR merged before it is outside the window. */
  since: string;
  verbs: Verbs;
}

interface UpkeepPorts {
  mergedPrs: (query: MergedQuery) => Promise<MergedLanePr[]>;
  exec: Runner;
  now: () => Date;
}

interface UpkeepContext {
  lane: ShadowLane;
  rules: RuleFile;
  eligible: Eligibility["eligible"];
  verbs: Verbs;
}

const DAY_MS = 86_400_000;

const PrFilesCache = z.object({ v: z.literal(1), files: z.record(z.string(), z.array(z.string())) });

/** A cache that does not parse is dropped and rebuilt: it holds nothing gh would not answer again. */
function readCache(file: string): Map<string, string[]> {
  if (!existsSync(file)) return new Map();
  try {
    return new Map(Object.entries(PrFilesCache.parse(JSON.parse(readFileSync(file, "utf8"))).files));
  } catch {
    return new Map();
  }
}

/** Written whole through a rename, so a tick killed mid-write leaves the previous cache rather than half of one. */
function writeCache(file: string, cache: ReadonlyMap<string, string[]>): void {
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify({ v: 1, files: Object.fromEntries(cache) })}\n`);
  renameSync(partial, file);
}

/** Each PR's files, from the cache or one gh call; the first PR gh cannot read leaves the whole share unread. */
export function readMergedPrFiles(prs: readonly MergedLanePr[], exec: Runner, cacheFile: string | undefined): UpkeepRead {
  const cache = cacheFile === undefined ? new Map<string, string[]>() : readCache(cacheFile);
  const read: MergedPrFiles[] = [];
  let added = false;
  let failure: string | undefined;
  for (const { repo, pr } of prs) {
    const key = `${repo}#${pr}`;
    const cached = cache.get(key);
    const files = cached ?? readPrFiles(repo, pr, exec);
    if (files === undefined) {
      failure = `gh could not read the files of ${key}`;
      break;
    }
    if (cached === undefined) {
      cache.set(key, files);
      added = true;
    }
    read.push({ pr: key, files });
  }
  if (added && cacheFile !== undefined) writeCache(cacheFile, cache);
  return failure === undefined ? { ok: true, prs: read } : { ok: false, why: failure };
}

/** A factory database Shepherd's routes never opened has no registration table, and so no merges. */
const hasShepherdStore = (db: Db): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shepherd_registration'").get() !== undefined;

/** The lane's PRs whose Shepherd run merged since `since`, read from the factory's own store. */
async function liveMergedPrs({ lane, since, verbs }: MergedQuery): Promise<MergedLanePr[]> {
  const source = { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) };
  const { keys } = await readLaneTasks(source, { initiative: lane.initiative, ...(lane.tag !== null && { tag: lane.tag }) });
  let prs: MergedLanePr[] = [];
  await verbs.withHost((host) => {
    if (!hasShepherdStore(host.db)) return EXIT.OK;
    prs = new ShepherdStore(host.db).all().flatMap((registration) => {
      const run = registration.pr !== null && keys.has(registration.task) ? host.runtime.status(registration.runId) : undefined;
      if (run === undefined || registration.pr === null) return [];
      const row = watchRow({ registration, run });
      return row.outcome?.kind === "merged" && row.phaseSince >= since ? [{ repo: registration.repo, pr: registration.pr }] : [];
    });
    return EXIT.OK;
  });
  return prs;
}

/** Any failure to list the lane's merges or read their files leaves the share unread, which holds upkeep work. */
async function readShare(ports: UpkeepPorts, ctx: UpkeepContext, cacheFile: string | undefined): Promise<UpkeepRead> {
  const since = new Date(ports.now().getTime() - ctx.rules.upkeep.windowDays * DAY_MS).toISOString();
  try {
    return readMergedPrFiles(await ports.mergedPrs({ lane: ctx.lane, since, verbs: ctx.verbs }), ports.exec, cacheFile);
  } catch (error) {
    return { ok: false, why: errorMessage(error) };
  }
}

/** `<shadow.dir>/../cache/pr-files.json`; undefined when the rule file names no shadow dir. */
const cacheFileOf = (rules: RuleFile): string | undefined => (rules.shadow.dir === undefined ? undefined : join(rules.shadow.dir, "..", "cache", "pr-files.json"));

/** The upkeep cap as a hold provider over `ports`; a lane with no candidate the cap could hold reads nothing. */
export function upkeepProvider(ports: UpkeepPorts): (ctx: UpkeepContext) => Promise<{ holds: UpkeepHold[] }> {
  return async function upkeepCapHolds(ctx) {
    if (!ctx.eligible.some(({ task, bet }) => capsTask(task, bet, ctx.rules.upkeep))) return { holds: [] };
    const read = await readShare(ports, ctx, cacheFileOf(ctx.rules));
    return { holds: upkeepHolds({ initiative: ctx.lane.initiative, candidates: ctx.eligible, read, rules: ctx.rules.upkeep }) };
  };
}

export const upkeepCapHolds = upkeepProvider({ mergedPrs: liveMergedPrs, exec: ghApiRead, now: () => new Date() });
