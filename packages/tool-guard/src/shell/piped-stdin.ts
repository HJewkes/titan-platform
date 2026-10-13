import type { RedirectToken } from "./lexer.js";
import { printedReadings, printedText } from "./printed.js";
import { catOperands, SPLICING_SHELLS, stdinScript } from "./sub-output.js";
import type { Unwrapped } from "./unwrap.js";

/** Text piped into the next command: printed by this one, passed on by `tee` or `cat`, or kept across a bare `(`. */
export function nextStdin(op: string, cmd: Unwrapped | null, empty: boolean, stdin: string | null): string | null {
  if (op === "(" && empty) return stdin;
  if (!cmd || (op !== "|" && op !== "|&")) return null;
  return printedText(cmd.name, cmd.args) ?? (passesThrough(cmd) ? stdin : null);
}

/** Each splicing shell's text of a print piped on, so a push only bash or zsh prints still reaches the shell it feeds. */
export function nextShellStdin(op: string, cmd: Unwrapped | null, empty: boolean, shellStdin: string[]): string[] {
  if (op === "(" && empty) return shellStdin;
  if (!cmd || (op !== "|" && op !== "|&")) return [];
  return printedReadings(cmd.name, cmd.args, SPLICING_SHELLS).slice(1);
}

function passesThrough(cmd: Unwrapped): boolean {
  if (cmd.name === "tee") return true;
  if (cmd.name !== "cat") return false;
  const operands = catOperands(cmd.args.map((a) => a.value));
  return operands.length === 0 || operands.includes("-");
}

/** A stdin redirect replaces the pipe; a file or descriptor it names has unknown text. */
export function xargsStdin(redirects: RedirectToken[], piped: string | null): string | null {
  const feeds = redirects.some((r) => (r.fd === null || r.fd === "0") && ["<", "<<", "<<-", "<<<", "<&"].includes(r.op));
  return feeds ? stdinScript(redirects) : piped;
}
