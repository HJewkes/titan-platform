import { caseScripts } from "./case-script.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { pipedShellTexts } from "./piped-nul.js";
import { SPLICING_SHELLS, splicedWords, stdinScript } from "./sub-output.js";
import { chargeSpliced } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import type { Wrapping } from "./commands.js";
import type { Unwrapped } from "./unwrap.js";

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const EMULATE_C = /^[-+][A-Za-z]*c[A-Za-z]*$/;
const EMULATE_FLAG = /^(?:-|--|[-+][A-Za-z]+)$/;

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
  const { hasC, positional } = shellOperands(cmd.args);
  // A bare `-c` takes the pipe too: `xargs sh -c` turns the piped text into the string.
  const text = hasC ? (positional ? splicedReadings([positional], budget) : piped.length > 0 ? piped : null) : positional ? null : stdinScript(redirects);
  if (text !== null) return { texts: hasC ? [text].flat() : [text].flat().flatMap((t) => pipedShellTexts(cmd.name, t)), wrap: hasC ? "sh-c" : "heredoc-shell" };
  return hasC || positional || piped.length === 0 ? null : { texts: piped.flatMap((t) => pipedShellTexts(cmd.name, t)), wrap: "piped-shell" };
}

/**
 * `emulate MODE [flags] -c TEXT` runs TEXT as eval does. zsh takes the first word past the flags, which `+c`, `-xc`,
 * `-co NAME` and a lone `-` all reach, and a dynamic word may be `-c`. So every word from the first `c` flag or dynamic
 * word on that is not itself a flag is read as the text: zsh refuses a line with more than one, so the others are inert.
 */
function emulateScript(args: WordToken[], budget: UnsureBudget): Inline | null {
  const at = args.findIndex((w) => w.dynamic || EMULATE_C.test(w.value));
  if (at < 0) return null;
  const words = args.slice(at).filter((w) => w.dynamic || !EMULATE_FLAG.test(w.value));
  return { texts: [...new Set(words.flatMap((w) => splicedReadings([w], budget)))], wrap: "eval" };
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

/** Whether a shell's options include `-c`, and its first operand: the `-c` string, or else a script file. */
export function shellOperands(args: WordToken[]): { hasC: boolean; positional: WordToken | null } {
  let hasC = false;
  for (let i = 0; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (v === "-") break;
    if (v === "--") return { hasC, positional: args[i + 1] ?? null };
    if (SHELL_VALUE_OPTS.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (/^[-+][A-Za-z]+$/.test(v)) hasC ||= v.startsWith("-") && v.includes("c");
    else return { hasC, positional: args[i] as WordToken };
  }
  return { hasC, positional: null };
}
