type TokenKind = "github" | "anthropic" | "aws-access-key" | "slack" | "private-key";
interface TokenHit {
    readonly kind: TokenKind;
    readonly offset: number;
}
/** Each token kind in `text` once, at its first offset. A hit never carries the matched text. */
declare function locateTokens(text: string): TokenHit[];

type RuleId = "home-path" | "aw-data-path" | "private-term" | "credential-token";
declare const RULE_IDS: readonly RuleId[];
/** A compiled private term. It exposes its line number, never its text or pattern. */
interface TermRule {
    readonly index: number;
    matches(text: string): boolean;
    /** Offset of the first match, or -1. Optional so a bare matcher still works; a hit then reports column 1. */
    search?(text: string): number;
}
interface RuleHit {
    readonly rule: RuleId;
    readonly termIndex?: number;
    readonly kind?: TokenKind;
}
/** Home-directory segments that are placeholders, not people. Compared case-insensitively. */
declare const PLACEHOLDER_SEGMENTS: readonly string[];
declare function matchesHomePath(text: string): boolean;
declare function matchesAwDataPath(text: string): boolean;
/** Like `matchRules`, with the 0-based offset of each hit in `text`. */
declare function locateRules(text: string, terms?: readonly TermRule[]): (RuleHit & {
    readonly offset: number;
})[];
declare function matchRules(text: string, terms?: readonly TermRule[]): RuleHit[];

interface AddedLine {
    readonly line: number;
    readonly text: string;
}
interface DiffFile {
    readonly path: string;
    /** 1-based position in its diff, used in place of a path that itself trips a rule. */
    readonly ordinal: number;
    /** True for a new, renamed or copied file, whose path is itself new text. */
    readonly pathAdded: boolean;
    readonly binary: boolean;
    readonly lines: readonly AddedLine[];
}
/** A short named value scanned whole, such as a commit's author name or a pushed ref name. */
interface IdentField {
    readonly field: string;
    readonly text: string;
}
/** One unit of scanned text: a diff, or a commit's message, idents and diff. */
interface ScanSource {
    readonly sha?: string;
    readonly message?: readonly string[];
    readonly idents?: readonly IdentField[];
    readonly files: readonly DiffFile[];
    readonly binaryFiles: number;
}
/**
 * Parses `git diff -U0` or `git show -U0` patch text into the added lines of each file, with
 * new-file line numbers. Removed lines are dropped; binary files are kept for their path only.
 * A merge shown with `--diff-merges=separate` names a path once per parent; those fold into one.
 */
declare function parseDiff(text: string): ScanSource;
/** Parses `git show -U0 --format=%B%x00 <sha>` output: the message, a NUL, then the patch. */
declare function parseCommit(sha: string, text: string): ScanSource;

type AllowableRule = Exclude<RuleId, "private-term" | "credential-token">;
interface AllowEntry {
    readonly glob: string;
    readonly rule: AllowableRule;
    readonly line: number;
    readonly matches: (path: string) => boolean;
}
interface AllowList {
    readonly entries: readonly AllowEntry[];
}
declare const EMPTY_ALLOW: AllowList;
/** A malformed `.egress-allow`. Callers must fail the scan on it, never treat the file as empty. */
declare class AllowFileError extends Error {
    readonly line: number;
    constructor(line: number, reason: string);
}
declare function parseAllow(text: string): AllowList;
declare function isAllowed(allow: AllowList, path: string, rule: RuleId): boolean;

/** A term-file problem. The message names the line number only, never the term. */
declare class TermFileError extends Error {
    readonly line: number;
    constructor(line: number, reason: string);
}
/**
 * Parses a private term list: one term per line, `#` comments, blank lines ignored, matched
 * case-insensitively on word boundaries; a `re:` line is a regex source compiled with `iu`.
 */
declare function parseTerms(text: string): TermRule[];

/** Where a rule fired. By construction no field carries the matched text, term or line. */
interface Finding {
    readonly location: string;
    readonly rule: RuleId;
    readonly termIndex?: number;
    readonly kind?: TokenKind;
}
type RuleCounts = Record<RuleId, number>;
interface ScanOptions {
    readonly terms?: readonly TermRule[];
    readonly allow?: AllowList;
}
interface ScanResult {
    readonly findings: Finding[];
    readonly allowed: RuleCounts;
    readonly binaryFilesSkipped: number;
}
/** Scans added lines, added file paths, commit messages and idents. Messages and idents are never allowable. */
declare function scan(sources: readonly ScanSource[], options?: ScanOptions): ScanResult;

interface ReportSummary {
    readonly allowed: RuleCounts;
    readonly binaryFilesSkipped: number;
    readonly termsLoaded: boolean;
}
/**
 * Formats findings as `<location> <rule>[ #<termIndex>][ <kind>]` lines plus a summary. It takes no
 * scanned text, so it cannot echo a matched line, path fragment or term.
 */
declare function formatReport(findings: readonly Finding[], summary: ReportSummary): string[];

interface TextOptions {
    readonly terms?: readonly TermRule[];
}
/** Scans free text and reports each hit as `line:col`; `\r\n`, `\n` and `\r` each count as one break. */
declare function scanText(text: string, options?: TextOptions): Finding[];

export { type AddedLine, type AllowEntry, AllowFileError, type AllowList, type AllowableRule, type DiffFile, EMPTY_ALLOW, type Finding, type IdentField, PLACEHOLDER_SEGMENTS, RULE_IDS, type ReportSummary, type RuleCounts, type RuleHit, type RuleId, type ScanOptions, type ScanResult, type ScanSource, TermFileError, type TermRule, type TokenHit, type TokenKind, formatReport, isAllowed, locateRules, locateTokens, matchRules, matchesAwDataPath, matchesHomePath, parseAllow, parseCommit, parseDiff, parseTerms, scan, scanText };
