import { caseNamed } from "./case-script.js";
import { inlineScript, SHELLS, shellOperands } from "./inline-script.js";
import { cutReading } from "./piped-nul.js";
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

/** The script texts a token list runs, and whether one of them is only known at run time. */
export interface Scripts {
  texts: string[];
  runTime: boolean;
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
    runTime: runs.some(({ cmds }) => cmds.some(runsRunTimeScript)),
  };
}

/** The tokens and every token list nested in their command and process substitutions. */
export function tokenLists(tokens: readonly Token[]): Token[][] {
  const nested = tokens.flatMap((t): Token[][] => {
    if (t.type === "word" || t.type === "subs") return t.subs;
    if (t.type === "redirect") return [...t.subs, ...(t.target?.subs ?? [])];
    return [];
  });
  return [[...tokens], ...nested.flatMap(tokenLists)];
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
  const stdin = piped ? before.flatMap(stageTexts).join("\n") : null;
  const inline = inlineScript(cmd, redirects, stdin, budget)?.texts ?? [];
  if (cmd.name === "trap") return [...inline, ...cmd.args.filter((a) => a.value !== "--").slice(0, 1).map((a) => a.value)];
  if (cmd.name === "alias") return [...inline, ...cmd.args.flatMap((a) => (a.value.includes("=") ? [a.value.slice(a.value.indexOf("=") + 1)] : []))];
  return inline;
}

function runsRunTimeScript(cmd: Unwrapped): boolean {
  if (cmd.name === null || !SHELLS.has(cmd.name)) return false;
  const { hasC, positional } = shellOperands(cmd.args);
  return hasC && positional !== null && (positional.dynamic || positional.computed);
}

function stageTexts({ words, redirects }: Stage): string[] {
  return [...words.map((w) => w.value), ...redirects.flatMap((r) => [r.body, r.target?.value].filter((v): v is string => v != null))];
}
