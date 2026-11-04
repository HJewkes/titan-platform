import { z } from "zod";
import { budgetJsonChange, CI_BUDGET_PATH } from "./ci-budget-json.js";
import { lineEdits, shownLine, type CiPolicyFile } from "./ci-policy-changes.js";

/**
 * Owner decision 552 (2), TP-4760: a weakened CI-policy line splits in two. A budget change (timeout, p90 or budget numbers,
 * every required check still present and unskipped) with a fresh reviewer MERGE and a measurement link may be resolved by a
 * coordinator; anything else is a weakening and stays the owner's.
 */
export type CiPolicyClass = { kind: "budget"; measurement: string } | { kind: "weakening"; why: string };

const CiPolicyClassSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("budget"), measurement: z.string() }),
  z.strictObject({ kind: z.literal("weakening"), why: z.string() }),
]);

/** Stored evidence is not parsed on read, so anything but a well-formed budget class reads as a weakening. */
export function budgetMeasurement(stored: unknown): string | undefined {
  const parsed = CiPolicyClassSchema.safeParse(stored);
  return parsed.success && parsed.data.kind === "budget" ? parsed.data.measurement : undefined;
}

export interface CiPolicyClassInput {
  /** The keys of the reviewer's weakened line. */
  keys: readonly string[];
  /** Every changed `.github/` file read at base and head. */
  files: readonly CiPolicyFile[];
  /** Every path the PR changes; one that is not among `files` was never classified, so it reads as weakening. */
  changedPaths: readonly string[];
  /** Set when any changed or `.github/` file went unread, which could hide a weakening. */
  unread: boolean;
  /** The base branch's required contexts. */
  required: readonly string[];
  repo: string;
  prBody: string | undefined;
  /** The reviewer's MERGE was given at this very head, not carried to it. */
  freshMerge: boolean;
}

/** A line that sets one timeout, p-percentile or budget number and nothing else. */
const BUDGET_NUMBER_LINE = /^\s*"?(timeout(-minutes)?|p\d{2}|budget)"?\s*:\s*\d+\s*,?\s*$/i;
const COMMENT_LINE = /^\s*(#.*)?$/;

const ADDED_WEAKENINGS: readonly (readonly [RegExp, string])[] = [
  [/continue-on-error/i, "it adds continue-on-error"],
  [/\bif\s*:\s*(\$\{\{\s*)?false\b/i, "it adds if: false"],
  [/skip/i, "it adds a skip"],
];

const weakening = (why: string): CiPolicyClass => ({ kind: "weakening", why });

/** The first reason the diff is a weakening; budget only when none holds. */
export function ciPolicyClass(input: CiPolicyClassInput): CiPolicyClass {
  const nonBudgetKeys = input.keys.filter((key) => key !== "other");
  if (nonBudgetKeys.length > 0) return weakening(`the reviewer named ${nonBudgetKeys.join(", ")}`);
  if (input.unread) return weakening("a changed file was not read");
  const classified = new Set(input.files.map((file) => file.path));
  const outside = input.changedPaths.find((path) => !classified.has(path));
  if (outside !== undefined) return weakening(`the PR changes ${shownLine(outside)}, which is not a classified .github/ file`);
  const why = requiredCheckLost(input.files, input.required) ?? diffWeakening(input.files);
  if (why !== undefined) return weakening(why);
  if (!input.freshMerge) return weakening("no reviewer MERGE was given at this head");
  const measurement = measurementLink(input.repo, input.prBody);
  return measurement === undefined ? weakening("the PR body links no measurement run") : { kind: "budget", measurement };
}

/** A required context named fewer times at head than at base was removed or renamed away. */
function requiredCheckLost(files: readonly CiPolicyFile[], required: readonly string[]): string | undefined {
  const count = (text: string, name: string): number => text.split(new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`)).length - 1;
  const lost = required.find((name) => files.reduce((sum, file) => sum + count(file.after, name) - count(file.before, name), 0) < 0);
  return lost === undefined ? undefined : `required check ${lost} was removed or renamed`;
}

function diffWeakening(files: readonly CiPolicyFile[]): string | undefined {
  let budgetChanged = false;
  for (const file of files) {
    const read = file.path === CI_BUDGET_PATH ? budgetJsonChange(file.before, file.after) : linesWeakening(file);
    if ("why" in read) return read.why;
    budgetChanged ||= read.changed;
  }
  return budgetChanged ? undefined : "no timeout, p90 or budget number changed";
}

/** Outside the budget data file, every changed line is a lone timeout or budget number, or a comment. */
function linesWeakening(file: CiPolicyFile): { why: string } | { changed: boolean } {
  let changed = false;
  const sides = { "-": linesOf(file.before), "+": linesOf(file.after) };
  for (const { side, index } of lineEdits(sides["-"], sides["+"])) {
    const line = sides[side][index] ?? "";
    const added = side === "+" ? ADDED_WEAKENINGS.find(([pattern]) => pattern.test(line)) : undefined;
    if (added) return { why: `${added[1]} in ${shownLine(file.path)}` };
    if (!BUDGET_NUMBER_LINE.test(line) && !COMMENT_LINE.test(line)) return { why: `${shownLine(file.path)} changes more than a timeout or budget number` };
    changed ||= BUDGET_NUMBER_LINE.test(line);
  }
  return { changed };
}

const linesOf = (text: string): string[] => text.split(/\r\n|\r|\n/);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A GitHub Actions run of this same repo, linked from the PR body as a whole URL, not inside another one. */
function measurementLink(repo: string, body: string | undefined): string | undefined {
  return new RegExp(`(?:^|[\\s(<\\[])(https://github\\.com/${escapeRegExp(repo)}/actions/runs/\\d+)(?=$|[\\s)>\\],.;:])`).exec(body ?? "")?.[1];
}
