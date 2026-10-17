import { SOURCERS } from "./scripts.js";
import { SHELLS } from "./mentions.js";
import type { SimpleCommand } from "./shell/commands.js";
import type { RedirectToken, WordToken } from "./shell/lexer.js";
import { shellOperands } from "./shell/shell-options.js";
import { UnknownStdinError } from "./shell/unsure-readings.js";

/** The tail after `/dev/fd/` or `/proc/<pid>/fd/`; anything but digits is an fd the line only names at run time. */
const FD_DIR_RE = /\/(?:dev|proc\/[^/]+)\/fd\/(.*)$/;
const STDIN_PATH_RE = /\/dev\/stdin$/;
const INPUT_OPS = new Set(["<", "<>", "<&"]);
/** fds 0 to 2 are the shell's own; a script fd from 3 up is one the line opened. */
const FIRST_OPENED_FD = 3;

/**
 * An fd a line opens for reading and leaves open (`exec {fd}< f`, `exec 3< f`, `exec < f`, a `{name}` redirect on a
 * builtin, function or group) is not held by the descriptor view the shell options keep, which only knows what each fd
 * held before a command's own redirects. So the line is scanned as a whole, in either order, since a loop's trailing
 * redirect is walked after its body and a body reruns: once any command reads-opens an fd, a shell or `source` whose
 * script operand may name one fails closed. A swapped stdin counts only for shells walked after it, because a group's
 * trailing `< f` (`{ bash; } < f`, whose redirect group-stdin.ts already reads) looks the same as `exec < f`.
 */
export function refuseFdScripts(commands: readonly SimpleCommand[]): void {
  const opened = commands.some((cmd) => !cmd.added && opensFd(cmd));
  let swapped = false;
  for (const cmd of commands) {
    const operand = scriptOperand(cmd);
    if (operand !== null && mayNameOpenedFd(operand, opened, swapped)) throw new UnknownStdinError();
    if (swapped && readsOwnStdin(cmd)) throw new UnknownStdinError();
    swapped ||= !cmd.added && swapsStdin(cmd);
  }
}

/** The word a shell or `source` takes as its script file: not a `-c` string, whose operands are positional parameters. */
function scriptOperand(cmd: SimpleCommand): WordToken | null {
  if (cmd.name === null) return null;
  if (SOURCERS.has(cmd.name)) return cmd.args[0] ?? null;
  if (!SHELLS.has(cmd.name)) return null;
  const { hasC, positional } = shellOperands(cmd.args, cmd.name);
  return hasC ? null : positional;
}

function mayNameOpenedFd(operand: WordToken, opened: boolean, swapped: boolean): boolean {
  const tail = FD_DIR_RE.exec(operand.value)?.[1];
  if (tail !== undefined && !/^\d+$/.test(tail)) return true;
  if (opened && (operand.dynamic || operand.computed)) return true;
  if (tail !== undefined) return Number(tail) >= FIRST_OPENED_FD ? opened : swapped && Number(tail) === 0;
  return swapped && STDIN_PATH_RE.test(operand.value);
}

/** `exec 3< f` or `exec {fd}< f` (the walker drops `exec`, so both read as a nameless command), or any command's `{name}` redirect. */
function opensFd(cmd: SimpleCommand): boolean {
  return cmd.redirects.some((r) => readsFile(r) && (r.named !== undefined || (cmd.name === null && Number(r.fd) >= FIRST_OPENED_FD)));
}

/** `exec < f`, `exec 0< f` or `exec <&3`: what a later shell reads on stdin is then not the line's own. */
function swapsStdin(cmd: SimpleCommand): boolean {
  return cmd.name === null && cmd.redirects.some((r) => readsFile(r) && (r.fd === null || r.fd === "0"));
}

function readsFile(r: RedirectToken): boolean {
  return INPUT_OPS.has(r.op) && r.target?.value !== "-";
}

/** A shell that reads its script from stdin, which neither a pipe into it nor a redirect of its own supplies. */
function readsOwnStdin(cmd: SimpleCommand): boolean {
  if (cmd.name === null || !SHELLS.has(cmd.name) || cmd.prev === "|" || cmd.prev === "|&") return false;
  if (cmd.redirects.some((r) => (r.fd === null || r.fd === "0") && (INPUT_OPS.has(r.op) || r.op === "<<" || r.op === "<<-" || r.op === "<<<"))) return false;
  const { hasC, readsStdin } = shellOperands(cmd.args, cmd.name);
  return readsStdin && !hasC;
}
