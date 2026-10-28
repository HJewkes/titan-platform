import type { CiPolicyKey } from "@titan-design/session-read";
import { z } from "zod";
import type { CiPolicyScope, PlanApproval } from "./plan-approval.js";

/** Each changed path's git blob sha at head, null where the file is absent there; anything else reads as unread. */
const HeadBlobsSchema = z.record(z.string(), z.string().nullable());

export interface CiPolicyFacts {
  keys: readonly CiPolicyKey[];
  /** Every path the PR changes at head, rename sources included. */
  changed: readonly string[];
  /** The evidence record's `headBlobs`, unparsed, since a stored record may predate the field. */
  headBlobs: unknown;
}

/**
 * The owner approved this weakening only when everything the PR merges is content they pinned: the reviewer's keys are
 * approved, and every changed path is pinned to its exact blob at head. A path the scope pins but the PR leaves alone
 * merges nothing, so it is ignored. No changed path, or a head blob not read, never covers.
 */
export function ciPolicyCovers(scope: CiPolicyScope, { keys, changed, headBlobs }: CiPolicyFacts): boolean {
  const blobs = HeadBlobsSchema.safeParse(headBlobs).data;
  if (blobs === undefined || changed.length === 0) return false;
  if (!keys.every((key) => scope.ciPolicyKeys.includes(key))) return false;
  const pinned = new Map(scope.files.map((file) => [file.path, file.blob]));
  return changed.every((path) => pinned.has(path) && Object.hasOwn(blobs, path) && blobs[path] === pinned.get(path));
}

/** The claimed approvals one decision may honour; a guard row clears only when a single approval of its gate covers it. */
export interface PlanHonour {
  /** Exact paths: a skill or visual plan names the files it predicts, and a path it did not name is an unplanned change. */
  coversPaths(gate: "skill" | "visual", paths: readonly string[]): boolean;
  coversCiPolicy(facts: CiPolicyFacts): boolean;
  /** Marks a gating row the run holds an approval of that gate for, so the owner sees the head went past the plan. */
  unplanned(gate: PlanApproval["gate"]): string;
  /** Names the plan rounds an allow rests on. */
  note(): string;
}

export function planHonour(approved: readonly PlanApproval[] = []): PlanHonour {
  const rounds = new Set<string>();
  const honoured = (approval: PlanApproval | undefined): boolean => {
    if (approval) rounds.add(approval.round);
    return approval !== undefined;
  };
  return {
    coversPaths: (gate, paths) => honoured(approved.find((each) => each.gate !== "ci-policy" && each.gate === gate && paths.every((path) => each.scope.paths.includes(path)))),
    coversCiPolicy: (facts) => honoured(approved.find((each) => each.gate === "ci-policy" && ciPolicyCovers(each.scope, facts))),
    unplanned: (gate) => {
      const held = approved.filter((each) => each.gate === gate).map((each) => each.round);
      return held.length === 0 ? "" : `; unplanned change: the plan approval at round ${held.join(", ")} does not cover this head`;
    },
    note: () => (rounds.size === 0 ? "" : `; approved at plan round ${[...rounds].join(", ")}`),
  };
}
