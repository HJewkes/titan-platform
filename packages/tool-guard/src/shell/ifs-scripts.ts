import { caseNamed } from "./case-script.js";
import { inlineScript, SHELLS } from "./inline-script.js";
import { shellOperands, shellStdin } from "./shell-options.js";
import { cutReading } from "./piped-nul.js";
import { STARTUP_OPTION_RE, STARTUP_VAR_RE } from "./startup-file.js";
import type { RedirectToken, Token, WordToken } from "./tokens.js";
import { MAX_UNSURE_WORDS, SPLICED_WEIGHT, unsureReadings } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import { findExecs, type Unwrapped } from "./unwrap.js";

/** One simple command's words and redirects, and whether a pipe feeds its stdin. */
interface Stage {
  words: WordToken[];
  redirects: RedirectToken[];
  piped: boolean;
}

/**
 * The script texts a token list runs, whether one of them is only known at run time, and whether the list starts
 * a shell at all, which then sources any startup file the line selects.
 */
export interface Scripts {
  texts: string[];
  runTime: boolean;
  startsShell: boolean;
}

/**
 * The scripts the walk runs from these tokens, through its own `inlineScript` over the same readings it takes:
 * each case-folded and NUL-cut reading, each unsure-word reading, and each `find -exec` command. Piped text is
 * every word and heredoc before the shell, a superset of what the walk models as printed or passed through. A
 * trap's action and alias values run as code too. A shell's run-time `-c` string, like eval's, is `runTime`.
 * Spliced text is charged against the source's length as the walk charges it, and past that it throws as there.
 */
export function scriptsOf(tokens: readonly Token[], srcLength: number): Scripts {
  const all = stages(tokens);
  const budget: UnsureBudget = { left: MAX_UNSURE_WORDS, splicedLeft: SPLICED_WEIGHT * srcLength, decides: () => true, stopPastCap: true };
  const runs = all.map((stage, i) => ({ stage, cmds: commandsRun(stage.words, budget), before: all.slice(0, i) }));
  return {
    texts: runs.flatMap(({ stage, cmds, before }) => cmds.flatMap((cmd) => commandScripts(cmd, stage, before, budget))),
    runTime: runs.some(({ stage, cmds }) => cmds.some((cmd) => runsRunTimeScript(cmd, stage.redirects))),
    startsShell: runs.some(({ cmds }) => cmds.some(isShell)),
  };
}

function stages(tokens: readonly Token[]): Stage[] {
  const out: Stage[] = [];
  let stage: Stage = { words: [], redirects: [], piped: false };
  for (const t of tokens) {
    if (t.type === "word") stage.words.push(t);
    else if (t.type === "redirect") stage.redirects.push(t);
    else if (t.type === "op") {
      out.push(stage);
      stage = { words: [], redirects: [], piped: t.value === "|" || t.value === "|&" };
    }
  }
  out.push(stage);
  return out;
}

/** The commands the words run as the walk reaches them, and every `find -exec` command under each. */
function commandsRun(words: WordToken[], budget: UnsureBudget): Unwrapped[] {
  const runs = caseNamed(words);
  const cut = cutReading(words);
  const all = [...runs, ...(cut ? caseNamed(cut) : []), ...unsureReadings(runs[0], budget).flat()];
  return all.flatMap((cmd) => [cmd, ...(cmd.name === "find" ? findExecs(cmd.args).flatMap((exec) => commandsRun(exec, budget)) : [])]);
}

function commandScripts(cmd: Unwrapped, { redirects, piped }: Stage, before: Stage[], budget: UnsureBudget): string[] {
  const stdin = piped ? [before.flatMap(stageTexts).join("\n")] : [];
  const inline = inlineScript(cmd, redirects, stdin, budget)?.texts ?? [];
  if (cmd.name === "trap") return [...inline, ...cmd.args.filter((a) => a.value !== "--").slice(0, 1).map((a) => a.value)];
  if (cmd.name === "alias") return [...inline, ...cmd.args.flatMap((a) => (a.value.includes("=") ? [a.value.slice(a.value.indexOf("=") + 1)] : []))];
  return inline;
}

/**
 * A shell whose `-c` string is only known at run time, that runs a descriptor the line cannot show, or that sources a
 * startup file: one its options select, or one a prefix assignment names. Each runs text this model never reads, in
 * the shell that runs the script.
 */
function runsRunTimeScript(cmd: Unwrapped, redirects: RedirectToken[]): boolean {
  if (!isShell(cmd)) return false;
  if (cmd.assigned.some(([name]) => STARTUP_VAR_RE.test(`${name}=`))) return true;
  const operands = shellOperands(cmd.args, cmd.name);
  if (shellStdin(operands, redirects, false).unknowable) return true;
  const { hasC, positional } = operands;
  const options = positional ? cmd.args.slice(0, cmd.args.indexOf(positional)) : cmd.args;
  if (options.some((a) => STARTUP_OPTION_RE.test(a.value))) return true;
  return hasC && positional !== null && (positional.dynamic || positional.computed);
}

function isShell(cmd: Unwrapped): boolean {
  return cmd.name !== null && SHELLS.has(cmd.name);
}

function stageTexts({ words, redirects }: Stage): string[] {
  return [...words.map((w) => w.value), ...redirects.flatMap((r) => [r.body, r.target?.value].filter((v): v is string => v != null))];
}
