// The evidence step's read of a PR's visual delta (TP-4320): every snapshot it changes measured from the merge base to
// the head, and the public API, token and harness paths it touches. Recorded only; nothing decides on it yet.
import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import { statusOf } from "../required-checks.js";
import { DEFAULT_PIXEL_TOLERANCE, componentOf, snapshotShare } from "./visual-delta.js";
import { caseFoldedMatcher, visualMatches } from "./visual-gate.js";

/** `shepherd.visualThreshold` for one repo. */
export interface VisualThreshold {
  mode: "off" | "shadow" | "on";
  maxChangedShare?: number;
  pixelTolerance?: number;
  snapshotPaths: string[];
  apiPaths: string[];
  tokenPaths: string[];
  harnessPaths: string[];
  maxSnapshots?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_CHANGED_SHARE = 0.01;
const DEFAULT_MAX_SNAPSHOTS = 80;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

type SnapshotStatus = "changed" | "added" | "removed" | "unmeasured";

interface SnapshotDelta {
  path: string;
  component: string;
  status: SnapshotStatus;
  share?: number;
  reason?: string;
}

/** What the evidence step records; `policy` is the config that judged this head, so a later config change is not retroactive. */
export interface VisualDelta {
  policy: { mode: VisualThreshold["mode"]; maxChangedShare: number; pixelTolerance: number };
  /** Null when no snapshot needed it, or it could not be read. */
  mergeBase: string | null;
  snapshots: SnapshotDelta[];
  api: string[];
  tokens: string[];
  harness: string[];
  /** Why the changed files could not be read, so nothing here was matched. */
  unread?: string;
  /** How many entries past each list's cap were left out, so a capped list still says it is not whole. */
  omitted?: Partial<Record<"snapshots" | "api" | "tokens" | "harness", number>>;
}

/**
 * The record is posted whole in the evidence comment, which GitHub caps at 65,536 characters, so every list and string
 * is bounded: at most 40 snapshots and 20 paths per list, each string at most 300 characters.
 */
const SHOWN_SNAPSHOTS = 40;
const SHOWN_PATHS = 20;
const MAX_TEXT = 300;

interface VisualDeltaTarget {
  repo: RepoSlug;
  head: string;
  baseRef: string;
}

/** A snapshot to measure: `basePath` is where it sat at the merge base, its rename source if it moved. */
interface Pair {
  path: string;
  basePath: string;
}

interface Sorted {
  listed: SnapshotDelta[];
  pairs: Pair[];
}

const delta = (path: string, status: SnapshotStatus, more: Partial<SnapshotDelta> = {}): SnapshotDelta => ({ path, component: componentOf(path), status, ...more });

/** A snapshot renamed out of the snapshot paths no longer has a head render, so it reads as removed. */
function sortSnapshots(files: readonly PrFile[], isSnapshot: (path: string) => boolean): Sorted {
  const sorted: Sorted = { listed: [], pairs: [] };
  for (const file of files) {
    const from = file.previousPath !== undefined && isSnapshot(file.previousPath) ? file.previousPath : undefined;
    if (!isSnapshot(file.path)) {
      if (from !== undefined) sorted.listed.push(delta(from, "removed"));
      continue;
    }
    if (file.status === "added") sorted.listed.push(delta(file.path, "added"));
    else if (file.status === "removed") sorted.listed.push(delta(file.path, "removed"));
    else sorted.pairs.push({ path: file.path, basePath: from ?? file.path });
  }
  return sorted;
}

interface Measure {
  port: GitHubPort;
  repo: RepoSlug;
  head: string;
  mergeBase: string;
  pixelTolerance: number;
  maxBytes: number;
}

async function readBlob(m: Measure, path: string, ref: string): Promise<Uint8Array | string> {
  try {
    const bytes = await m.port.fileBytes(m.repo, path, ref);
    if (bytes === null) return `absent at ${ref}`;
    return bytes.byteLength > m.maxBytes ? `over ${m.maxBytes} bytes at ${ref}` : bytes;
  } catch (error) {
    return `unreadable at ${ref}: ${statusOf(error)}`;
  }
}

/** Every way a snapshot cannot be measured reads as `unmeasured` with its reason, never as a throw. */
async function measure(m: Measure, pair: Pair): Promise<SnapshotDelta> {
  const [base, head] = await Promise.all([readBlob(m, pair.basePath, m.mergeBase), readBlob(m, pair.path, m.head)]);
  if (typeof base === "string") return delta(pair.path, "unmeasured", { reason: base });
  if (typeof head === "string") return delta(pair.path, "unmeasured", { reason: head });
  try {
    return delta(pair.path, "changed", { share: snapshotShare(base, head, { pixelTolerance: m.pixelTolerance }) });
  } catch {
    return delta(pair.path, "unmeasured", { reason: "not a PNG" });
  }
}

async function mergeBaseOf(port: GitHubPort, { repo, baseRef, head }: VisualDeltaTarget): Promise<{ sha: string } | { unread: string }> {
  try {
    return { sha: (await port.compareFiles(repo, baseRef, head)).mergeBaseSha };
  } catch (error) {
    return { unread: `the merge base is unreadable: ${statusOf(error)}` };
  }
}

interface Measured {
  mergeBase: string | null;
  measured: SnapshotDelta[];
}

/** Over the cap, or with no merge base, every pair is unmeasured: one blob read per snapshot is skipped, never guessed. */
async function measurePairs(port: GitHubPort, target: VisualDeltaTarget, pairs: readonly Pair[], threshold: VisualThreshold, total: number): Promise<Measured> {
  if (pairs.length === 0) return { mergeBase: null, measured: [] };
  const cap = threshold.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  const skipAll = (reason: string) => pairs.map((pair) => delta(pair.path, "unmeasured", { reason }));
  if (total > cap) return { mergeBase: null, measured: skipAll(`${total} changed snapshots are over the cap of ${cap}`) };
  const base = await mergeBaseOf(port, target);
  if ("unread" in base) return { mergeBase: null, measured: skipAll(base.unread) };
  const limits = { pixelTolerance: threshold.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE, maxBytes: threshold.maxBytes ?? DEFAULT_MAX_BYTES };
  const m: Measure = { port, repo: target.repo, head: target.head, mergeBase: base.sha, ...limits };
  const measured: SnapshotDelta[] = [];
  for (const pair of pairs) measured.push(await measure(m, pair));
  return { mergeBase: base.sha, measured };
}

/** Both sides of every rename, once each, so moving a public API report or token file away still counts as changing it. */
const bothSides = (files: readonly PrFile[]): string[] => [...new Set(files.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath])))];

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/** Unmeasured and removed shots first, then the largest shares, then added shots, so a capped list keeps what gates. */
const RANK: Record<SnapshotStatus, number> = { unmeasured: 0, removed: 1, changed: 2, added: 3 };
const byWeight = (a: SnapshotDelta, b: SnapshotDelta): number => RANK[a.status] - RANK[b.status] || (b.share ?? 0) - (a.share ?? 0);

