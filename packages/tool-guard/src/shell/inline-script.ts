import { caseScripts } from "./case-script.js";
import { pipedShellTexts } from "./piped-nul.js";
import { SPLICING_SHELLS, splicedWords, stdinScript } from "./sub-output.js";
import type { RedirectToken, WordToken } from "./tokens.js";
import { chargeSpliced } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/** Shells whose `-c` string, heredoc, here-string or piped input the walk reads as script. */
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/** Shell text a command runs, and how it reaches the commands in it. */
export interface Inline {
  texts: string[];
  wrap: "sh-c" | "eval" | "heredoc-shell" | "piped-shell";
}

/**
 * The script a shell or `eval` runs: a `-c` string, else a heredoc, here-string or literal pipe on stdin. Eval and `-c`
 * text is read with and without what its substitutions print, when that is literal on the line.
 */
export function inlineScript(cmd: Unwrapped, redirects: RedirectToken[], stdin: string | null, budget: UnsureBudget): Inline | null {
  if (cmd.script !== undefined) return { texts: [cmd.script], wrap: "sh-c" };
  if (cmd.name === "eval") return { texts: splicedReadings(cmd.args, budget), wrap: "eval" };
  if (cmd.name === null || !SHELLS.has(cmd.name)) return null;
  const { hasC, positional } = shellOperands(cmd.args);
  // A bare `-c` takes the pipe too: `xargs sh -c` turns the piped text into the string.
  const text = hasC ? (positional ? splicedReadings([positional], budget) : stdin) : positional ? null : stdinScript(redirects);
  if (text !== null) return { texts: hasC ? [text].flat() : [text].flat().flatMap((t) => pipedShellTexts(cmd.name, t)), wrap: hasC ? "sh-c" : "heredoc-shell" };
  return hasC || positional || stdin === null ? null : { texts: pipedShellTexts(cmd.name, stdin), wrap: "piped-shell" };
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
  for (let i = 0, word = args[0]; word; word = args[++i]) {
    const v = word.value;
    if (v === "-") break;
    if (v === "--") return { hasC, positional: args[i + 1] ?? null };
    if (SHELL_VALUE_OPTS.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (/^[-+][A-Za-z]+$/.test(v)) hasC ||= v.startsWith("-") && v.includes("c");
    else return { hasC, positional: word };
  }
  return { hasC, positional: null };
}
