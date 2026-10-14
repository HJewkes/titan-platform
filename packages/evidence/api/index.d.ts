/** Supplies file text by path, one entry per line with no terminators. Undefined means unreadable. */
interface LineSource {
    lines(path: string): readonly string[] | undefined;
}
/** Splits text into lines, dropping the empty entry a trailing newline would leave. */
declare function splitLines(text: string): string[];
/** A LineSource over in-memory text, keyed by path. */
declare function lineSourceFromTexts(texts: Readonly<Record<string, string>>): LineSource;

/** A 1-based inclusive line range in one file. */
interface LineRange {
    path: string;
    lineStart: number;
    lineEnd: number;
}
interface Citation extends LineRange {
    quote: string;
}
/** The lines a reader was shown, per path. A citation outside them is rejected. */
type ShownLines = ReadonlyMap<string, ReadonlySet<number>>;
interface VerifyOptions {
    allowedPaths?: Iterable<string>;
    shown?: ShownLines;
}
type CitationRejection = "bad-range" | "path-not-allowed" | "path-unreadable" | "past-eof" | "not-shown" | "quote-empty" | "quote-mismatch";
type CitationCheck = {
    ok: true;
    citation: Citation;
} | {
    ok: false;
    citation: Citation;
    reason: CitationRejection;
    detail: string;
};
/** Splits a quote on line breaks and "..." or "…" elisions into normalized, non-trivial fragments. */
declare function quoteFragments(quote: string): string[];
/**
 * True when every quote fragment occurs in the cited lines after whitespace normalization.
 * Returns null when the quote has no fragment long enough to check.
 */
declare function quoteInRange(fileLines: readonly string[], range: Omit<LineRange, "path">, quote: string): boolean | null;
/** Checks a citation's path, range, visibility and quote. Rejections carry a machine-readable reason. */
declare function verifyCitation(source: LineSource, citation: Citation, options?: VerifyOptions): CitationCheck;

/** The commits an anchor resolves against. `head` and `base` are full 40-hex commit ids. */
interface AnchorPins {
    repo: string;
    head: string;
    base?: string;
}
/** A line range in one file at one pinned commit: `head/<path>#L10-L20` or `base/<path>#L7`. */
interface RevisionAnchor extends LineRange {
    side: "head" | "base";
    repo: string;
    rev: string;
}
/** One end of a diff anchor: `L` is a line in the base file, `R` a line in the head file. */
interface DiffEndpoint {
    side: "L" | "R";
    line: number;
    rev: string;
}
/** A range in a base-to-head diff of one file: `diff/<path>#L84-R90`. */
interface DiffAnchor {
    side: "diff";
    repo: string;
    path: string;
    start: DiffEndpoint;
    end: DiffEndpoint;
}
type Anchor = RevisionAnchor | DiffAnchor;
type AnchorRejection = "bad-syntax" | "bad-path" | "bad-range" | "bad-pin";
type AnchorParse = {
    ok: true;
    anchor: Anchor;
} | {
    ok: false;
    reason: AnchorRejection;
    detail: string;
};
/** True for a full, lowercase 40-hex git object id; abbreviations and ref names are not pins. */
declare function isFullSha(rev: string): boolean;
/**
 * Parses `head/<path>#L10-L20`, `base/<path>#L7` or `diff/<path>#L84-R90` against the pinned commits.
 * Refuses a reversed range, a path that is absolute, climbs with `..` or holds a backslash, and an
 * anchor whose side has no 40-hex pin. A diff/ anchor needs both pins. Whether the lines exist is
 * the caller's check, by verifyCitation over a LineSource at the anchor's revision.
 */
declare function parseAnchor(text: string, pins: AnchorPins): AnchorParse;

/** True when two ranges share a path and at least one line. Touching ranges (10-12, 12-14) overlap. */
declare function rangesOverlap(a: LineRange, b: LineRange): boolean;
interface GroupOptions<T> {
    /** An extra condition two items must meet, beyond an overlapping range, to join one group. */
    related?: (a: T, b: T) => boolean;
}
/**
 * Groups items whose ranges overlap, transitively: a bridging item joins two groups into one.
 * Groups and their members keep input order.
 */
declare function groupByOverlap<T>(items: readonly T[], rangesOf: (item: T) => readonly LineRange[], options?: GroupOptions<T>): T[][];

/** Picks n distinct entries from the pool, in an order fixed by the seed. n is capped at the pool size. */
declare function pickControls<T>(pool: readonly T[], seed: string | number, n: number): T[];
type Planted<I, C> = {
    kind: "item";
    value: I;
} | {
    kind: "control";
    value: C;
};
interface Placement<I, C> {
    sequence: Planted<I, C>[];
    /** Index of each control in the sequence, in control order. */
    positions: number[];
}
/** Inserts each control at a seeded position among the items, so controls do not cluster at the ends. */
declare function placeControls<I, C>(items: readonly I[], controls: readonly C[], seed: string | number): Placement<I, C>;
interface LabeledAnswer {
    id: string;
    label: string;
}
interface LabelScore {
    expected: number;
    answered: number;
    correct: number;
    /** correct / answered; null when no control was answered with this label. */
    precision: number | null;
    /** correct / expected; null when no control expected this label. */
    recall: number | null;
}
interface ControlScore {
    total: number;
    correct: number;
    /** Expected controls with no answer. They count against recall. */
    missing: number;
    accuracy: number | null;
    perLabel: Record<string, LabelScore>;
}
/** Scores answers against planted controls' expected labels. Answers for unknown ids are ignored. */
declare function scoreControls(expected: readonly LabeledAnswer[], answered: readonly LabeledAnswer[]): ControlScore;

/** A deterministic generator of floats in [0, 1) from a string or number seed (mulberry32). */
declare function seededRandom(seed: string | number): () => number;

export { type Anchor, type AnchorParse, type AnchorPins, type AnchorRejection, type Citation, type CitationCheck, type CitationRejection, type ControlScore, type DiffAnchor, type DiffEndpoint, type GroupOptions, type LabelScore, type LabeledAnswer, type LineRange, type LineSource, type Placement, type Planted, type RevisionAnchor, type ShownLines, type VerifyOptions, groupByOverlap, isFullSha, lineSourceFromTexts, parseAnchor, pickControls, placeControls, quoteFragments, quoteInRange, rangesOverlap, scoreControls, seededRandom, splitLines, verifyCitation };
