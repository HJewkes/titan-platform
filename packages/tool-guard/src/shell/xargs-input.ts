import type { WordToken } from "./lexer.js";
import type { XargsBatch } from "./unwrap.js";
import { literalWord } from "./xargs-insert.js";

const MAX_RUN = 16;

/**
 * The word groups one `xargs` run each takes. Quoted input or an unreadable size shifts the real
 * boundaries, so every contiguous run of up to MAX_RUN words is read, plus all words together.
 */
export function batches(stdin: string, lines: string[][], batch: XargsBatch | null): string[][] {
  const all = lines.flat();
  if (batch === null) return [all];
  if (batch.size === null || /["'\\]/.test(stdin)) return [all, ...contiguousRuns(all.map((w) => w.replace(/["'\\]/g, "")))];
  const units = batch.unit === "lines" ? lines : all.map((w) => [w]);
  const size = batch.size;
  const groups = Array.from({ length: Math.ceil(units.length / size) }, (_, i) => units.slice(i * size, (i + 1) * size).flat());
  return groups.length > 1 ? [all, ...groups] : groups.length === 1 ? groups : [[]];
}

/**
 * The ways the input may split into lines of words. Blanks split it unless `-0`/`-d` name separators,
 * which then end each record and nothing else; an unreadable `-d` adds a reading per character of the input, so it fails closed.
 */
export function inputReadings(stdin: string, delimiters: string[] | null): string[][][] {
  const blanks = logicalLines(stdin).map(wordsOf).filter((l) => l.length > 0);
  if (delimiters !== null && delimiters.length === 0) return [blanks];
  if (delimiters !== null) return [delimitedRecords(stdin, delimiters)];
  return [blanks, ...[...new Set(stdin)].map((c) => delimitedRecords(stdin, [c]))];
}

/** One argument per record; a trailing newline, as `echo` leaves, is dropped so the last record still reads as typed. */
function delimitedRecords(stdin: string, delimiters: string[]): string[][] {
  return splitOn(stdin, delimiters).map((r) => [r.replace(/\r?\n$/, "")]);
}

/** Lines as `-L` counts them: a line ending in a blank continues onto the next. */
export function logicalLines(stdin: string): string[] {
  return stdin.split(/\r?\n/).reduce<string[]>((out, line, i) => {
    const prev = out[out.length - 1];
    if (i > 0 && prev !== undefined && /[ \t]$/.test(prev)) out[out.length - 1] = prev + line;
    else out.push(line);
    return out;
  }, []);
}

function contiguousRuns(words: string[]): string[][] {
  const runs: string[][] = [];
  for (let i = 0; i < words.length; i++) for (let n = 1; n <= MAX_RUN && i + n <= words.length; n++) runs.push(words.slice(i, i + n));
  return runs;
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Non-empty input records. A line ends at a newline or NUL; each `-d` separator also splits it, and an
 * unreadable `-d` splits on every character of the input in turn, letters and spaces included. Extra splits only add commands to classify.
 */
export function inputRecords(stdin: string, delimiters: string[] | null): string[] {
  const separators = delimiters ?? [...new Set(stdin)];
  const splits = [["\n", "\0"], ...separators.map((d) => [d])].map((seps) => splitOn(stdin, [...seps, "\n", "\0"]));
  const records = [...new Set(splits.flat())];
  return records.length > 0 ? records : [""];
}

function splitOn(text: string, separators: string[]): string[] {
  const escaped = separators.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.split(new RegExp(`\r?(?:${escaped.join("|")})`)).filter((r) => r.trim() !== "");
}

/** The exact reading of a line (one word), plus a split reading when a bare replace string could hold several words. */
export function lineRuns(args: WordToken[], replace: string, line: string, split: boolean): WordToken[][] {
  const exact = args.map((a) => (a.value.includes(replace) ? { ...a, value: a.value.replaceAll(replace, line) } : a));
  const words = line.split(/\s+/).filter(Boolean);
  if (!split || words.length < 2 || !args.some((a) => a.value === replace)) return [exact];
  const spread = args.flatMap((a, i) => (a.value === replace ? words.map(literalWord) : [exact[i] as WordToken]));
  return [exact, spread];
}
