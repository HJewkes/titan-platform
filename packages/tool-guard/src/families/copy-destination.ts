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
    if (targetable && endsInTarget(word.value)) return cmd.args[i + 1] ?? null;
    if (valueOpts.has(word.value) || consumesNext(word.value, valueOpts)) i++;
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

/** A short-flag cluster whose last flag is `t`, such as `-t`, `-rt` or `-at`; its directory is the next word. */
function endsInTarget(value: string): boolean {
  return /^-[A-Za-z]*t$/.test(value) && !value.startsWith("--");
}

/** A glued short cluster such as `-ae` whose final flag takes a value from the next word. */
function consumesNext(value: string, valueOpts: Set<string>): boolean {
  if (!/^-[A-Za-z]{2,}$/.test(value)) return false;
  return valueOpts.has(`-${value.at(-1)}`);
}
