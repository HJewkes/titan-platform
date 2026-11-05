// The evidence step's read of a PR's visual delta (TP-4320): every snapshot it changes, measured from the merge base to
// the head under fixed caps (visual-delta-measure.ts), and the public API, token and harness paths it touches.
// Under mode `on` the merge decides on it (visual-threshold-gate.ts); under `shadow` it is recorded only.
import type { GitHubPort, PrFile } from "@titan-design/github";
import { DEFAULT_PIXEL_TOLERANCE } from "@titan-design/png-delta";
import { VISUAL_DELTA_CAPS, VisualDeltaSchema } from "./review-schemas.js";
import { measurePairs, type MeasureTarget, type Pair, type PairMeasure } from "./visual-delta-measure.js";
import { componentOf } from "./visual-delta.js";
import { caseFoldedMatcher, visualMatches } from "./visual-gate.js";

import type { VisualThreshold } from "./visual-threshold.js";

export type { VisualThreshold } from "./visual-threshold.js";

const DEFAULT_MAX_CHANGED_SHARE = 0.01;

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
  /** Null when no pair needed it, or it could not be read. */
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

const delta = (path: string, status: SnapshotStatus, more: Partial<SnapshotDelta> = {}): SnapshotDelta => ({ path, component: componentOf(path), status, ...more });

/** A snapshot renamed out of the snapshot paths no longer has a head render, so it reads as removed; one renamed in has no base render, so it reads as added. */
interface Sorted {
  listed: SnapshotDelta[];
  pairs: Pair[];
}

function sortSnapshots(files: readonly PrFile[], isSnapshot: (path: string) => boolean): Sorted {
  const sorted: Sorted = { listed: [], pairs: [] };
  for (const file of files) {
    const from = file.previousPath !== undefined && isSnapshot(file.previousPath) ? file.previousPath : undefined;
    if (!isSnapshot(file.path)) {
      if (from !== undefined) sorted.listed.push(delta(from, "removed"));
      continue;
    }
    if (file.status === "added" || (file.previousPath !== undefined && from === undefined)) sorted.listed.push(delta(file.path, "added"));
    else if (file.status === "removed") sorted.listed.push(delta(file.path, "removed"));
    else sorted.pairs.push({ path: file.path, basePath: from ?? file.path });
  }
  return sorted;
}

const measuredDelta = (pair: PairMeasure): SnapshotDelta => ("share" in pair ? delta(pair.path, "changed", { share: pair.share }) : delta(pair.path, "unmeasured", { reason: pair.reason }));

/** Both sides of every rename, once each, so moving a public API report or token file away still counts as changing it. */
const bothSides = (files: readonly PrFile[]): string[] => [...new Set(files.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath])))];

const clip = (text: string): string => (text.length > VISUAL_DELTA_CAPS.text ? `${text.slice(0, VISUAL_DELTA_CAPS.text - 1)}…` : text);

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

/** Caps each list and clips each string, counting what was left out; the policy stays whole. */
function bounded(lists: Lists): Lists & Pick<VisualDelta, "omitted"> {
  const omitted: NonNullable<VisualDelta["omitted"]> = {};
  const cap = <T>(key: keyof Lists, items: readonly T[], limit: number): T[] => {
    if (items.length > limit) omitted[key] = items.length - limit;
    return items.slice(0, limit);
  };
  const snapshots = cap("snapshots", [...lists.snapshots].sort(byWeight), VISUAL_DELTA_CAPS.snapshots).map(clipSnapshot);
  const paths = (key: "api" | "tokens" | "harness") => cap(key, lists[key], VISUAL_DELTA_CAPS.paths).map(clip);
  const shown = { snapshots, api: paths("api"), tokens: paths("tokens"), harness: paths("harness") };
  return { ...shown, ...(Object.keys(omitted).length > 0 && { omitted }) };
}

/** Parsed before it is stored, so a record over the schema's bounds throws here rather than at GitHub's comment limit. */
function checked(visualDelta: VisualDelta): VisualDelta {
  VisualDeltaSchema.parse(visualDelta);
  return visualDelta;
}

/**
 * Reads the PR's visual delta at `target.head` from its pinned file list; `files` is a string when that list could not
 * be read. Token paths skip tests and docs, as a test under a token directory paints nothing; API reports are markdown
 * and harness specs are tests, so those two lists match every path.
 */
export async function readVisualDelta(port: GitHubPort, target: MeasureTarget, files: readonly PrFile[] | string, threshold: VisualThreshold): Promise<VisualDelta> {
  const policy = { mode: threshold.mode, maxChangedShare: threshold.maxChangedShare ?? DEFAULT_MAX_CHANGED_SHARE, pixelTolerance: threshold.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE };
  if (typeof files === "string") return checked({ policy, mergeBase: null, snapshots: [], api: [], tokens: [], harness: [], unread: clip(files) });
  const paths = bothSides(files);
  const { listed, pairs } = sortSnapshots(files, caseFoldedMatcher(threshold.snapshotPaths));
  const { mergeBase, measured } = await measurePairs(port, target, pairs, { ...threshold, pixelTolerance: policy.pixelTolerance });
  const lists = {
    snapshots: [...measured.map(measuredDelta), ...listed],
    api: paths.filter(caseFoldedMatcher(threshold.apiPaths)),
    tokens: visualMatches(paths, threshold.tokenPaths),
    harness: paths.filter(caseFoldedMatcher(threshold.harnessPaths)),
  };
  return checked({ policy, mergeBase, ...bounded(lists) });
}
