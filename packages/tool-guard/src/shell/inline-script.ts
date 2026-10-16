import { caseScripts } from "./case-script.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { pipedShellTexts } from "./piped-nul.js";
import { shellOperands } from "./shell-options.js";
import { SPLICING_SHELLS, splicedWords, stdinScript } from "./sub-output.js";
import { chargeSpliced } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import type { Wrapping } from "./commands.js";
import type { Unwrapped } from "./unwrap.js";

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const STDIN_PATH_RE = /\/(?:dev\/stdin|dev\/fd\/0|proc\/(?:self|thread-self|\d+)\/fd\/0)$/;

/** Shell text a command runs, and how it reaches the commands in it. */
export interface Inline {
  texts: string[];
  wrap: Wrapping;
}

/**
 * The script a shell or `eval` runs: a `-c` string, else a heredoc, here-string or literal pipe on stdin. Eval and `-c`
 * text is read with and without what its substitutions print, when that is literal on the line.
 */
export function inlineScript(cmd: Unwrapped, redirects: RedirectToken[], piped: string[], budget: UnsureBudget): Inline | null {
  if (cmd.script !== undefined) return { texts: [cmd.script], wrap: "sh-c" };
  if (cmd.name === "eval") return { texts: splicedReadings(cmd.args, budget), wrap: "eval" };
  if (cmd.name === "emulate") return emulateScript(cmd.args, budget);
  if (cmd.name === null || !SHELLS.has(cmd.name)) return null;
  const { hasC, positional, readsStdin } = shellOperands(cmd.args, cmd.name);
  // `bash /dev/stdin <<< TEXT` runs its stdin as a script file.
  const stdin = readsStdin || (!hasC && positional !== null && isStdinPath(positional.value)) ? stdinReading(cmd.name, redirects, piped) : null;
  if (!hasC) return stdin;
  // A bare `-c` takes the pipe too: `xargs sh -c` turns the piped text into the string.
  const texts = positional ? splicedReadings([positional], budget) : piped;
  const all = [...texts, ...(stdin?.texts ?? [])];
  return all.length > 0 ? { texts: all, wrap: "sh-c" } : null;
}

/** A heredoc or here-string replaces the pipe as the shell's stdin. */
function stdinReading(shell: string | null, redirects: RedirectToken[], piped: string[]): Inline | null {
  const text = stdinScript(redirects);
  if (text !== null) return { texts: pipedShellTexts(shell, text), wrap: "heredoc-shell" };
  return piped.length === 0 ? null : { texts: piped.flatMap((t) => pipedShellTexts(shell, t)), wrap: "piped-shell" };
}

/**
 * Whether a script path names stdin however it is spelled (`//dev/stdin`, `/dev/./stdin`, `/dev/../dev/stdin`). The
 * path is matched on its tail: enough `..` reach `/` from any directory, so a relative path may name it too.
 */
function isStdinPath(path: string): boolean {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return STDIN_PATH_RE.test(`/${parts.join("/")}`);
}

/**
 * `emulate [-LR] MODE [options] -c TEXT` runs TEXT as eval does. The words are read as zsh's own two lexers read
 * them, so any cluster zsh takes `c` from (`-c2`, `-2c`, `+xc`, `-c-`) reaches the text. A dynamic word may expand
 * to any options, so from one on every word is read as the text.
 */
function emulateScript(args: WordToken[], budget: UnsureBudget): Inline | null {
  const words = emulateTextWords(args);
  if (words.length === 0) return null;
  return { texts: [...new Set(words.flatMap((w) => splicedReadings([w], budget)))], wrap: "eval" };
}

/**
 * The builtin lexer reads `-lLR` clusters before MODE: a lone `-` or `--` ends them, and a word whose second
 * character is a digit is MODE itself. zsh refuses `-c` with `-L` or `-l`, and any other letter there.
 */
function emulateTextWords(args: WordToken[]): WordToken[] {
  let flags = "";
  for (const [i, w] of args.entries()) {
    if (w.dynamic) return args.slice(i);
    if (!w.value.startsWith("-") || /^-\d/.test(w.value)) return optionTextWords(args, i + 1, flags);
    const body = w.value.startsWith("--") ? w.value.slice(2) : w.value.slice(1);
    if (body === "") return optionTextWords(args, i + 2, flags);
    if (!/^[lLR]+$/.test(body)) return [];
    flags += body;
  }
  return optionTextWords(args, args.length + 1, flags);
}

function optionTextWords(args: WordToken[], start: number, flags: string): WordToken[] {
  const mode = args[start - 1];
  if (mode === undefined) return [];
  if (mode.dynamic) return args.slice(start - 1);
  return /[lL]/.test(flags) ? [] : parsedText(args, start, false);
}

/**
 * zsh's `parseopts`, as `emulate` calls it after MODE. Any letter is taken as a valid option, since which letters
 * are depends on the calling shell's options. `b` ends the options only under zsh's own letters, so both are read.
 */
function parsedText(args: WordToken[], start: number, hasC: boolean): WordToken[] {
  for (let j = start, w = args[j]; w !== undefined; w = args[++j]) {
    if (w.dynamic) return args.slice(j);
    if (!/^[-+]/.test(w.value)) return hasC ? [w] : [];
    const read = readCluster(w.value);
    if (read === null) return [];
    hasC ||= read.c;
    if (read.end === "options") return hasC ? args.slice(j + 1, j + 2) : [];
    if (read.end === "name") {
      const name = args[++j];
      if (name === undefined) return [];
      if (name.dynamic) return args.slice(j);
    }
    if (read.b) return [...new Set([...(hasC ? args.slice(j + 1, j + 2) : []), ...parsedText(args, j + 1, hasC)])];
  }
  return [];
}

interface Cluster {
  c: boolean;
  b: boolean;
  end: "word" | "name" | "options";
}

/** One option word, or null where zsh refuses it: a `-` ends the options only as the word's last character. */
function readCluster(word: string): Cluster | null {
  const read: Cluster = { c: false, b: false, end: "word" };
  if (word.length === 1) return { ...read, end: "options" };
  for (let k = 1; k < word.length; k++) {
    const ch = word.charAt(k);
    if (ch === "-") return k === word.length - 1 ? { ...read, end: "options" } : null;
    if (ch === "o") return { ...read, end: k === word.length - 1 ? "name" : "word" };
    if (/\s/.test(ch)) return /^\s*$/.test(word.slice(k)) ? read : null;
    read.c ||= ch === "c";
    read.b ||= ch === "b";
  }
  return read;
}

/**
 * Splicing only adds a reading: where the model of a substitution's output is wrong (`printf '%d' '#'` prints `0`,
 * not `#`), the spliced text could hide what follows, so the text with substitutions left out is walked too. Each
 * shell's spliced text is a reading of its own, so output that bash and zsh print differently hides in neither. Only
 * the texts splicing adds are charged, so a line that nests eval walks them in time linear in its length or is refused.
 */
function splicedReadings(words: WordToken[], budget: UnsureBudget): string[] {
  const plain = caseScripts(words);
  const spliced = SPLICING_SHELLS.flatMap((shell) => caseScripts(splicedWords(words, shell)));
  const added = [...new Set(spliced)].filter((text) => !plain.includes(text));
  chargeSpliced(budget, added);
  return [...new Set([...plain, ...added])];
}
