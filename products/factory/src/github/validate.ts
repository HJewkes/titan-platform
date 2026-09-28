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

const REPO_PART = /^[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;
/** git check-ref-format's forbidden characters, plus the URL delimiters `?` and `#`. */
const REF_FORBIDDEN = /[ ~^:?*[\\#]/;
const PATH_FORBIDDEN = /[?#\\]/;

function hasControl(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}
const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export function checkRepo(repo: string): string {
  const parts = repo.split("/");
  const bad = parts.length !== 2 || parts.some((part) => !REPO_PART.test(part) || part === "." || part === "..");
  if (bad) throw new GitHubInputError("repo", repo, "expected owner/name of [A-Za-z0-9._-]");
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
  if (bad) throw new GitHubInputError("path", path, "expected a relative path with no ., .. or empty segment, and no ? or #");
  return path;
}

export function checkMergeMethod(method: MergeMethod): MergeMethod {
  if (!MERGE_METHODS.includes(method)) throw new GitHubInputError("method", method, `expected one of ${MERGE_METHODS.join(", ")}`);
  return method;
}
