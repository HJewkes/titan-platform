import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";

/**
 * The branches a GitHub REST ref write moves. A null entry is a branch known only at run time. The matcher does not
 * know the protected list, so it names every branch and the caller tests each one.
 */
interface BranchTarget {
  branches: (string | null)[];
}

const RUN_TIME: BranchTarget = { branches: [null] };

/** Anchored on `repos/<o>/<r>/` as `PULL_MERGE_RE` is, so full api.github.com and GHES `api/v3` URLs match too. */
const GIT_REFS_RE = /(?:^|\/)repos\/[^/]+\/[^/]+\/git\/refs?(\/.*)?$/i;
const HEADS_RE = /^\/heads\/(.+)$/i;
const REF_KEY_RE = /^ref(?:\[\])?$/;

/**
 * gh fills its placeholders anywhere in an endpoint or `-F` value, unanchored, with the checked-out branch or with
 * the owner and repo from GH_REPO or the cwd remote, all of which the agent controls. So `m:branch` or `{owner}` may
 * read `main` at run time. This is gh's own pattern; a `{word}` gh leaves alone only fails closed.
 */
const RUN_TIME_BRANCH_RE = /:(?:owner|repo|branch)\b|\{[a-z]+\}/i;

/** A branch name as GitHub receives it; null when gh substitutes it at run time. */
export const knownBranch = (name: string): string | null => (RUN_TIME_BRANCH_RE.test(name) ? null : name);

/** gh's own placeholders. `{branch}` may fill in slashes; `{owner}` and `{repo}` fill in one segment. */
const PLACEHOLDER_RE = /:(?:owner|repo|branch)\b|\{(?:owner|repo|branch)\}/i;
const REPO_SLOTS_RE = /(^|\/)repos\/([^/]+)\/([^/]+)/i;
const SLOT_PLACEHOLDER_RE = /^(?::owner|\{owner\}|:repo|\{repo\})$/i;
const clearedSlot = (segment: string) => (SLOT_PLACEHOLDER_RE.test(segment) ? "x" : segment);

/**
 * True when gh fills a placeholder that can change the route outside a whole `repos/<o>/<r>` slot: there
 * `{owner}` or `{repo}` can name a route word (GH_REPO=repos/x turns `{owner}/o/r/…` into `repos/o/r/…`), and
 * `{branch}` can name a whole route. A filled slot is read by `repoSlotFilled`.
 */
export function placeholderRoutes(rawPath: string): boolean {
  const slotsCleared = rawPath.replace(
    REPO_SLOTS_RE,
    (_, lead: string, owner: string, repo: string) => `${lead}repos/${clearedSlot(owner)}/${clearedSlot(repo)}`,
  );
  return PLACEHOLDER_RE.test(slotsCleared);
}

/**
 * True when gh fills a whole owner or repo slot of the first `repos/<o>/<r>`. go-gh only rejects an empty GH_REPO
 * part, so the fill may hold `?` or `#`, which cut the path back to the repository, or `%2F`, which GitHub decodes
 * into further route segments. The route is then unknown.
 */
export function repoSlotFilled(url: string): boolean {
  const slots = REPO_SLOTS_RE.exec(url.replace(/[?#].*$/s, ""));
  return slots !== null && [slots[2], slots[3]].some((slot) => SLOT_PLACEHOLDER_RE.test(slot ?? ""));
}

const hasDotSegment = (path: string) => path.split("/").some((s) => s === "." || s === "..");

/** Decodes only the ASCII escapes, which always decode, so `%67it` reads as `git` beside an invalid `%E0`. */
export const asciiDecoded = (path: string) => path.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * The URL's path as GitHub routes it. "unsure" for any `.` or `..` segment, as written or decoded: curl resolves
 * them before sending and gh does not, so the route depends on the client. "unsure" when a gh placeholder can
 * change the route. Also "unsure" for a path on `route` (by default the git refs route) that cannot be fully
 * percent-decoded.
 */
export function routedPath(url: string, route: RegExp = GIT_REFS_RE): string | "unsure" | null {
  const raw = url.replace(/[?#].*$/s, "");
  if (hasDotSegment(raw) || placeholderRoutes(raw)) return "unsure";
  let path: string;
  try {
    path = decodeURIComponent(raw).replace(/\/{2,}/g, "/");
  } catch {
    return route.test(asciiDecoded(raw).replace(/\/{2,}/g, "/")) ? "unsure" : null;
  }
  return hasDotSegment(path) ? "unsure" : path;
}

/** The text before a field's first `=`, and whether an expansion or a case attribute may change it. */
export function fieldKey(word: WordToken): { key: string; literal: boolean } {
  const typed = word.typed ?? word.value;
  const key = typed.slice(0, typed.includes("=") ? typed.indexOf("=") : typed.length);
  const eq = word.value.indexOf("=");
  const expandedBeforeEq =
    word.dynamic && (eq < 0 || word.refs.some((r) => r.start < eq) || (word.cuts ?? []).some((c) => c.at <= eq));
  return { key, literal: !expandedBeforeEq && !/[$`]/.test(key) };
}

/**
 * The branch a `ref` field value names; undefined for a ref outside `refs/heads`. A value read from a file (`-F
 * ref=@f`), expanded at run time or case-unsure is null.
 */
export function refBranch(word: WordToken): string | null | undefined {
  if (word.dynamic || isCaseUnsure(word)) return null;
  const value = word.value.slice(word.value.indexOf("=") + 1);
  if (value.startsWith("@")) return null;
  const unqualified = value.replace(/^refs\//, "");
  if (unqualified !== value && !/^heads\//.test(unqualified)) return undefined;
  return knownBranch(unqualified.replace(/^heads\//, ""));
}

/** POST `git/refs`: every `ref` field, and every field whose key is not literal, is a candidate. */
function createdBranches(fields: WordToken[] | "unread"): BranchTarget | null {
  if (fields === "unread") return RUN_TIME;
  const candidates = fields.filter((f) => {
    const { key, literal } = fieldKey(f);
    return !literal || REF_KEY_RE.test(key);
  });
  const branches = candidates.map(refBranch).filter((b): b is string | null => b !== undefined);
  return branches.length > 0 ? { branches } : null;
}

/** A filled repo slot reaches a ref on any PATCH, PUT or DELETE, and on a POST only through a `ref` field. */
function slotFilledWrite(verb: string | null, fields: WordToken[] | "unread"): BranchTarget | null {
  return verb === null || verb === "POST" ? createdBranches(fields) : RUN_TIME;
}

/**
 * A REST write that moves a branch ref: PATCH, DELETE, PUT or POST on `git/refs/heads/<x>`, or POST on `git/refs`
 * whose `ref` field is a head. A null method is a write. `fields` is "unread" when the body comes from `--input`.
 */
export function apiBranchRefWrite(url: string, method: string | null, fields: WordToken[] | "unread"): BranchTarget | null {
  const verb = method?.toUpperCase() ?? null;
  if (verb === "GET" || verb === "HEAD") return null;
  const path = routedPath(url);
  if (path === null) return null;
  if (path === "unsure") return RUN_TIME;
  if (repoSlotFilled(url)) return slotFilledWrite(verb, fields);
  const refs = GIT_REFS_RE.exec(path);
  if (!refs) return null;
  const tail = (refs[1] ?? "").replace(/\/+$/, "");
  if (tail === "") return verb === null || verb === "POST" ? createdBranches(fields) : null;
  const branch = HEADS_RE.exec(tail)?.[1];
  return branch === undefined ? null : { branches: [knownBranch(branch)] };
}
