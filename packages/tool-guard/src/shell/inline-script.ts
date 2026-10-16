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
const STDIN_PATH_RE = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;

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
  if (cmd.name === null || !SHELLS.has(cmd.name)) return null;
  const { hasC, positional: operand } = shellOperands(cmd.args, cmd.name);
  // `bash /dev/stdin <<< TEXT` runs its stdin as a script file.
  const positional = !hasC && operand !== null && STDIN_PATH_RE.test(operand.value) ? null : operand;
  // A bare `-c` takes the pipe too: `xargs sh -c` turns the piped text into the string.
  const text = hasC ? (positional ? splicedReadings([positional], budget) : piped.length > 0 ? piped : null) : positional ? null : stdinScript(redirects);
  if (text !== null) return { texts: hasC ? [text].flat() : [text].flat().flatMap((t) => pipedShellTexts(cmd.name, t)), wrap: hasC ? "sh-c" : "heredoc-shell" };
  return hasC || positional || piped.length === 0 ? null : { texts: piped.flatMap((t) => pipedShellTexts(cmd.name, t)), wrap: "piped-shell" };
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
