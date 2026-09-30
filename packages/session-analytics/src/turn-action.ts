export const ACTION_CLASSES = [
  "journal-write",
  "pr-ci-check",
  "merge",
  "dispatch",
  "retire",
  "task-state",
  "budget-status",
  "scorer",
  "message",
  "read-investigate",
  "text-only",
  "other",
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];

/** One tool call of a request, with the signals session-read extracted for it. */
export interface ActionCall {
  tool: string;
  /** Command heads of a Bash call, such as `gh pr checks`. */
  heads?: readonly string[];
  readPaths?: readonly string[];
  writePaths?: readonly string[];
}

/** A rule matches a call when every field it sets matches; list order is the precedence. */
export interface ActionRule {
  cls: ActionClass;
  tool?: RegExp;
  head?: RegExp;
  readPath?: RegExp;
  writePath?: RegExp;
}

const JOURNAL_PATH = /(log[^/]*\.md|journal|\.jsonl)$/i;

export const DEFAULT_ACTION_RULES: readonly ActionRule[] = [
  { cls: "journal-write", writePath: JOURNAL_PATH },
  { cls: "journal-write", head: /^>.*(log[^/]*\.md|journal|\.jsonl)$/i },
  { cls: "pr-ci-check", head: /^gh pr (checks|view)\b/ },
  { cls: "pr-ci-check", head: /^gh run\b/ },
  { cls: "merge", head: /^gh pr merge\b|pulls\/\d+\/merge/ },
  { cls: "dispatch", tool: /agent_(spawn|resume)$/ },
  { cls: "retire", head: /\bagent retire\b/ },
  { cls: "task-state", head: /^active-work task\b/ },
  { cls: "budget-status", tool: /(session_budget|chat_status)$/ },
  { cls: "budget-status", head: /\bagent list\b/ },
  { cls: "scorer", tool: /\bscor/i },
  { cls: "scorer", head: /\bscor/i },
  { cls: "message", tool: /chat_send$/ },
  { cls: "read-investigate", tool: /^(Read|Grep|Glob)$/ },
  { cls: "read-investigate", head: /^(cat|ls|grep|rg|head|tail|find|wc|git (log|diff|show|status))\b/ },
];

/** Dispatch is judgment about what to hand out, so it stays out of the mechanical list. */
export const DEFAULT_MECHANICAL_CLASSES: readonly ActionClass[] = [
  "journal-write",
  "pr-ci-check",
  "task-state",
  "budget-status",
  "retire",
  "merge",
  "scorer",
];

function callMatches(call: ActionCall, rule: ActionRule): boolean {
  if (rule.tool && !rule.tool.test(call.tool)) return false;
  if (rule.head && !(call.heads ?? []).some((h) => rule.head?.test(h))) return false;
  if (rule.readPath && !(call.readPaths ?? []).some((p) => rule.readPath?.test(p))) return false;
  if (rule.writePath && !(call.writePaths ?? []).some((p) => rule.writePath?.test(p))) return false;
  return true;
}

export function classifyRequest(
  calls: readonly ActionCall[],
  rules: readonly ActionRule[] = DEFAULT_ACTION_RULES,
): ActionClass {
  if (calls.length === 0) return "text-only";
  const hit = rules.find((rule) => calls.some((call) => callMatches(call, rule)));
  return hit?.cls ?? "other";
}
