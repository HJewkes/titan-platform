import type { WordToken } from "../shell/lexer.js";
import { asciiDecoded, fieldKey, knownBranch, placeholderRoutes, refBranch, repoSlotFilled, routedPath } from "./api-branch-refs.js";

type BranchRoute = "contents" | "rename" | "merge-upstream" | "protection" | "default-branch";

/**
 * A GitHub REST write outside `git/refs` that changes a branch or what protects it. A null entry is a branch known
 * only at run time, including the default branch. The matcher does not know the protected list, so it names every
 * branch and the caller tests each one.
 */
interface BranchRouteWrite {
  route: BranchRoute;
  branches: (string | null)[];
}

type Fields = WordToken[] | "unread";

/** Anchored on `repos/<o>/<r>` as `GIT_REFS_RE` is, so full api.github.com and GHES `api/v3` URLs match too. */
const REPO_ROUTE_RE = /(?:^|\/)repos\/[^/]+\/[^/]+(\/.*)?$/i;
const BRANCH_KEY_RE = /^branch(?:\[\])?$/;
const NEW_NAME_KEY_RE = /^new_name(?:\[\])?$/;
const DEFAULT_BRANCH_KEY_RE = /^default_branch(?:\[\])?$/;
/**
 * Keys a POST route reads: merge-upstream `branch`, rename `new_name`, protection `restrictions` `users`/`teams`/
 * `apps` and `required_status_checks` `contexts`, and the Merges API `base`/`head`.
 */
const ROUTE_FIELD_KEY_RE = /^(?:branch|new_name|default_branch|users|teams|apps|contexts|base|head)(?:\[\])?$/;
/** A merge suffix a filled slot can complete into the Merges API, merge-upstream or a pull merge. */
const MERGE_SUFFIX_RE = /\/(?:merges|merge-upstream|merge)\/?$/i;
/** The route a filled repo slot most plausibly reaches for each method, when the written path names none. */
const FILLED_ROUTES: Partial<Record<string, BranchRoute>> = { PUT: "contents", DELETE: "protection", PATCH: "default-branch" };

/** Raw-path guesses for a path whose route is unsure, most specific first. */
const LOOSE_ROUTES: [RegExp, BranchRoute][] = [
  [/\/protection(?:\/|$)/i, "protection"],
  [/\/rename(?:\/|$)/i, "rename"],
  [/\/merge-upstream(?:\/|$)/i, "merge-upstream"],
  [/\/contents(?:\/|$)/i, "contents"],
];
const LOOSE_ROUTE_RE = /(?:^|\/)repos\/.*\/(?:contents|merge-upstream|branches|rename|protection)(?:\/|$)/i;

/** Fields whose key matches `key`, or whose key is not literal. */
function candidates(fields: WordToken[], key: RegExp): WordToken[] {
  return fields.filter((f) => {
    const read = fieldKey(f);
    return !read.literal || key.test(read.key);
  });
}

/** The heads the matching fields name; a `refs/tags/…` value is dropped. */
function fieldBranches(fields: Fields, key: RegExp): (string | null)[] {
  if (fields === "unread") return [null];
  return candidates(fields, key)
    .map(refBranch)
    .filter((b): b is string | null => b !== undefined);
}

/** A contents write with no `branch` commits to the default branch, which is known only at run time. */
function contentsWrite(fields: Fields): BranchRouteWrite {
  const branches = fieldBranches(fields, BRANCH_KEY_RE);
  return { route: "contents", branches: branches.length > 0 ? branches : [null] };
}

/**
 * GitHub rejects merge-upstream without `branch` (422), so a call with none moves nothing. A `refs/tags/…` value is
 * not a head, so it reads as unknown rather than absent.
 */
function mergeUpstreamWrite(fields: Fields): BranchRouteWrite | null {
  if (fields === "unread") return { route: "merge-upstream", branches: [null] };
  const named = candidates(fields, BRANCH_KEY_RE);
  return named.length > 0 ? { route: "merge-upstream", branches: named.map((f) => refBranch(f) ?? null) } : null;
}

/** Any `default_branch` field, or a body that may hold one; the value never makes it safe (D1). */
function defaultBranchWrite(verb: string | null, fields: Fields): BranchRouteWrite | null {
  if (verb !== null && verb !== "PATCH") return null;
  if (fields === "unread") return { route: "default-branch", branches: [null] };
  const named = candidates(fields, DEFAULT_BRANCH_KEY_RE);
  return named.length > 0 ? { route: "default-branch", branches: named.map((f) => refBranch(f) ?? null) } : null;
}

