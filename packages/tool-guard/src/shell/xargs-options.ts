import type { WordToken } from "./lexer.js";
import type { XargsBatch } from "./unwrap.js";

/** How xargs's own option list reads: where a short cluster ends, and which words take the next word as a value. */
export interface XargsSyntax {
  cluster: (word: string) => { flags: string[]; end: { option: string; text: string; optional: boolean } | null } | null;
  takesValue: (word: string) => boolean;
}

/**
 * Both readers below take `skipValues`: when set, a word an option consumes as its value (`-J -0`, `--max-args -n1`) is
 * not read as an option of its own, as getopt reads it; unset, it is read as one, which is how the guard read it before.
 */

function batchSize(word: WordToken | undefined, text: string | undefined = word?.value): number | null {
  if (!word || (text === word.value && word.dynamic) || !/^\d+$/.test(text ?? "")) return null;
  return Number(text) > 0 ? Number(text) : null;
}

/** The last `-L N`, `-lN`, `--max-lines[=N]`, `-n N`, `--max-args N` or a cluster such as `-rL1`; a bare `-l` or `--max-lines` means one line. */
export function xargsBatch(options: WordToken[], syntax: XargsSyntax, skipValues: boolean): XargsBatch | null {
  let found: XargsBatch | null = null;
  for (let j = 0; j < options.length; j++) {
    const word = options[j] as WordToken;
    const v = word.value;
    const next = options[j + 1];
    if (v === "--max-lines") found = { unit: "lines", size: 1 };
    else if (v === "--max-args") found = { unit: "args", size: batchSize(next) };
    else if (v.startsWith("--max-lines=")) found = { unit: "lines", size: batchSize(word, v.slice("--max-lines=".length)) };
    else if (v.startsWith("--max-args=")) found = { unit: "args", size: batchSize(word, v.slice("--max-args=".length)) };
    else found = clusterBatch(word, next, syntax) ?? found;
    if (skipValues && syntax.takesValue(v)) j++;
  }
  return found;
}

/** The `-L`, `-l` or `-n` option that ends a short cluster; its value is the rest of the word. */
function clusterBatch(word: WordToken, next: WordToken | undefined, syntax: XargsSyntax): XargsBatch | null {
  const end = syntax.cluster(word.value)?.end;
  if (end?.option === "l") return { unit: "lines", size: end.text ? batchSize(word, end.text) : 1 };
  if (end?.option !== "L" && end?.option !== "n") return null;
  return { unit: end.option === "L" ? "lines" : "args", size: end.text ? batchSize(word, end.text) : batchSize(next) };
}

const DELIMITER_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\" };

/** The separator a `-d` value names: one character or a C escape; null when dynamic or longer. */
function delimiterOf(word: WordToken | undefined, text?: string): string | null {
  if (!word || (text === undefined && word.dynamic)) return null;
  const v = text ?? word.value;
  if (v.length === 1) return v;
  return v.length === 2 && v[0] === "\\" ? (DELIMITER_ESCAPES[v[1] as string] ?? null) : null;
}

/** The record separators of `-0`, `--null`, `-d c`, `-dc`, `--delimiter=c` or a cluster such as `-t0`; null if one is unreadable. */
export function xargsDelimiters(options: WordToken[], syntax: XargsSyntax, skipValues: boolean): string[] | null {
  const out: string[] = [];
  for (let j = 0; j < options.length; j++) {
    const v = (options[j] as WordToken).value;
    if (v === "--null") out.push("\0");
    else if (v === "--delimiter") out.push(delimiterOf(options[++j]) ?? "");
    else if (v.startsWith("--delimiter=")) out.push(delimiterOf(options[j], v.slice("--delimiter=".length)) ?? "");
    else {
      const used = clusterDelimiters(options, j, out, syntax);
      j = skipValues && used === j && syntax.takesValue(v) ? j + 1 : used;
    }
  }
  return out.includes("") ? null : out;
}

/** Reads the `0` and `d` options of the cluster at `j`; returns the index of the last word it used. */
function clusterDelimiters(options: WordToken[], j: number, out: string[], syntax: XargsSyntax): number {
  const cluster = syntax.cluster((options[j] as WordToken).value);
  if (!cluster) return j;
  out.push(...cluster.flags.filter((c) => c === "0").map(() => "\0"));
  const end = cluster.end;
  if (!end) return j;
  if (end.option === "d") out.push((end.text ? delimiterOf(options[j], end.text) : delimiterOf(options[j + 1])) ?? "");
  return end.text || end.optional ? j : j + 1;
}
