import { caseScripts } from "./case-script.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { pipedShellTexts } from "./piped-nul.js";
import { shellOperands, shellStdin } from "./shell-options.js";
import type { StdinSource } from "./shell-options.js";
import { SPLICING_SHELLS, splicedWords } from "./sub-output.js";
import { chargeSpliced } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import type { Wrapping } from "./commands.js";
import type { Unwrapped } from "./unwrap.js";

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

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
  const operands = shellOperands(cmd.args, cmd.name);
  const { hasC, positional } = operands;
  const { runs, sources } = shellStdin(operands, redirects, piped.length > 0);
  const stdin = runs ? stdinReading(cmd.name, sources, piped) : null;
  if (!hasC) return stdin;
  // A bare `-c` takes the pipe too: `xargs sh -c` turns the piped text into the string.
  const texts = positional ? splicedReadings([positional], budget) : piped;
  const all = [...texts, ...(stdin?.texts ?? [])];
  return all.length > 0 ? { texts: all, wrap: "sh-c" } : null;
}

/** Heredoc, here-string and piped text on the descriptor the shell runs; a `<` file is the script target `scripts.ts` reads. */
function stdinReading(shell: string | null, sources: StdinSource[], piped: string[]): Inline | null {
  const texts = sources.flatMap((s) => (s.kind === "text" ? [s.text] : s.kind === "pipe" ? piped : []));
  if (texts.length === 0) return null;
  return { texts: texts.flatMap((t) => pipedShellTexts(shell, t)), wrap: sources.some((s) => s.kind === "text") ? "heredoc-shell" : "piped-shell" };
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