/**
 * Branch names keep their slashes, so `branches/a/protection/b/protection` could name `a` or `a/protection/b`.
 * Every split that ends a valid route is a candidate.
 */
function branchesWrite(rest: string, fields: Fields): BranchRouteWrite | null {
  const segments = rest.split("/");
  const lower = segments.map((s) => s.toLowerCase());
  const protectedBy = lower.flatMap((s, i) => (i > 0 && s === "protection" ? [knownBranch(segments.slice(0, i).join("/"))] : []));
  const renamed = segments.length > 1 && lower[segments.length - 1] === "rename" ? segments.slice(0, -1).join("/") : null;
  if (renamed === null) return protectedBy.length > 0 ? { route: "protection", branches: protectedBy } : null;
  const branches = [...protectedBy, knownBranch(renamed), ...fieldBranches(fields, NEW_NAME_KEY_RE)];
  return { route: protectedBy.length > 0 ? "protection" : "rename", branches };
}

/** The route a repository-relative tail names; an empty tail is the repository itself. */
function tailWrite(tail: string, verb: string | null, fields: Fields): BranchRouteWrite | null {
  if (tail === "") return defaultBranchWrite(verb, fields);
  if (/^\/contents(?:\/.*)?$/i.test(tail)) return contentsWrite(fields);
  if (/^\/merge-upstream$/i.test(tail)) return mergeUpstreamWrite(fields);
  const rest = /^\/branches\/(.+)$/i.exec(tail)?.[1];
  return rest === undefined ? null : branchesWrite(rest, fields);
}

/**
 * An unsure path reads as the route its raw text loosely names, with the branch known only at run time. Dot segments
 * only drop text, so without `repos/` they reach no route. A gh placeholder can supply any of it, so a write whose
 * route a placeholder changes always denies: as protection under `branches`, else as contents.
 */
function unsureWrite(url: string, verb: string | null, fields: Fields): BranchRouteWrite | null {
  const unqueried = url.replace(/[?#].*$/s, "");
  const filled = placeholderRoutes(unqueried);
  const raw = asciiDecoded(unqueried);
  if (!filled && !/(?:^|\/)repos\//i.test(raw)) return null;
  const guess = LOOSE_ROUTES.find(([re]) => re.test(raw));
  if (guess) return { route: guess[1], branches: [null] };
  if (defaultBranchWrite(verb, fields)) return { route: "default-branch", branches: [null] };
  if (!filled) return null;
  return { route: /\/branches(?:\/|$)/i.test(raw) ? "protection" : "contents", branches: [null] };
}

/**
 * A filled repo slot (`repoSlotFilled`) makes the route unknown. PUT, DELETE and PATCH can reach a route whatever the
 * body (a protection sub-path takes any field); a POST only with a field a route reads, so a plain issue POST passes.
 */
function slotFilledWrite(path: string, verb: string | null, fields: Fields, read: BranchRouteWrite | null): BranchRouteWrite | null {
  const post = verb === null || verb === "POST";
  const routeless = fields !== "unread" && candidates(fields, ROUTE_FIELD_KEY_RE).length === 0;
  if (!read && post && routeless && !MERGE_SUFFIX_RE.test(path)) return null;
  return { route: read?.route ?? FILLED_ROUTES[verb ?? "POST"] ?? "merge-upstream", branches: [null] };
}

/**
 * A REST write that changes a branch outside `git/refs`: a contents PUT/DELETE, a branch rename, merge-upstream, a
 * write on branch protection, or a repository PATCH of `default_branch`. A null method is a write. `fields` is
 * "unread" when the body comes from `--input`.
 */
export function apiBranchRouteWrite(url: string, method: string | null, fields: Fields): BranchRouteWrite | null {
  const verb = method?.toUpperCase() ?? null;
  if (verb === "GET" || verb === "HEAD") return null;
  const path = routedPath(url, LOOSE_ROUTE_RE);
  if (path === null) return null;
  if (path === "unsure") return unsureWrite(url, verb, fields);
  const repo = REPO_ROUTE_RE.exec(path);
  const read = repo ? tailWrite((repo[1] ?? "").replace(/\/+$/, ""), verb, fields) : null;
  return repoSlotFilled(url) ? slotFilledWrite(path, verb, fields, read) : read;
}
