import type { AllowEntryType, Rules } from "./rules.js";
import { findHits } from "./shapes.js";
import type { ShapeId } from "./shapes.js";

export interface SourceFile {
  path: string;
  text: string;
}

export interface Finding {
  path: string;
  line: number;
  shape: ShapeId;
  /** The hit's line, trimmed. */
  text: string;
  /** Index into `rules.allow` of the entry that covers the hit, or null when nothing does. */
  allowedBy: number | null;
}

export interface ScanResult {
  findings: Finding[];
  /** Allow entries that cover no hit. */
  stale: number[];
  /** Wrapper entries still at `logs: false`. */
  notLogging: number[];
}

const compiled = new Map<string, RegExp>();

/** `**` crosses directories, `*` does not, `?` is one non-separator character. */
export function globToRegExp(glob: string): RegExp {
  const cached = compiled.get(glob);
  if (cached) return cached;
  const regexp = compileGlob(glob);
  compiled.set(glob, regexp);
  return regexp;
}

function compileGlob(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function matchesAny(globs: readonly string[], file: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/** A brief glob keeps a file in scope even when an exclude would drop it. */
export function inScope(rules: Rules, file: string): boolean {
  if (matchesAny(rules.scan.brief, file)) return true;
  return matchesAny(rules.scan.include, file) && !matchesAny(rules.exclude, file);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function covers(entry: AllowEntryType, file: string, lineText: string): boolean {
  return globToRegExp(entry.path).test(file) && (entry.text === undefined || lineText.includes(entry.text));
}

function findingsOf(file: SourceFile, rules: Rules): Finding[] {
  const starts = lineStarts(file.text);
  return findHits(file.text).map((hit) => {
    const line = lineOf(starts, hit.index);
    const text = file.text.slice(starts[line - 1], starts[line]).trim();
    const allowedBy = rules.allow.findIndex((entry) => covers(entry, file.path, text));
    return { path: file.path, line, shape: hit.shape, text, allowedBy: allowedBy === -1 ? null : allowedBy };
  });
}

/** Pure: no I/O. `scoped` files only; callers that scan a piped brief pass `scoped: false`. */
export function scan(files: readonly SourceFile[], rules: Rules, options: { scoped?: boolean } = {}): ScanResult {
  const scoped = options.scoped ?? true;
  const findings = files.filter((file) => !scoped || inScope(rules, file.path)).flatMap((file) => findingsOf(file, rules));
  const used = new Set(findings.flatMap((f) => (f.allowedBy === null ? [] : [f.allowedBy])));
  const stale = rules.allow.flatMap((_, i) => (used.has(i) ? [] : [i]));
  const notLogging = rules.allow.flatMap((entry, i) => (entry.kind === "wrapper" && !entry.logs ? [i] : []));
  return { findings, stale, notLogging };
}
