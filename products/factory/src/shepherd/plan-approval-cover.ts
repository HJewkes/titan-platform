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
 * A weakened line is inside the scope when its keys, every changed `.github/` path and every changed line of the card's
 * positional diff are, each line matched exactly, indentation included, since it decides YAML nesting. The one exemption
 * is a removed and an added line at the same position of the same file that differ only by a trailing comma, so appending
 * one array entry needs only that entry. Any fact read closed, a line the card cap left out or a line it cut gates.
 */
export function ciPolicyInScope({ keys, githubPaths, changes, unreadFacts }: CiPolicyFacts): (scope: PlanApprovalScope) => boolean {
  const parsed = CiPolicyChangesSchema.parse(changes);
  const files = parsed ?? [];
  const whole = parsed !== undefined && (unreadFacts ?? []).length === 0 && files.every((file) => file.omitted === 0 && file.lines.every((line) => !line.text.endsWith(CUT_MARK)));
  const lines = files.flatMap(changedLines);
  return (scope) => {
    if (!whole || !keys.every((key) => scope.ciPolicyKeys?.includes(key))) return false;
    const entries = new Set(scope.entries ?? []);
    return pathsIn(githubPaths)(scope) && lines.every((line) => entries.has(line));
  };
}

/** `shownLine` ends a line it cut at the card's width with this mark, so a cut line cannot be matched exactly. */
const CUT_MARK = "\u2026";

type CardLine = CiPolicyFileChange["lines"][number];

const commaOnly = (a: CardLine, b: CardLine): boolean => a.side !== b.side && a.n === b.n && (`${a.text},` === b.text || `${b.text},` === a.text);

/** One file's changed lines as `+<line>` or `-<line>`, less the same-position pairs that differ only by a trailing comma. */
function changedLines(file: Pick<CiPolicyFileChange, "lines">): string[] {
  return file.lines.filter((line) => !file.lines.some((other) => commaOnly(line, other))).map((line) => `${line.side}${line.text}`);
}
