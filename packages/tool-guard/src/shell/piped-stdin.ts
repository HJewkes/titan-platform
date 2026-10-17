import type { RedirectToken } from "./lexer.js";
import { printedReadings, printedText } from "./printed.js";
import { catOperands, knownSplice, SPLICING_SHELLS, stdinScript } from "./sub-output.js";
import type { Unwrapped } from "./unwrap.js";

/** Text piped into the next command: printed by this one, passed on by `tee` or `cat`, or kept across a bare `(`. */
export function nextStdin(op: string, cmd: Unwrapped | null, empty: boolean, stdin: string | null): string | null {
  if (op === "(" && empty) return stdin;
  if (!cmd || (op !== "|" && op !== "|&")) return null;
  return printedText(cmd.name, cmd.args) ?? (passesThrough(cmd) ? stdin : (splicedReadings(cmd)[0] ?? null));
}

/**
 * The other texts piped on beside `nextStdin`'s: each splicing shell's text of a print, so a push only bash or zsh prints
 * still reaches the shell it feeds, or what `tee` or `cat` passes on of the texts piped into it.
 */
export function nextShellStdin(op: string, cmd: Unwrapped | null, empty: boolean, shellStdin: string[]): string[] {
  if (op === "(" && empty) return shellStdin;
  if (!cmd || (op !== "|" && op !== "|&")) return [];
  if (printedText(cmd.name, cmd.args) === null && passesThrough(cmd)) return shellStdin;
  const printed = printedReadings(cmd.name, cmd.args, SPLICING_SHELLS).slice(1);
  return printed.length > 0 ? printed : splicedReadings(cmd).slice(1);
}

/**
 * Each splicing shell's distinct text of a print whose arguments are command substitutions of known output under every one of them; the first is
 * piped as the command's own text and the rest beside it (TP-3333).
 */
function splicedReadings(cmd: Unwrapped): string[] {
  if (!cmd.args.some((arg) => arg.cuts)) return [];
  const texts = SPLICING_SHELLS.map((shell) => {
    const args = knownSplice(cmd.args, shell);
    return args && printedText(cmd.name, args, shell);
  });
  // The line runs under one shell, so a text only some of them know may be a shell the line does not run under.
  const known = texts.filter((text) => typeof text === "string");
  return known.length < texts.length ? [] : [...new Set(known)];
}

function passesThrough(cmd: Unwrapped): boolean {
  if (cmd.name === "tee") return true;
  if (cmd.name !== "cat") return false;
  const operands = catOperands(cmd.args.map((a) => a.value));
  return operands.length === 0 || operands.includes("-");
}

/** Each text xargs may read: every one piped in, or what a stdin redirect replaces the pipe with; a file or descriptor it names has unknown text. */
export function xargsStdins(redirects: RedirectToken[], piped: string | null, shellStdin: string[]): Array<string | null> {
  const feeds = redirects.some((r) => (r.fd === null || r.fd === "0") && ["<", "<<", "<<-", "<<<", "<&"].includes(r.op));
  return feeds ? [stdinScript(redirects)] : [piped, ...shellStdin];
}
