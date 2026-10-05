import type { WordToken } from "./lexer.js";
import { ASSIGNMENT_RE } from "./vars.js";

/** zsh builtins hand their words on whole: a NUL stays in `eval` text, an assignment or printed output. */
const BUILTINS = new Set([
  ...["eval", "echo", "print", "printf", "cd", "pushd", "popd", "export", "declare", "typeset", "local"],
  ...["readonly", "set", "unset", "read", "source", ".", "alias", "test", "[", "let", "return", "exit", "shift", "trap"],
]);

/**
 * The readings of text a shell reads on stdin: a pipe, here-string or heredoc. bash, sh and dash drop
 * NUL (TP-1460). zsh keeps it in the stream (TP-1464) and ksh is not certain, so both also get the raw
 * text; its NUL is cut by `cutReading` where a command's words reach an external program.
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

/**
 * The words of a command as an external program gets them: a wrapper reads its options from the cut
 * words, so a NUL in one can change which word is the command (`env -u\0x FOO git push`). Null when no
 * word holds a NUL or a builtin runs, which keeps its NUL. It is read alongside the uncut words.
 */
export function cutReading(words: WordToken[]): WordToken[] | null {
  if (!words.some((word) => word.value.includes("\0"))) return null;
  const command = words.find((word) => !ASSIGNMENT_RE.test(word.value));
  if (!command || BUILTINS.has(cutWord(command).value)) return null;
  return words.map(cutWord);
}
