import { CHECK_CONCLUSIONS, type CheckConclusion } from "./check-run-create.js";
import type { MergeMethod } from "./port.js";

/** A value that would change which GitHub resource a `gh api` path names; thrown before any call. */
export class GitHubInputError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`invalid ${field} ${JSON.stringify(value)}: ${reason}`);
    this.name = "GitHubInputError";
  }
}

const REPO_NAME = /^[A-Za-z0-9._-]+$/;
/** GitHub's owner grammar: 1 to 39 alphanumerics and single hyphens, never leading or trailing. */
const REPO_OWNER = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;
/** git check-ref-format's forbidden characters, plus `?`, `#` and `%`, which a URL path would decode or split on. */
const REF_FORBIDDEN = /[ ~^:?*[\\#%]/;
const PATH_FORBIDDEN = /[?#\\%]/;

function hasControl(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}
const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

/**
 * True for a bare `owner/name`. A `.git` suffix is refused: it names the same repo as the bare form
 * but compares unequal, so it would slip past a deny list. Never throws.
 */
export function isRepo(value: string): boolean {
  const [owner, name, ...extra] = value.split("/");
  if (extra.length > 0 || owner === undefined || name === undefined) return false;
  if (!REPO_OWNER.test(owner) || !REPO_NAME.test(name)) return false;
  return !/^\.+$/.test(name) && !name.includes("..") && !/\.git$/i.test(name);
}

export function checkRepo(repo: string): string {
  if (!isRepo(repo)) throw new GitHubInputError("repo", repo, "expected a bare owner/name");
  return repo;
}

export function checkRef(field: string, ref: string): string {
  const reason = refProblem(ref);
  if (reason) throw new GitHubInputError(field, ref, reason);
  return ref;
}

function refProblem(ref: string): string | undefined {
  if (ref.length === 0) return "empty";
  if (REF_FORBIDDEN.test(ref) || hasControl(ref)) return "contains a control, space or reserved character";
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return "contains .., // or @{";
  if (ref.startsWith("-") || ref.startsWith("/") || ref.startsWith(".")) return "starts with -, / or .";
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return "ends with /, . or .lock";
  return ref.split("/").some((part) => part.startsWith(".")) ? "has a component starting with ." : undefined;
}

export function checkSha(field: string, sha: string): string {
  if (!SHA.test(sha)) throw new GitHubInputError(field, sha, "expected 40 lower-case hex characters");
  return sha;
}

export function checkPositiveInt(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new GitHubInputError(field, value, "expected a positive safe integer");
  return value;
}

export function checkPath(path: string): string {
  const bad = path.length === 0 || path.startsWith("/") || PATH_FORBIDDEN.test(path) || hasControl(path) || path.split("/").some((part) => part === ".." || part === "." || part === "");
  if (bad) throw new GitHubInputError("path", path, "expected a relative path with no ., .. or empty segment, and no ?, # or %");
  return path;
}

export function checkMergeMethod(method: MergeMethod): MergeMethod {
  if (!MERGE_METHODS.includes(method)) throw new GitHubInputError("method", method, `expected one of ${MERGE_METHODS.join(", ")}`);
  return method;
}

/** A timestamp rides in a query field; anything `Date.parse` cannot read is refused, and the rest is sent as UTC ISO 8601. */
export function checkTimestamp(field: string, value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new GitHubInputError(field, value, "expected an ISO 8601 timestamp");
  return new Date(at).toISOString();
}

/** An empty marker matches every comment, so the first write would skip forever. */
export function checkMarker(marker: string): string {
  if (marker.length === 0) throw new GitHubInputError("marker", marker, "expected a non-empty string");
  return marker;
}

/** A check run posted under an App token may only end in these; anything else is refused before a wire call. */
export function checkConclusion(conclusion: string): CheckConclusion {
  if (!(CHECK_CONCLUSIONS as readonly string[]).includes(conclusion)) throw new GitHubInputError("conclusion", conclusion, `expected one of ${CHECK_CONCLUSIONS.join(", ")}`);
  return conclusion as CheckConclusion;
}
