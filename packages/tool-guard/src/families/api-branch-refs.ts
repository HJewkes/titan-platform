import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";

/**
 * The branches a GitHub REST ref write moves. A null entry is a branch known only at run time. The matcher does not
 * know the protected list, so it names every branch and the caller tests each one.
 */
export interface BranchTarget {
  branches: (string | null)[];
}

const RUN_TIME: BranchTarget = { branches: [null] };

/** Anchored on `repos/<o>/<r>/` as `PULL_MERGE_RE` is, so full api.github.com and GHES `api/v3` URLs match too. */
const GIT_REFS_RE = /(?:^|\/)repos\/[^/]+\/[^/]+\/git\/refs?(\/.*)?$/i;
const HEADS_RE = /^\/heads\/(.+)$/i;
const REF_KEY_RE = /^ref(?:\[\])?$/;

const hasDotSegment = (path: string) => path.split("/").some((s) => s === "." || s === "..");

/** Decodes only the ASCII escapes, which always decode, so `%67it` reads as `git` beside an invalid `%E0`. */
const asciiDecoded = (path: string) => path.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * The URL's path as GitHub routes it. "unsure" for any `.` or `..` segment, as written or decoded: curl resolves
 * them before sending and gh does not, so the route depends on the client. Also "unsure" for a git refs route that
 * cannot be fully percent-decoded.
 */
function routedPath(url: string): string | "unsure" | null {
  const raw = url.replace(/[?#].*$/s, "");
  if (hasDotSegment(raw)) return "unsure";
  let path: string;
  try {
    path = decodeURIComponent(raw).replace(/\/{2,}/g, "/");
  } catch {
    return GIT_REFS_RE.test(asciiDecoded(raw).replace(/\/{2,}/g, "/")) ? "unsure" : null;
  }
  return hasDotSegment(path) ? "unsure" : path;
}

/** The text before a field's first `=`, and whether an expansion or a case attribute may change it. */
function fieldKey(word: WordToken): { key: string; literal: boolean } {
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
function refBranch(word: WordToken): string | null | undefined {
  if (word.dynamic || isCaseUnsure(word)) return null;
  const value = word.value.slice(word.value.indexOf("=") + 1);
  if (value.startsWith("@")) return null;
  const unqualified = value.replace(/^refs\//, "");
  if (unqualified !== value && !/^heads\//.test(unqualified)) return undefined;
  return unqualified.replace(/^heads\//, "");
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
  const refs = GIT_REFS_RE.exec(path);
  if (!refs) return null;
  const tail = (refs[1] ?? "").replace(/\/+$/, "");
  if (tail === "") return verb === null || verb === "POST" ? createdBranches(fields) : null;
  const head = HEADS_RE.exec(tail);
  return head ? { branches: [head[1] as string] } : null;
}
