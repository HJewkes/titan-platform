import { EMPTY_ALLOW, isAllowed, type AllowList } from "./allow.js";
import type { DiffFile, ScanSource } from "./diff.js";
import { matchRules, type RuleHit, type RuleId, type TermRule } from "./rules.js";

/** Where a rule fired. By construction no field carries the matched text, term or line. */
export interface Finding {
  readonly location: string;
  readonly rule: RuleId;
  readonly termIndex?: number;
}

export type RuleCounts = Record<RuleId, number>;

export interface ScanOptions {
  readonly terms?: readonly TermRule[];
  readonly allow?: AllowList;
}

export interface ScanResult {
  readonly findings: Finding[];
  readonly allowed: RuleCounts;
  readonly binaryFilesSkipped: number;
}

interface Context {
  readonly terms: readonly TermRule[];
  readonly allow: AllowList;
  readonly findings: Finding[];
  readonly allowed: RuleCounts;
}

export function zeroCounts(): RuleCounts {
  return { "home-path": 0, "aw-data-path": 0, "private-term": 0 };
}

function record(ctx: Context, location: string, hits: readonly RuleHit[], path?: string): void {
  for (const { rule, termIndex } of hits) {
    if (path !== undefined && isAllowed(ctx.allow, path, rule)) ctx.allowed[rule]++;
    else ctx.findings.push(termIndex === undefined ? { location, rule } : { location, rule, termIndex });
  }
}

function scanFile(ctx: Context, file: DiffFile, prefix: string): void {
  const pathHits = matchRules(file.path, ctx.terms);
  // A path that trips a rule would leak through the location itself, so it is replaced by its ordinal.
  const name = pathHits.length > 0 ? `file #${file.ordinal}` : file.path;
  if (file.pathAdded) record(ctx, `${prefix}${name} path`, pathHits, file.path);
  for (const { line, text } of file.lines) {
    record(ctx, `${prefix}${name}:${line}`, matchRules(text, ctx.terms), file.path);
  }
}

function scanSource(ctx: Context, source: ScanSource): void {
  const prefix = source.sha === undefined ? "" : `commit ${source.sha.slice(0, 7)} `;
  source.message?.forEach((text, i) => record(ctx, `${prefix}message:${i + 1}`, matchRules(text, ctx.terms)));
  for (const file of source.files) scanFile(ctx, file, prefix);
}

/** Scans added lines, added file paths and commit messages. Messages are never allowable. */
export function scan(sources: readonly ScanSource[], options: ScanOptions = {}): ScanResult {
  const ctx: Context = {
    terms: options.terms ?? [],
    allow: options.allow ?? EMPTY_ALLOW,
    findings: [],
    allowed: zeroCounts(),
  };
  for (const source of sources) scanSource(ctx, source);
  const binaryFilesSkipped = sources.reduce((sum, source) => sum + source.binaryFiles, 0);
  return { findings: ctx.findings, allowed: ctx.allowed, binaryFilesSkipped };
}
