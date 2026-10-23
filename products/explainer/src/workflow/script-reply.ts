import type { z } from "zod";

/** Enough issues to fix the reply by, few enough that a reply in the wrong shape does not flood the run error. */
const MAX_ISSUES = 25;
export const issueText = (issues: readonly z.core.$ZodIssue[]): string => {
  const shown = issues.slice(0, MAX_ISSUES).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return [...shown, ...(issues.length > MAX_ISSUES ? [`and ${issues.length - MAX_ISSUES} more`] : [])].join("; ");
};

/** The reply's outermost JSON object, so a reply wrapped in a code fence or a sentence still parses. */
export function replyObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const isObject = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;

/** Deletes, in place, each key zod reports as unrecognized, and returns its dotted path. */
export function stripUnknownKeys(raw: unknown, issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") return [];
    const owner = issue.path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), raw);
    if (!isObject(owner)) return [];
    for (const key of issue.keys) Reflect.deleteProperty(owner, key);
    return issue.keys.map((key) => [...issue.path, key].join("."));
  });
}
