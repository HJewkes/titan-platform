// The merge decision on a measured visual delta (TP-4320 §2): only a delta recorded under `shepherd.visualThreshold`
// mode `on` decides; `shadow`, `off` or no delta leaves the TP-2662 decision exactly as it was.
import { VisualDeltaSchema } from "./review-schemas.js";
import type { VisualDelta } from "./visual-delta-read.js";
import { shownPaths } from "./visual-gate.js";

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

/**
 * A delta that fails the schema reads as unmeasured, so it gates whatever mode it claims; a stored record is read back
 * unvalidated, and only the evidence step writes a well-formed one.
 */
function readDelta(delta: VisualDelta | undefined): { on?: VisualDelta; malformed?: true } {
  if (delta === undefined) return {};
  if (!VisualDeltaSchema.safeParse(delta).success) return { malformed: true };
  return delta.policy.mode === "on" ? { on: delta } : {};
}

/** Public API, token and harness paths gate under `on` whatever the seat's globs say, as an API report matches none. */
function sensitiveReasons({ api, tokens, harness }: VisualDelta): string[] {
  const named: [string[], string][] = [[api, "public API"], [tokens, "token"], [harness, "visual harness"]];
  return named.filter(([paths]) => paths.length > 0).map(([paths, kind]) => `${shownPaths(paths)} (${kind})`);
}

/** A removed or unmeasured snapshot fails closed; a measured one gates only above the threshold. */
function snapshotReasons({ snapshots, policy }: VisualDelta): string[] {
  const reasons = snapshots.flatMap((shot) => {
    if (shot.status === "removed") return [`${shot.path} removed`];
    if (shot.status === "unmeasured") return [`${shot.path} unmeasured: ${shot.reason ?? "no reason recorded"}`];
    if (shot.status === "changed" && (shot.share ?? 1) > policy.maxChangedShare) return [`${shot.component} ${shot.path} changed ${percent(shot.share ?? 1)} (over ${percent(policy.maxChangedShare)})`];
    return [];
  });
  return reasons.length === 0 ? [] : [shownPaths(reasons)];
}

/** Why the visual delta gates this head for the owner, or undefined when it leaves the decision to the TP-2662 rules. */
export function visualDeltaGate(delta: VisualDelta | undefined): string | undefined {
  const { on, malformed } = readDelta(delta);
  if (malformed) return "the recorded visual delta is malformed, so it reads as unmeasured";
  if (on === undefined) return undefined;
  if (on.unread !== undefined) return `the visual delta is unmeasured: ${on.unread}`;
  const reasons = [...sensitiveReasons(on), ...snapshotReasons(on)];
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

/**
 * Under `on`, a changed baseline the delta shows as a measured snapshot at or below the threshold, or as an added one,
 * no longer gates; any other changed baseline, a non-snapshot file or one the capped list left out, still does.
 */
export function unclearedBaselines(changed: readonly string[], delta: VisualDelta | undefined): string[] {
  const { on } = readDelta(delta);
  if (on === undefined) return [...changed];
  const cleared = new Set(on.snapshots.filter((shot) => shot.status === "added" || (shot.status === "changed" && shot.share !== undefined && shot.share <= on.policy.maxChangedShare)).map((shot) => shot.path));
  return changed.filter((path) => !cleared.has(path));
}

/** How an allow under `on` was judged, for the clearance note; undefined keeps the TP-2662 wording. */
export function thresholdClearance(delta: VisualDelta | undefined): string | undefined {
  const { on } = readDelta(delta);
  if (on === undefined) return undefined;
  const shares = on.snapshots.flatMap((shot) => (shot.status === "changed" && shot.share !== undefined ? [shot.share] : []));
  const max = shares.length === 0 ? 0 : Math.max(...shares);
  return `changed ${shares.length} snapshot${shares.length === 1 ? "" : "s"}, max ${percent(max)} (≤ ${percent(on.policy.maxChangedShare)}), no public API, token or harness change,`;
}
