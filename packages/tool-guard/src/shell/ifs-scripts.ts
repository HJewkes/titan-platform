import { SHELLS, shellOperands } from "./shell-operands.js";
import { stdinScript } from "./sub-output.js";
import type { RedirectToken, Token, WordToken } from "./tokens.js";
import { unwrap } from "./unwrap.js";

/** One simple command's words and redirects, and whether a pipe feeds its stdin. */
interface Stage {
  words: WordToken[];
  redirects: RedirectToken[];
  piped: boolean;
}

/**
 * Texts the walk runs as script, read from the same sources it uses: a wrapper's script option, eval's arguments
 * joined as eval joins them, a shell's `-c` string, heredoc or here-string, and text piped into a shell. Piped text
 * is every word and heredoc before the shell, a superset of what the walk models as printed or passed through.
 * A trap's action and alias values run as code too.
 */
export function codeTexts(tokens: readonly Token[]): string[] {
  const all = stages(tokens);
  return all.flatMap((stage, i) => stageScripts(stage, all.slice(0, i)));
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

function stageScripts({ words, redirects, piped }: Stage, before: Stage[]): string[] {
  const cmd = unwrap(words);
  if (!cmd) return [];
  if (cmd.script !== undefined) return [cmd.script];
  if (cmd.name === "eval") return [cmd.args.map((a) => a.value).join(" ")];
  if (cmd.name === "trap") return cmd.args.filter((a) => a.value !== "--").slice(0, 1).map((a) => a.value);
  if (cmd.name === "alias") return cmd.args.flatMap((a) => (a.value.includes("=") ? [a.value.slice(a.value.indexOf("=") + 1)] : []));
  if (cmd.name === null || !SHELLS.has(cmd.name)) return [];
  const { hasC, positional } = shellOperands(cmd.args);
  if (positional) return hasC ? [positional.value] : [];
  const fed = hasC ? null : stdinScript(redirects);
  if (fed !== null) return [fed];
  return piped ? before.flatMap(stageTexts) : [];
}

function stageTexts({ words, redirects }: Stage): string[] {
  return [...words.map((w) => w.value), ...redirects.flatMap((r) => [r.body, r.target?.value].filter((v): v is string => v != null))];
}
