import { GhError } from "@titan-design/github";
import type { FailureClass } from "./failure-class-names.js";

/**
 * The class of a failed `gh api` call, read off the `GhError` where the step caught it: the transport's rate-limit
 * field first, then its transport kind. Any kind but `none` is GitHub's side giving out; a timed-out write is `none`.
 */
function classOfGhError(error: GhError): FailureClass | undefined {
  if (error.rateLimit !== "") return "gh-rate-limit";
  if (error.args[0] !== "api") return undefined;
  return error.transport === "none" ? undefined : "gh-api-5xx";
}

/** The first `GhError` on the error's `cause` chain, so a body that wraps a failed call keeps its class. */
export function ghFailureClass(error: unknown): FailureClass | undefined {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof GhError) return classOfGhError(at);
  }
  return undefined;
}