const clipSnapshot = ({ path, component, reason, ...rest }: SnapshotDelta): SnapshotDelta => ({
  path: clip(path),
  component: clip(component),
  ...rest,
  ...(reason !== undefined && { reason: clip(reason) }),
});

type Lists = Pick<VisualDelta, "snapshots" | "api" | "tokens" | "harness">;

/** Caps each list and clips each string, counting what was left out; the policy and merge base stay whole. */
function bounded(lists: Lists): Lists & Pick<VisualDelta, "omitted"> {
  const omitted: NonNullable<VisualDelta["omitted"]> = {};
  const cap = <T>(key: keyof Lists, items: readonly T[], limit: number): T[] => {
    if (items.length > limit) omitted[key] = items.length - limit;
    return items.slice(0, limit);
  };
  const snapshots = cap("snapshots", [...lists.snapshots].sort(byWeight), SHOWN_SNAPSHOTS).map(clipSnapshot);
  const paths = (key: "api" | "tokens" | "harness") => cap(key, lists[key], SHOWN_PATHS).map(clip);
  const shown = { snapshots, api: paths("api"), tokens: paths("tokens"), harness: paths("harness") };
  return { ...shown, ...(Object.keys(omitted).length > 0 && { omitted }) };
}

/**
 * Reads the PR's visual delta at `target.head` from its pinned file list; `files` is a string when that list could not
 * be read. Token paths skip tests and docs, as a test under a token directory paints nothing; API reports are markdown
 * and harness specs are tests, so those two lists match every path.
 */
export async function readVisualDelta(port: GitHubPort, target: VisualDeltaTarget, files: readonly PrFile[] | string, threshold: VisualThreshold): Promise<VisualDelta> {
  const pixelTolerance = threshold.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE;
  const policy = { mode: threshold.mode, maxChangedShare: threshold.maxChangedShare ?? DEFAULT_MAX_CHANGED_SHARE, pixelTolerance };
  if (typeof files === "string") return { policy, mergeBase: null, snapshots: [], api: [], tokens: [], harness: [], unread: clip(files) };
  const paths = bothSides(files);
  const { listed, pairs } = sortSnapshots(files, caseFoldedMatcher(threshold.snapshotPaths));
  const { mergeBase, measured } = await measurePairs(port, target, pairs, threshold, listed.length + pairs.length);
  return {
    policy,
    mergeBase,
    ...bounded({
      snapshots: [...measured, ...listed],
      api: paths.filter(caseFoldedMatcher(threshold.apiPaths)),
      tokens: visualMatches(paths, threshold.tokenPaths),
      harness: paths.filter(caseFoldedMatcher(threshold.harnessPaths)),
    }),
  };
}
