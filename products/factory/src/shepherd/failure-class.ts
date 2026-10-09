import type { WorkflowFn } from "@titan-design/workflow";

export const FAILURE_CLASSES = ["ci-timeout", "gh-api-5xx", "land-rules", "update-branch", "other"] as const;
/** The closed set a failed Shepherd run's `error` is filed under, as its `[<class>] ` prefix. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const PREFIX = new RegExp(`^\\[(${FAILURE_CLASSES.join("|")})\\] `);
const CI_TIMEOUT = /\bci-wait timed out\b/;
const LAND_RULES = /\bstep land-rules[: ]/;
const UPDATE_BRANCH = /\bstep update-branch[: ]/;
/** GitHub's side gave out: a 5xx, no connection, or an empty or cut-off body. A 4xx is the request's own fault. */
const GH_API_FAILED = /\bgh api\b.* failed \(\d+\): ?(.*)$/s;
const GH_SERVER_SIDE = /HTTP 5\d\d|error connecting|unexpected end of JSON input|^\s*$/;

/** The class of an error text, read from its prefix when present; unprefixed legacy text is classified the same way the prefix was chosen. */
export function failureClassOf(error: string): FailureClass {
  const prefixed = PREFIX.exec(error)?.[1];
  if (prefixed !== undefined) return prefixed as FailureClass;
  if (CI_TIMEOUT.test(error)) return "ci-timeout";
  if (LAND_RULES.test(error)) return "land-rules";
  const ghTail = GH_API_FAILED.exec(error)?.[1];
  if (ghTail !== undefined && GH_SERVER_SIDE.test(ghTail)) return "gh-api-5xx";
  if (UPDATE_BRANCH.test(error)) return "update-branch";
  return "other";
}

/** `[<class>] <text>`, unchanged when the text already carries a prefix. */
export function withFailureClass(error: string): string {
  return PREFIX.test(error) ? error : `[${failureClassOf(error)}] ${error}`;
}

/**
 * The workflow package writes a rejected run's message into `workflow_run.error` verbatim, so the
 * prefix goes on at the Shepherd boundary; the error object is kept so the runtime's instanceof checks still hold.
 */
export function classifyingFailures(run: WorkflowFn): WorkflowFn {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (error) {
      if (!(error instanceof Error)) throw new Error(withFailureClass(String(error)));
      error.message = withFailureClass(error.message);
      throw error;
    }
  };
}
