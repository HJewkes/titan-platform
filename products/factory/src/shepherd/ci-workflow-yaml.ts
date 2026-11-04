import { isDeepStrictEqual } from "node:util";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { parseDocument } from "yaml";
import { shownLine } from "./ci-policy-changes.js";

/** A workflow file under `.github/workflows/`; the only YAML the budget class reads. */
export const isWorkflowPath = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** A weakening reason, or whether any timeout changed or was added. */
type WorkflowChange = { why: string } | { changed: boolean };

type Node = Record<string, unknown>;

const TIMEOUT = "timeout-minutes";

const without = (node: Node, key: string): Node => Object.fromEntries(Object.entries(node).filter(([name]) => name !== key));

/**
 * Judged by parsed structure, never by line text: base and head trees must be equal once the `timeout-minutes` of each job
 * and step is masked. A timeout may move or be added only where GitHub reads one, directly under a job that runs steps or
 * under a step, so no key elsewhere can break the workflow while reading as a budget number.
 */
export function workflowYamlChange(path: string, before: string, after: string): WorkflowChange {
  const [base, head] = [parseWorkflow(before), parseWorkflow(after)];
  if (base === undefined || head === undefined) return { why: `${shownLine(path)} is not a workflow that parses at base and head` };
  const why = (what: string): WorkflowChange => ({ why: `${shownLine(path)} changes ${what}` });
  if (!isDeepStrictEqual(without(base, "jobs"), without(head, "jobs"))) return why("more than its jobs' timeouts");
  if (!isDeepStrictEqual(Object.keys(base.jobs), Object.keys(head.jobs))) return why("its job ids");
  let changed = false;
  for (const id of Object.keys(base.jobs)) {
    const job = jobChange(base.jobs[id], head.jobs[id]);
    if (typeof job === "string") return why(`${job} of job ${shownLine(id)}`);
    changed ||= job;
  }
  return { changed };
}

function parseWorkflow(text: string): (Node & { jobs: Record<string, unknown> }) | undefined {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || doc.warnings.length > 0) return undefined;
  const tree: unknown = doc.toJS();
  return isObjectLike(tree) && isObjectLike(tree.jobs) ? { ...tree, jobs: tree.jobs } : undefined;
}

/** What else changed, or whether the timeout moved. */
function jobChange(base: unknown, head: unknown): string | boolean {
  if (!isObjectLike(base) || !isObjectLike(head)) return "more than a timeout";
  const own = cappedChange(base, head, "steps", head.uses === undefined);
  if (typeof own === "string") return own;
  if (isDeepStrictEqual(base.steps, head.steps)) return own;
  const [baseSteps, headSteps]: unknown[] = [base.steps, head.steps];
  if (!Array.isArray(baseSteps) || !Array.isArray(headSteps) || baseSteps.length !== headSteps.length) return "its steps";
  const steps = baseSteps.map((step: unknown, i) => {
    const after: unknown = headSteps[i];
    return isObjectLike(step) && isObjectLike(after) ? cappedChange(step, after, undefined, true) : "a step";
  });
  return steps.find((step): step is string => typeof step === "string") ?? (own || steps.includes(true));
}

/** Every key but the timeout (and `nested`, judged by the caller) is equal; the timeout is kept or set to a whole number of minutes. */
function cappedChange(base: Node, head: Node, nested: string | undefined, timeoutAllowed: boolean): string | boolean {
  const masked = (node: Node): Node => without(nested === undefined ? node : without(node, nested), TIMEOUT);
  if (!isDeepStrictEqual(masked(base), masked(head))) return "more than a timeout";
  if (isDeepStrictEqual(base[TIMEOUT], head[TIMEOUT])) return false;
  if (!timeoutAllowed) return "a timeout on a job that calls a reusable workflow";
  const minutes = head[TIMEOUT];
  return typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? true : "a timeout to something other than whole minutes";
}
