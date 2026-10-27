// The evidence step's read of a PR's visual delta (TP-4320): the snapshots it changes, and the public API, token and
// harness paths it touches. Recorded only; nothing decides on it yet. No blob is read here: every snapshot pair records
// as not measured until a bounded decoder measures it, so no byte the PR supplies reaches a decoder from this step.
import type { PrFile } from "@titan-design/github";
import { VISUAL_DELTA_CAPS, VisualDeltaSchema } from "./review-schemas.js";
import { DEFAULT_PIXEL_TOLERANCE, componentOf } from "./visual-delta.js";
import { caseFoldedMatcher, visualMatches } from "./visual-gate.js";

/** `shepherd.visualThreshold` for one repo. */
export interface VisualThreshold {
  mode: "off" | "shadow";
  maxChangedShare?: number;
  pixelTolerance?: number;
  snapshotPaths: string[];
  apiPaths: string[];
  tokenPaths: string[];
  harnessPaths: string[];
  maxSnapshots?: number;
  maxBytes?: number;
  maxPixels?: number;
  maxTotalPixels?: number;
}

const DEFAULT_MAX_CHANGED_SHARE = 0.01;
const NOT_MEASURED = "not measured yet";

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
  /** Null until a measured pair needs it. */
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
function sortSnapshots(files: readonly PrFile[], isSnapshot: (path: string) => boolean): SnapshotDelta[] {
  const sorted: SnapshotDelta[] = [];
  for (const file of files) {
    const from = file.previousPath !== undefined && isSnapshot(file.previousPath) ? file.previousPath : undefined;
    if (!isSnapshot(file.path)) {
      if (from !== undefined) sorted.push(delta(from, "removed"));
      continue;
    }
    if (file.status === "added" || (file.previousPath !== undefined && from === undefined)) sorted.push(delta(file.path, "added"));
    else if (file.status === "removed") sorted.push(delta(file.path, "removed"));
    else sorted.push(delta(file.path, "unmeasured", { reason: NOT_MEASURED }));
  }
  return sorted;
}

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
 * Reads the PR's visual delta from its pinned file list; `files` is a string when that list could not be read. Token
 * paths skip tests and docs, as a test under a token directory paints nothing; API reports are markdown and harness
 * specs are tests, so those two lists match every path.
 */
export function readVisualDelta(files: readonly PrFile[] | string, threshold: VisualThreshold): VisualDelta {
  const policy = { mode: threshold.mode, maxChangedShare: threshold.maxChangedShare ?? DEFAULT_MAX_CHANGED_SHARE, pixelTolerance: threshold.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE };
  if (typeof files === "string") return checked({ policy, mergeBase: null, snapshots: [], api: [], tokens: [], harness: [], unread: clip(files) });
  const paths = bothSides(files);
  const lists = {
    snapshots: sortSnapshots(files, caseFoldedMatcher(threshold.snapshotPaths)),
    api: paths.filter(caseFoldedMatcher(threshold.apiPaths)),
    tokens: visualMatches(paths, threshold.tokenPaths),
    harness: paths.filter(caseFoldedMatcher(threshold.harnessPaths)),
  };
  return checked({ policy, mergeBase: null, ...bounded(lists) });
}
