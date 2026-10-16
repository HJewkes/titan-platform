import type { WordToken } from "./lexer.js";

/** Long options that take the next word. */
const BASH_LONG_VALUES = new Set(["--rcfile", "--init-file"]);

interface ShellOperands {
  hasC: boolean;
  /** The `-c` string, or else a script file; null when there is none, or `-s` makes the operands positional parameters. */
  positional: WordToken | null;
  /** Whether the shell runs its stdin: with no script file, under `-s`, and in dash after the `-c` string too. */
  readsStdin: boolean;
}

/** What one lexer pass finds: `s` is the sign of the last `s` letter, `anyS` whether any was seen. */
interface Lexed {
  hasC: boolean;
  operand: WordToken | null;
  s: "-" | "+" | null;
  anyS: boolean;
}

/**
 * One word of zsh's option lexer, which zsh's startup and its `emulate` builtin share. Digits are letters (`-0`,
 * `-c1`). `o` ends the letters and names an option with the rest of the word, or else with the next word. A lone `-`
 * or `+`, a trailing `-`, and `b` unless SH_OPTION_LETTERS is set end the options after this word.
 */
interface ZshOptionWord {
  letters: string;
  /** The option `o` names from the rest of the word; null when `o` takes the next word, or there is no `o`. */
  optionName: string | null;
  takesNext: boolean;
  endsOptions: boolean;
}

/** How zsh lexes `word`, or null when it is not a short-option word (no sign, or a `--name` long option). */
export function zshOptionWord(word: string, shLetters: boolean): ZshOptionWord | null {
  if (!/^[-+]/.test(word) || /^[-+]-./.test(word)) return null;
  const body = word.slice(1);
  const o = body.indexOf("o");
  const letters = o < 0 ? body : body.slice(0, o);
  const optionName = o < 0 || o === body.length - 1 ? null : body.slice(o + 1);
  const endsOptions = body === "" || letters.includes("-") || (!shLetters && letters.includes("b"));
  return { letters, optionName, takesNext: o >= 0 && optionName === null, endsOptions };
}

/**
 * Whether a shell's options include `-c`, its first operand, and whether it runs its stdin, as bash 5, zsh 5.9 and
 * dash read them. `+c` is `-c` in all three. `sh` and `ksh` may be either bash or dash, so both readings are joined.
 */
export function shellOperands(args: WordToken[], shell: string | null): ShellOperands {
  if (shell === "zsh") return reading(lexZsh(args), "zsh");
  const lexed = lexPosix(args);
  if (shell === "bash" || shell === "dash") return reading(lexed, shell);
  const [bash, dash] = [reading(lexed, "bash"), reading(lexed, "dash")];
  return { hasC: lexed.hasC, positional: bash.positional ?? dash.positional, readsStdin: bash.readsStdin || dash.readsStdin };
}

/** bash's `s` holds under either sign; zsh's and dash's last one wins, and dash runs stdin after a `-c` string under it. */
function reading({ hasC, operand, s, anyS }: Lexed, shell: "bash" | "dash" | "zsh"): ShellOperands {
  const fromStdin = shell === "bash" ? anyS : s === "-";
  if (hasC) return { hasC, positional: operand, readsStdin: shell === "dash" && fromStdin };
  const positional = fromStdin ? null : operand;
  return { hasC, positional, readsStdin: positional === null };
}

/** bash and dash: `-` and `--` end the options, a lone `+` is an empty cluster, and each `o`, and bash's each `O`, takes the next word. */
function lexPosix(args: WordToken[]): Lexed {
  const lexed: Lexed = { hasC: false, operand: null, s: null, anyS: false };
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value ?? "";
    if (v === "-" || v === "--") return { ...lexed, operand: args[i + 1] ?? null };
    if (BASH_LONG_VALUES.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (/^[-+]/.test(v)) {
      for (const letter of v.slice(1)) i += letterInto(lexed, letter, v[0]) ? 1 : 0;
    } else return { ...lexed, operand: args[i] ?? null };
  }
  return lexed;
}

/** Records `letter` and says whether it takes the next word. */
function letterInto(lexed: Lexed, letter: string, sign: string | undefined): boolean {
  if (letter === "c") lexed.hasC = true;
  if (letter === "s") [lexed.s, lexed.anyS] = [sign === "+" ? "+" : "-", true];
  return letter === "o" || letter === "O";
}

/** zsh: `--emulate` takes the next word; a `-o` or long option may set SH_OPTION_LETTERS, which keeps `b` a letter. */
function lexZsh(args: WordToken[]): Lexed {
  const lexed: Lexed = { hasC: false, operand: null, s: null, anyS: false };
  let shLetters = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value ?? "";
    const word = zshOptionWord(v, shLetters);
    if (word === null && /^[-+]-./.test(v)) {
      if (v.slice(2) === "emulate") i++;
      else shLetters = setsShLetters(v.slice(2), v[0] === "-") ?? shLetters;
      continue;
    }
    if (word === null) return { ...lexed, operand: args[i] ?? null };
    for (const letter of word.letters) letterInto(lexed, letter, v[0]);
    const name = word.takesNext ? (args[++i]?.value ?? "") : word.optionName;
    if (name !== null) shLetters = setsShLetters(name, v[0] === "-") ?? shLetters;
    if (word.endsOptions) return { ...lexed, operand: args[i + 1] ?? null };
  }
  return lexed;
}

/** What naming option `name` under sign `on` does to SH_OPTION_LETTERS: zsh ignores case and `_`, and `no` negates. */
function setsShLetters(name: string, on: boolean): boolean | null {
  const plain = name.toLowerCase().replaceAll(/[-_]/g, "");
  if (plain === "shoptionletters") return on;
  return plain === "noshoptionletters" ? !on : null;
}
