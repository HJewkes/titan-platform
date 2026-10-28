import type { CiPolicyKey } from "@titan-design/session-read";
import type { CiPolicyFileChange } from "./ci-policy-changes.js";
import type { PlanApproval, PlanApprovalEntry, PlanApprovalGate, PlanApprovalScope } from "./plan-approval.js";
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
 * positional diff are, each line matched by its own entry: same file, side, line number and text, indentation included,
 * since it decides YAML nesting. A line's place is its identity, so one entry never covers a copy elsewhere. The one
 * exemption is a JSON line that gained only a trailing comma where an added line follows it, so appending one array entry
 * needs only that entry; in YAML a trailing comma changes the value. Any fact read closed, a line the card cap left out or
 * a line it cut gates.
 */
export function ciPolicyInScope({ keys, githubPaths, changes, unreadFacts }: CiPolicyFacts): (scope: PlanApprovalScope) => boolean {
  const parsed = CiPolicyChangesSchema.parse(changes);
  const files = parsed ?? [];
  const whole = parsed !== undefined && (unreadFacts ?? []).length === 0 && files.every((file) => file.omitted === 0 && file.lines.every((line) => !line.text.endsWith(CUT_MARK)));
  const lines = files.flatMap(changedLines);
  return (scope) => {
    if (!whole || !keys.every((key) => scope.ciPolicyKeys?.includes(key))) return false;
    const entries = new Set((scope.entries ?? []).map(placed));
    return pathsIn(githubPaths)(scope) && lines.every((line) => entries.has(placed(line)));
  };
}

/** `shownLine` ends a line it cut at the card's width with this mark, so a cut line cannot be matched exactly. */
const CUT_MARK = "\u2026";

type CardLine = CiPolicyFileChange["lines"][number];

const placed = ({ path, side, n, text }: PlanApprovalEntry): string => JSON.stringify([path, side, n, text]);

/** In JSON, the base line at `n` came back at `n` with only a trailing comma added, and an added line follows it at `n + 1`. */
function commaAppendAt(lines: readonly CardLine[], n: number): boolean {
  const at = (side: CardLine["side"], line: number) => lines.find((each) => each.side === side && each.n === line);
  const base = at("-", n);
  return base !== undefined && at("+", n)?.text === `${base.text},` && at("+", n + 1) !== undefined;
}

/** One file's changed lines with their place, less a JSON comma-append pair. */
function changedLines({ path, lines }: Pick<CiPolicyFileChange, "path" | "lines">): PlanApprovalEntry[] {
  const json = path.endsWith(".json");
  return lines.filter((line) => !(json && commaAppendAt(lines, line.n))).map((line) => ({ path, ...line }));
}
