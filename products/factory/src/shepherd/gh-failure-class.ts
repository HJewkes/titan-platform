import { GhError } from "@titan-design/github";
import type { FailureClass } from "./failure-class-names.js";

/** GitHub's side gave out: a 5xx, no connection, or an empty or cut-off body, as `gh` or the transport reported it. A 4xx is the request's own fault. */
export const GH_SERVER_SIDE = /HTTP 5\d\d|error connecting|unexpected end of JSON input|^\s*$/;
/**
 * A read GitHub never answered by the transport's deadline. The Octokit deadline names the method first, so a timed-out
 * write, which may have landed, never matches and is never sent again.
 */
export const GH_READ_TIMEOUT = /^(GET|HEAD) \S+ timed out after \d+ ms/;

/**
 * The class of a failed `gh api` call, read off the `GhError` where the step caught it: the transport's rate-limit
 * field first, then what `gh` or the transport printed, since `GhError` has no field of its own for a server-side failure.
 */
function classOfGhError(error: GhError): FailureClass | undefined {
  if (error.rateLimit !== "") return "gh-rate-limit";
  if (error.args[0] !== "api") return undefined;
  const said = error.result.stderr.trim() || error.result.stdout.trim();
  return GH_SERVER_SIDE.test(said) || GH_READ_TIMEOUT.test(said) ? "gh-api-5xx" : undefined;
}

/** The first `GhError` on the error's `cause` chain, so a body that wraps a failed call keeps its class. */
export function ghFailureClass(error: unknown): FailureClass | undefined {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof GhError) return classOfGhError(at);
  }
  return undefined;
}
