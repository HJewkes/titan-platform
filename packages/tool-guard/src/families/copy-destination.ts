import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";

/** Options that consume the next word, per copier, so a value is never mistaken for an operand. */
const VALUE_OPTS: Record<string, Set<string>> = {
  cp: new Set(["-t", "-S"]),
  install: new Set(["-t", "-m", "-o", "-g", "-S"]),
  ln: new Set(["-t", "-S"]),
  mv: new Set(["-t", "-S"]),
  rsync: new Set(["-e", "--exclude", "--include", "--exclude-from", "--include-from", "--filter", "-f"]),
};

/** The destination operand of a copier: the `-t` directory, else the last operand. Null for any other command. */
export function copyDestination(cmd: SimpleCommand): WordToken | null {
  const valueOpts = Object.hasOwn(VALUE_OPTS, cmd.name ?? "") ? VALUE_OPTS[cmd.name ?? ""] : undefined;
  if (!valueOpts) return null;
  const operands: WordToken[] = [];
  for (let i = 0; i < cmd.args.length; i++) {
    const word = cmd.args[i] as WordToken;
    if (word.value === "-t") return cmd.args[i + 1] ?? null;
    if (word.value.startsWith("--target-directory=")) return word;
    if (valueOpts.has(word.value)) i++;
    else if (!word.value.startsWith("-")) operands.push(word);
  }
  return operands.length >= 2 ? (operands.at(-1) ?? null) : null;
}
