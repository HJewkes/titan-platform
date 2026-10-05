import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";

/** zsh builtins hand their words on whole: a NUL stays in `eval` text, an assignment or printed output. */
const BUILTINS = new Set([
  ...["eval", "echo", "print", "printf", "cd", "pushd", "popd", "export", "declare", "typeset", "local"],
  ...["readonly", "set", "unset", "read", "source", ".", "alias", "test", "[", "let", "return", "exit", "shift", "trap"],
]);

/**
 * The readings of text a shell reads on stdin: a pipe, here-string or heredoc. bash, sh and dash drop
 * NUL (TP-1460). zsh keeps it in the stream (TP-1464) and ksh is not certain, so both also get the raw
 * text; its NUL is cut by `execView` where a word reaches an external program.
 */
export function pipedShellTexts(shell: string | null, stdin: string): string[] {
  if (!stdin.includes("\0")) return [stdin];
  const dropped = stdin.replaceAll("\0", "");
  return shell === "zsh" || shell === "ksh" ? [dropped, stdin] : [dropped];
}

function cutWord(word: WordToken): WordToken {
  const at = word.value.indexOf("\0");
  if (at === -1) return word;
  const refs = word.refs.filter((ref) => ref.start < at);
  const cut: WordToken = { ...word, value: word.value.slice(0, at), refs };
  if (word.typed !== undefined) cut.typed = word.typed.split("\0")[0] as string;
  if (refs.length > 0) return cut;
  delete cut.unquotedExpansion;
  return { ...cut, dynamic: false, computed: false };
}

const cutText = (text: string | null): string | null => (text === null ? null : (text.split("\0")[0] as string));

/** A dynamic command word that a NUL cuts short names a fixed program once the cut is made: `git\0$(x)` runs `git`. */
function namedAfterCut(cmd: Unwrapped): Unwrapped | null {
  if (cmd.name !== null || cmd.xargs || !cmd.args[0]?.value.includes("\0")) return null;
  const named = unwrap(cmd.args.map(cutWord));
  return named && { ...named, assigned: [...cmd.assigned, ...named.assigned] };
}

/** What an external program is handed: its name, arguments and environment end at the first NUL, as in exec. */
export function execView(cmd: Unwrapped): Unwrapped {
  const named = namedAfterCut(cmd);
  if (named) return execView(named);
  if (cmd.name !== null && BUILTINS.has(cmd.name)) return cmd;
  const assigned = cmd.assigned.map(([name, value, ...rest]) => [name, cutText(value), ...rest] as Unwrapped["assigned"][number]);
  return { ...cmd, name: cutText(cmd.name), path: cutText(cmd.path), args: cmd.args.map(cutWord), assigned };
}
