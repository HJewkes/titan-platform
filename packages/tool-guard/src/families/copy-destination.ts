import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";

/** Options that consume the next word, per copier, so a value is never mistaken for an operand. */
const VALUE_OPTS: Record<string, Set<string>> = {
  cp: new Set(["-S"]),
  install: new Set(["-m", "-o", "-g", "-S"]),
  ln: new Set(["-S"]),
  mv: new Set(["-S"]),
  rsync: new Set(["-e", "--rsh", "--exclude", "--include", "--exclude-from", "--include-from", "--filter", "-f"]),
};
/** `-t` names a target directory for these; for rsync it means preserve times. */
const TARGET_DIRECTORY = new Set(["cp", "install", "ln", "mv"]);
const LONG_TARGET = "--target-directory";

/** The destination operand of a copier: the target directory when named, else the last operand. Null when none is certain, so every operand counts as a source. */
export function copyDestination(cmd: SimpleCommand): WordToken | null {
  const name = cmd.name ?? "";
  if (!Object.hasOwn(VALUE_OPTS, name)) return null;
  const valueOpts = VALUE_OPTS[name] as Set<string>;
  const targetable = TARGET_DIRECTORY.has(name);
  const operands: WordToken[] = [];
  for (let i = 0; i < cmd.args.length; i++) {
    const word = cmd.args[i] as WordToken;
    if (word.value === "--") {
      operands.push(...cmd.args.slice(i + 1));
      break;
    }
    if (targetable && isLongTarget(word.value)) return word.value.includes("=") ? word : (cmd.args[i + 1] ?? null);
    const flag = valueFlag(word.value, valueOpts, targetable);
    if (flag?.target) return flag.rest ? { ...word, value: flag.rest } : (cmd.args[i + 1] ?? null);
    if (flag) i += flag.rest ? 0 : 1;
    else if (valueOpts.has(word.value)) i++;
    else if (!word.value.startsWith("-")) operands.push(word);
  }
  return operands.length >= 2 ? (operands.at(-1) ?? null) : null;
}

/** `--target-directory`, `--target=DIR` and any GNU abbreviation down to `--t`. */
function isLongTarget(value: string): boolean {
  if (!value.startsWith("--")) return false;
  const name = value.split("=")[0] as string;
  return name.length >= 3 && LONG_TARGET.startsWith(name);
}

/** Walks a short-flag cluster letter by letter: the first value-taking letter (`t` or one of the copier's) owns the rest of the word, or the next word when nothing follows. */
function valueFlag(value: string, valueOpts: Set<string>, targetable: boolean): { target: boolean; rest: string } | null {
  if (!/^-[A-Za-z]+/.test(value)) return null;
  for (let j = 1; j < value.length; j++) {
    const letter = value[j] as string;
    const target = targetable && letter === "t";
    if (target || valueOpts.has(`-${letter}`)) return { target, rest: value.slice(j + 1) };
  }
  return null;
}
