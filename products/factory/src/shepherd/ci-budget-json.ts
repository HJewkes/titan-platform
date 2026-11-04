import { isDeepStrictEqual } from "node:util";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { shownLine } from "./ci-policy-changes.js";

/** The one file whose budget data may change beyond a single number line; read field by field, never line by line. */
export const CI_BUDGET_PATH = ".github/ci-budget.json";

/** A weakening reason, or whether any budget number changed or any entry was added. */
type BudgetJsonChange = { why: string } | { changed: boolean };

type Entry = Record<string, unknown>;

interface BudgetData {
  [key: string]: unknown;
  budgets: Entry[];
}

/**
 * Only budget numbers may move and entries be added: every other setting (`workflow`, `runs`, ...) stays equal, and every
 * base entry survives with the same non-number fields, so no job loses its cap and no cap moves to another workflow.
 */
export function budgetJsonChange(before: string, after: string): BudgetJsonChange {
  const [base, head] = [parseBudget(before), parseBudget(after)];
  if (base === undefined || head === undefined) return { why: `${CI_BUDGET_PATH} is not a budget object at base and head` };
  const setting = Object.keys({ ...base, ...head }).find((key) => key !== "budgets" && key !== "$comment" && !isDeepStrictEqual(base[key], head[key]));
  if (setting !== undefined) return { why: `it changes ${shownLine(setting)} in ${CI_BUDGET_PATH}` };
  return entriesChange(base.budgets, head.budgets);
}

function parseBudget(text: string): BudgetData | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObjectLike(parsed) || !Array.isArray(parsed.budgets) || !parsed.budgets.every(isObjectLike)) return undefined;
    return { ...parsed, budgets: parsed.budgets };
  } catch {
    return undefined;
  }
}

function entriesChange(before: readonly Entry[], after: readonly Entry[]): BudgetJsonChange {
  const unused = [...after];
  let changed = false;
  for (const entry of before) {
    const at = unused.findIndex((candidate) => sameBudget(entry, candidate));
    if (at < 0) return { why: `it removes or reshapes the budget entry ${shownLine(JSON.stringify(nonNumbers(entry)))} in ${CI_BUDGET_PATH}` };
    changed ||= !isDeepStrictEqual(entry, unused[at]);
    unused.splice(at, 1);
  }
  return { changed: changed || unused.length > 0 };
}

/** The same keys, the same non-number values, and a number wherever the base had one. */
function sameBudget(base: Entry, head: Entry): boolean {
  const keys = Object.keys(base);
  const sorted = (names: string[]): string[] => names.sort((a, b) => a.localeCompare(b));
  if (!isDeepStrictEqual(sorted([...keys]), sorted(Object.keys(head)))) return false;
  return keys.every((key) => (typeof base[key] === "number" ? typeof head[key] === "number" : isDeepStrictEqual(base[key], head[key])));
}

const nonNumbers = (entry: Entry): Entry => Object.fromEntries(Object.entries(entry).filter(([, value]) => typeof value !== "number"));
