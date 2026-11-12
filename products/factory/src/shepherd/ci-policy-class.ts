import { z } from "zod";
import { budgetJsonChange, CI_BUDGET_PATH } from "./ci-budget-json.js";
import { shownLine, type CiPolicyFile } from "./ci-policy-changes.js";
import { isWorkflowPath, workflowYamlChange } from "./ci-workflow-yaml.js";

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
    const read = structuralChange(file);
    if ("why" in read) return read.why;
    budgetChanged ||= read.changed;
  }
  return budgetChanged ? undefined : "no timeout, p90 or budget number changed";
}

/** Every file is judged by its parsed structure; a kind with no structural reader may hide anything, so it is a weakening. */
function structuralChange(file: CiPolicyFile): { why: string } | { changed: boolean } {
  if (file.path === CI_BUDGET_PATH) return budgetJsonChange(file.before, file.after);
  if (isWorkflowPath(file.path)) return workflowYamlChange(file.path, file.before, file.after);
  return { why: `${shownLine(file.path)} is not the budget data file or a workflow, so its change is not read as budget` };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LINK_OPENERS =/[\s(<[]/;
const LINK_CLOSERS = ")>],.;:";

/** GitHub owner and repo names are case-insensitive, so the link is compared by its parsed path, not matched as text. */
function runLinkOf(token: string, repo: string): string | undefined {
  let end = token.length;
  while (end > 0 && LINK_CLOSERS.includes(token[end - 1]!)) end -= 1;
  const url = URL.parse(token.slice(0, end));
  if (url === null || url.origin !== "https://github.com" || url.search !== "" || url.hash !== "") return undefined;
  const [owner, name, actions, runs, id, ...rest] = url.pathname.slice(1).split("/");
  const sameRepo = `${owner}/${name}`.toLowerCase() === repo.toLowerCase();
  const exactRunId = id !== undefined && id !== "" && [...id].every((char) => char >= "0" && char <= "9");
  return sameRepo && actions === "actions" && runs === "runs" && exactRunId && rest.length === 0 ? `${url.origin}${url.pathname}` : undefined;
}

/** A GitHub Actions run of this same repo, linked from the PR body as a whole URL, not inside another one. */
function measurementLink(repo: string, body: string | undefined): string | undefined {
  return (body ?? "").split(LINK_OPENERS).map((token) => runLinkOf(token, repo)).find((link) => link !== undefined);
}
