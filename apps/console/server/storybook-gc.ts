/**
 * The Storybook store's GC sweep (TP-3793 S6). A build is kept while an open round names it, or a round sent or
 * withdrawn within `closedDays` does. A build only rounds closed before that name is removed. A build no round names
 * stays until the store is over `capBytes`, and then the oldest such build goes first, until the store fits.
 *
 * It fails closed. A rounds dir it cannot read, or a round whose `storybook.json` it cannot read, could be naming any
 * build, so the sweep then removes nothing and says why. Each removal goes through the store's own
 * `removeStoredBuild`, which follows no symlink.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readRoundSidecar } from "./round-live.js";
import { FEEDBACK_FILE, ROUND_ID, WITHDRAWN_FILE, statusOf } from "./rounds.js";
import { listStoredBuilds, removeStoredBuild, type StoredBuild } from "./storybook-store.js";

export interface Retention {
  /** A sent or withdrawn round keeps its builds this many days after its feedback.json or withdrawn.json landed. */
  closedDays: number;
  /** Over this total, builds no round names are removed, oldest first. */
  capBytes: number;
  /** A build stored this recently may be an import's whose round has not landed yet, so the cap never takes it. */
  importGraceMs: number;
}

export const RETENTION: Retention = { closedDays: 14, capBytes: 3 * 1024 ** 3, importGraceMs: 60 * 60 * 1000 };

const DAY_MS = 24 * 60 * 60 * 1000;

interface RoundRef {
  id: string;
  /** Null while the round is open. */
  closedAt: Date | null;
  buildIds: readonly string[];
}

interface GcEntry {
  buildId: string;
  bytes: number;
  storedAt: string;
  action: "kept" | "removed";
  reason: string;
}

export interface GcReport {
  dryRun: boolean;
  capBytes: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Oldest stored first. */
  builds: GcEntry[];
  /** Store entries that are not builds (staging dirs, symlinks, stray files); never touched. */
  skipped: string[];
  /** Why nothing was removed, when the sweep could not see every reference. */
  blocked: string | null;
}

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** Null while open. A marker that vanished between the two reads counts as closed now, which keeps its builds longest. */
async function closedAt(roundDir: string, now: Date): Promise<Date | null> {
  const status = await statusOf(roundDir);
  if (status === "open") return null;
  const marker = await lstat(path.join(roundDir, status === "sent" ? FEEDBACK_FILE : WITHDRAWN_FILE)).catch(() => null);
  return marker?.mtime ?? now;
}

async function roundRef(roundsDir: string, id: string, now: Date): Promise<RoundRef | string> {
  const roundDir = path.join(roundsDir, id);
  const sidecar = await readRoundSidecar(roundDir);
  if (sidecar !== null && "reason" in sidecar) return `round ${id}: ${sidecar.reason}`;
  return { id, closedAt: await closedAt(roundDir, now), buildIds: sidecar?.builds.map(({ buildId }) => buildId) ?? [] };
}

/** Every round's references, or the first reason one could not be read. A missing rounds dir names nothing. */
async function readRoundRefs(roundsDir: string, now: Date): Promise<RoundRef[] | string> {
  let entries;
  try {
    entries = await readdir(roundsDir, { withFileTypes: true });
  } catch (error) {
    return errnoOf(error) === "ENOENT" ? [] : "the rounds dir could not be read";
  }
  const refs: RoundRef[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && ROUND_ID.test(candidate.name))) {
    const ref = await roundRef(roundsDir, entry.name, now);
    if (typeof ref === "string") return ref;
    refs.push(ref);
  }
  return refs;
}

type Decided = Pick<GcEntry, "action" | "reason">;

/** Null when no round names the build, so only the cap decides it. */
function namedVerdict(build: StoredBuild, refs: readonly RoundRef[], now: Date, retention: Retention): Decided | null {
  const holders = refs.filter((ref) => ref.buildIds.includes(build.buildId));
  if (holders.length === 0) return null;
  const open = holders.find((ref) => ref.closedAt === null);
  if (open) return { action: "kept", reason: `named by open round ${open.id}` };
  const cutoff = now.getTime() - retention.closedDays * DAY_MS;
  const recent = holders.find((ref) => ref.closedAt !== null && ref.closedAt.getTime() > cutoff);
  if (recent) return { action: "kept", reason: `named by round ${recent.id}, closed within ${retention.closedDays} days` };
  return { action: "removed", reason: `named only by rounds closed over ${retention.closedDays} days ago: ${holders.map((ref) => ref.id).join(", ")}` };
}

function unnamedVerdict(build: StoredBuild, overCap: boolean, now: Date, retention: Retention): Decided {
  if (!overCap) return { action: "kept", reason: "named by no round; the store is within its cap" };
  if (now.getTime() - build.storedAt.getTime() < retention.importGraceMs) {
    return { action: "kept", reason: "named by no round, but stored within the import grace, so an import may still be landing its round" };
  }
  return { action: "removed", reason: "named by no round, and the oldest such build while the store was over its cap" };
}

const oldestFirst = (builds: readonly StoredBuild[]): StoredBuild[] => [...builds].sort((a, b) => a.storedAt.getTime() - b.storedAt.getTime());

const entryOf = (build: StoredBuild, decided: Decided): GcEntry => ({ buildId: build.buildId, bytes: build.bytes, storedAt: build.storedAt.toISOString(), ...decided });

/** What the sweep would do, as data: no file is read or removed here. */
function planSweep(builds: readonly StoredBuild[], refs: readonly RoundRef[], now: Date, retention: Retention): GcEntry[] {
  const named = oldestFirst(builds).map((build) => ({ build, verdict: namedVerdict(build, refs, now, retention) }));
  let left = named.filter(({ verdict }) => verdict?.action !== "removed").reduce((sum, { build }) => sum + build.bytes, 0);
  const entries: GcEntry[] = [];
  for (const { build, verdict } of named) {
    const decided = verdict ?? unnamedVerdict(build, left > retention.capBytes, now, retention);
    if (verdict === null && decided.action === "removed") left -= build.bytes;
    entries.push(entryOf(build, decided));
  }
  return entries;
}

const keepAll = (builds: readonly StoredBuild[], blocked: string): GcEntry[] =>
  oldestFirst(builds).map((build) => entryOf(build, { action: "kept", reason: `nothing is removed: ${blocked}` }));

interface SweepOptions {
  storybooksDir: string;
  roundsDir: string;
  dryRun: boolean;
  now: Date;
  retention?: Retention;
}

export async function sweepStorybooks({ storybooksDir, roundsDir, dryRun, now, retention = RETENTION }: SweepOptions): Promise<GcReport> {
  const refs = await readRoundRefs(path.resolve(roundsDir), now);
  const store = await listStoredBuilds(path.resolve(storybooksDir));
  const blocked = typeof refs === "string" ? refs : null;
  const builds = typeof refs === "string" ? keepAll(store.builds, refs) : planSweep(store.builds, refs, now, retention);
  if (!dryRun) for (const entry of builds.filter((candidate) => candidate.action === "removed")) await removeStoredBuild(path.resolve(storybooksDir), entry.buildId);
  const bytesBefore = builds.reduce((sum, entry) => sum + entry.bytes, 0);
  const bytesAfter = builds.filter((entry) => entry.action === "kept").reduce((sum, entry) => sum + entry.bytes, 0);
  return { dryRun, capBytes: retention.capBytes, bytesBefore, bytesAfter, builds, skipped: store.skipped, blocked };
}
