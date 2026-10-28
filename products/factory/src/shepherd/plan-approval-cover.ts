import type { CiPolicyKey } from "@titan-design/session-read";
import type { CiPolicyFileChange } from "./ci-policy-changes.js";
import type { PlanApproval, PlanApprovalGate, PlanApprovalScope } from "./plan-approval.js";
import { CiPolicyChangesSchema } from "./review-schemas.js";

/** The approvals one decision honoured; a guard row clears only when a single approval of its gate holds every triggering fact. */
export interface PlanHonour {
  covers(gate: PlanApprovalGate, inScope: (scope: PlanApprovalScope) => boolean): boolean;
  /** Names the plan rounds an allow rests on, so the evidence and the owner can see the merge was planned. */
  note(): string;
}

export function planHonour(approved: readonly PlanApproval[] | undefined): PlanHonour {
  const rounds = new Set<string>();
  return {
    covers: (gate, inScope) => {
      const approval = approved?.find((each) => each.gate === gate && inScope(each.scope));
      if (approval) rounds.add(approval.round);
      return approval !== undefined;
    },
    note: () => (rounds.size === 0 ? "" : `; approved at plan round ${[...rounds].join(", ")}`),
  };
}

/** Exact paths only: a plan names the files it predicts, and a path it did not name is an unplanned change. */
export const pathsIn =
  (paths: readonly string[]) =>
  (scope: PlanApprovalScope): boolean =>
    paths.every((path) => scope.paths.includes(path));

export interface CiPolicyFacts {
  keys: readonly CiPolicyKey[];
  githubPaths: readonly string[];
  /** The changed `.github/` lines as the evidence step read them; anything that does not parse reads as unread. */
  changes: unknown;
  unreadFacts: readonly string[] | undefined;
}

/**
 * A weakened line is inside the scope when its keys, every changed `.github/` path and every changed line are. A line that
 * only gained or lost a trailing comma is no change, so appending one array entry needs only that entry. Any fact read
 * closed, or a line the card cap left out, cannot be shown inside the scope and gates.
 */
export function ciPolicyInScope({ keys, githubPaths, changes, unreadFacts }: CiPolicyFacts): (scope: PlanApprovalScope) => boolean {
  const files = CiPolicyChangesSchema.parse(changes);
  const read = files !== undefined && (unreadFacts ?? []).length === 0 && files.every((file) => file.omitted === 0);
  const lines = unpairedLines(files ?? []);
  return (scope) => {
    if (!read || !keys.every((key) => scope.ciPolicyKeys?.includes(key))) return false;
    const entries = new Set((scope.entries ?? []).map((entry) => sided(entry.slice(0, 1), entry.slice(1))));
    return pathsIn(githubPaths)(scope) && lines.every((line) => entries.has(line));
  };
}

const sided = (side: string, text: string): string => `${side}${text.trim().replace(/,$/, "").trim()}`;

/** Every changed line, sided and normalized, less the removed and added pairs that normalize to the same text. */
function unpairedLines(files: readonly Pick<CiPolicyFileChange, "lines">[]): string[] {
  const texts = files.flatMap((file) => file.lines.map((line) => ({ side: line.side, text: sided("", line.text) })));
  const added = texts.filter((line) => line.side === "+").map((line) => line.text);
  const removed: string[] = [];
  for (const line of texts.filter((each) => each.side === "-")) {
    const twin = added.indexOf(line.text);
    if (twin === -1) removed.push(line.text);
    else added.splice(twin, 1);
  }
  return [...removed.map((text) => `-${text}`), ...added.map((text) => `+${text}`)];
}
