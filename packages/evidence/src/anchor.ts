import type { LineRange } from "./citation.js";

/** The commits an anchor resolves against. `head` and `base` are full 40-hex commit ids. */
export interface AnchorPins {
  repo: string;
  head: string;
  base?: string;
}

/** A line range in one file at one pinned commit: `head/<path>#L10-L20` or `base/<path>#L7`. */
export interface RevisionAnchor extends LineRange {
  side: "head" | "base";
  repo: string;
  rev: string;
}

/** One end of a diff anchor: `L` is a line in the base file, `R` a line in the head file. */
export interface DiffEndpoint {
  side: "L" | "R";
  line: number;
  rev: string;
}

/** A range in a base-to-head diff of one file: `diff/<path>#L84-R90`. */
export interface DiffAnchor {
  side: "diff";
  repo: string;
  path: string;
  start: DiffEndpoint;
  end: DiffEndpoint;
}

export type Anchor = RevisionAnchor | DiffAnchor;

export type AnchorRejection = "bad-syntax" | "bad-path" | "bad-range" | "bad-pin";

export type AnchorParse = { ok: true; anchor: Anchor } | { ok: false; reason: AnchorRejection; detail: string };

const FULL_SHA = /^[0-9a-f]{40}$/;
const ANCHOR = /^(head|base|diff)\/(.*)#([LR]?)(\d+)(?:-([LR]?)(\d+))?$/;
// Control characters cannot appear in a line-oriented `git cat-file --batch` request.
const hasControlChar = (text: string): boolean => [...text].some((char) => char < " " || char === "\u007f");

/** True when `text` is written as an anchor, so it is checked as one rather than read as free text. */
export function isAnchorForm(text: string): boolean {
  return /^(head|base|diff)\/[^#]*#/.test(text);
}

/** True for a full, lowercase 40-hex git object id; abbreviations and ref names are not pins. */
export function isFullSha(rev: string): boolean {
  return FULL_SHA.test(rev);
}

const refuse = (reason: AnchorRejection, detail: string): AnchorParse => ({ ok: false, reason, detail });

function pathProblem(path: string): string | undefined {
  if (path.trim() === "") return "the path is empty";
  if (path.includes("\\")) return `${path} contains a backslash`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `${path} is absolute`;
  if (hasControlChar(path)) return `${path} contains a control character`;
  const segments = path.split("/");
  if (segments.includes("..")) return `${path} climbs out with ..`;
  if (segments.includes("")) return `${path} has an empty segment`;
  return undefined;
}

interface Pinned {
  repo: string;
  head: string;
  base: string;
}

/** The pins a side needs, or the reason they are unusable. A head/ anchor needs no base, so base is "" there. */
function pinned(side: string, pins: AnchorPins): Pinned | string {
  if (pins.repo.trim() === "") return "the repo pin is empty";
  if (!isFullSha(pins.head)) return `head pin ${pins.head} is not a 40-hex commit id`;
  if (side === "head") return { repo: pins.repo, head: pins.head, base: pins.base ?? "" };
  if (pins.base === undefined) return `a ${side}/ anchor needs a base pin`;
  if (!isFullSha(pins.base)) return `base pin ${pins.base} is not a 40-hex commit id`;
  return { repo: pins.repo, head: pins.head, base: pins.base };
}

function lineNumber(digits: string | undefined): number | undefined {
  const line = Number(digits);
  return Number.isSafeInteger(line) && line >= 1 ? line : undefined;
}

interface RawRange {
  startSide: string;
  start: number;
  endSide: string;
  end: number;
}

function revisionAnchor(side: "head" | "base", path: string, range: RawRange, pins: Pinned): AnchorParse {
  if (range.startSide !== "L" || range.endSide !== "L") return refuse("bad-syntax", `${side}/ lines are written L<n>`);
  if (range.end < range.start) return refuse("bad-range", `range ${range.start}-${range.end} is reversed`);
  const rev = side === "head" ? pins.head : pins.base;
  return { ok: true, anchor: { side, repo: pins.repo, rev, path, lineStart: range.start, lineEnd: range.end } };
}

function diffEndpoint(side: string, line: number, pins: Pinned): DiffEndpoint {
  return side === "L" ? { side: "L", line, rev: pins.base } : { side: "R", line, rev: pins.head };
}

function diffAnchor(path: string, range: RawRange, pins: Pinned): AnchorParse {
  if (range.startSide === "" || range.endSide === "") return refuse("bad-syntax", "diff/ lines are written L<n> or R<n>");
  if (range.startSide === range.endSide && range.end < range.start) {
    return refuse("bad-range", `range ${range.startSide}${range.start}-${range.endSide}${range.end} is reversed`);
  }
  const start = diffEndpoint(range.startSide, range.start, pins);
  const end = diffEndpoint(range.endSide, range.end, pins);
  return { ok: true, anchor: { side: "diff", repo: pins.repo, path, start, end } };
}

/**
 * Parses `head/<path>#L10-L20`, `base/<path>#L7` or `diff/<path>#L84-R90` against the pinned commits.
 * Refuses a reversed range, a path that is absolute, climbs with `..` or holds a backslash, and an
 * anchor whose side has no 40-hex pin. A diff/ anchor needs both pins. Whether the lines exist is
 * the caller's check, by verifyCitation over a LineSource at the anchor's revision.
 */
export function parseAnchor(text: string, pins: AnchorPins): AnchorParse {
  const match = ANCHOR.exec(text);
  if (!match) return refuse("bad-syntax", `${text} is not <head|base|diff>/<path>#L<n>[-L<n>]`);
  const [, side = "", path = "", startSide = "", startDigits, endSide = "", endDigits] = match;
  const badPath = pathProblem(path);
  if (badPath) return refuse("bad-path", badPath);
  const resolved = pinned(side, pins);
  if (typeof resolved === "string") return refuse("bad-pin", resolved);
  const single = endDigits === undefined;
  const start = lineNumber(startDigits);
  const end = single ? start : lineNumber(endDigits);
  if (start === undefined || end === undefined) return refuse("bad-range", "line numbers start at 1");
  const range = { startSide, start, endSide: single ? startSide : endSide, end };
  if (side === "diff") return diffAnchor(path, range, resolved);
  return revisionAnchor(side === "head" ? "head" : "base", path, range, resolved);
}
