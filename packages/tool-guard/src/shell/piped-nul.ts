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

const bareWord = (value: string): WordToken => ({ type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] });

const cutAssigned = (assigned: Unwrapped["assigned"]): Unwrapped["assigned"] =>
  assigned.map(([name, value, ...rest]) => [name, cutText(value), ...rest] as Unwrapped["assigned"][number]);

/**
 * A command word that a NUL cuts short names a different program once cut: `env\0x git push` runs `env`,
 * which then runs git, and `git\0$(x)` runs `git`. The cut words are unwrapped again like any command.
 */
function renamedAfterCut(cmd: Unwrapped): Unwrapped | null {
  const word = cmd.name === null ? cmd.args[0] : cmd.path === null ? undefined : bareWord(cmd.path);
  if (!word?.value.includes("\0")) return null;
  const rest = cmd.name === null ? cmd.args.slice(1) : cmd.args;
  const named = unwrap([cutWord(word), ...rest.map(cutWord)]);
  return named && { ...named, assigned: [...cutAssigned(cmd.assigned), ...named.assigned] };
}

/** What an external program is handed: its name, arguments and environment end at the first NUL, as in exec. */
export function execView(cmd: Unwrapped): Unwrapped {
  if (cmd.name !== null && BUILTINS.has(cmd.name)) return cmd;
  const renamed = renamedAfterCut(cmd);
  if (renamed) return renamed;
  const cut = { ...cmd, name: cutText(cmd.name), path: cutText(cmd.path), args: cmd.args.map(cutWord), assigned: cutAssigned(cmd.assigned) };
  return cmd.xargs ? { ...cut, xargs: { ...cmd.xargs, words: cmd.xargs.words.map(cutWord) } } : cut;
}
