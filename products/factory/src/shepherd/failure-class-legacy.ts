import { parseRateLimitMarker } from "@titan-design/github";
import { isOneOf } from "../narrow.js";
import { FAILURE_CLASSES, type FailureClass } from "./failure-class-names.js";

/*
 * Legacy-only, 2026-11-13 (TP-5446 S11b): a run written since then records its class in `workflow_run.error_class` at
 * the failure site, so this text classifier reads only rows written before that column existed. Nothing new calls it.
 */

const PREFIX = new RegExp(`^\\[(${FAILURE_CLASSES.join("|")})\\] `);
const CI_TIMEOUT = /\bci-wait timed out\b/;
const LAND_RULES = /\bstep land-rules[: ]/;
const UPDATE_BRANCH = /\bstep update-branch[: ]/;
const GH_API_FAILED = /\bgh api\b.* failed \(\d+\): ?(.*)$/s;
/** GitHub's side gave out: a 5xx, no connection, or an empty or cut-off body, as `gh` or the transport reported it. */
const GH_SERVER_SIDE = /HTTP 5\d\d|error connecting|unexpected end of JSON input|^\s*$/;
/** A read GitHub never answered by the transport's deadline; the deadline names the method first, so a write never matches. */
const GH_READ_TIMEOUT = /^(GET|HEAD) \S+ timed out after \d+ ms/;

/** A pre-2026-11-13 row's class, from its `[<class>] ` prefix when present, else from the text the prefix was chosen by. */
export function legacyFailureClassOf(error: string): FailureClass {
  const prefixed = PREFIX.exec(error)?.[1];
  if (prefixed !== undefined && isOneOf(FAILURE_CLASSES, prefixed)) return prefixed;
  if (CI_TIMEOUT.test(error)) return "ci-timeout";
  if (parseRateLimitMarker(error)) return "gh-rate-limit";
  if (LAND_RULES.test(error)) return "land-rules";
  const ghTail = GH_API_FAILED.exec(error)?.[1];
  if (ghTail !== undefined && (GH_SERVER_SIDE.test(ghTail) || GH_READ_TIMEOUT.test(ghTail))) return "gh-api-5xx";
  if (UPDATE_BRANCH.test(error)) return "update-branch";
  return "other";
}
