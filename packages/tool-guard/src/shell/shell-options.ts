import type { RedirectToken, WordToken } from "./lexer.js";

/** Long options that take the next word. */
const BASH_LONG_VALUES = new Set(["--rcfile", "--init-file"]);
/** Paths that name a descriptor, matched on their tail: `/dev/stdin`, `/dev/fd/N`, `/proc/self/fd/N`. */
const NAMED_FDS: Record<string, number> = { stdin: 0, stdout: 1, stderr: 2 };
const FD_PATH_RE = /\/(?:dev\/(stdin|stdout|stderr)|(?:dev|proc\/(?:self|thread-self|\d+))\/fd\/(\d+))$/;
/** Ops that can put text on a descriptor; `>&` is a dup like `<&`, since dup2 has no direction (`0>&3` reads fd 3). */
const STDIN_OPS = new Set(["<", "<>", "<<", "<<-", "<<<", "<&", ">&"]);

/** One source on the descriptor a shell runs: heredoc, here-string or `< <(...)` text, a file `<` or `<>` opens, or the pipe. */
export type StdinSource = { kind: "text"; text: string } | { kind: "file"; target: WordToken } | { kind: "pipe" };

interface ShellStdin {
  /** Whether the shell runs a descriptor: stdin as `readsStdin` says, or one a script operand names or may name. */
  runs: boolean;
  /** The script file the shell runs that is not a descriptor; null with `-c`, under `-s`, or when the operand names one. */
  scriptFile: WordToken | null;
  /** Every source on that descriptor, or on stdin when it runs none, which a `-c` string may still read. */
  sources: StdinSource[];
  /** Whether the shell runs a descriptor whose text the line cannot show: a dup, an inherited fd, or a run-time file. */
  unknowable: boolean;
}

/** The redirects that feed a descriptor, whether the pipe does, and whether some source is unknowable. */
interface Feeds {
  redirects: Set<RedirectToken>;
  pipe: boolean;
  unknown: boolean;
}

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

/**
 * The one answer to what a shell runs from stdin or another descriptor, for every consumer. A script operand only
 * known at run time may name stdin, so its stdin runs too. zsh's MULTIOS joins every source opened on a descriptor,
 * the pipe included, so all of them are read; under bash or dash, where the last one wins, that only over-reads.
 */
export function shellStdin({ hasC, positional, readsStdin }: ShellOperands, redirects: RedirectToken[], piped: boolean): ShellStdin {
  const file = hasC ? null : positional;
  const fd = file === null ? null : pathFd(file.value);
  const runs = readsStdin || fd !== null || (file !== null && (file.dynamic || file.computed));
  const feeds = feedsOf(redirects, piped)(fd ?? 0, redirects.length);
  return { runs, scriptFile: fd === null ? file : null, sources: sourcesOf(feeds), unknowable: runs && feeds.unknown };
}

function sourcesOf({ redirects, pipe }: Feeds): StdinSource[] {
  const sources = [...redirects].flatMap((r): StdinSource[] => {
    if (r.body !== null) return [{ kind: "text", text: r.body }];
    if (r.target === null) return [];
    return [r.op === "<<<" ? { kind: "text", text: r.target.value } : { kind: "file", target: r.target }];
  });
  return pipe ? [...sources, { kind: "pipe" }] : sources;
}

/**
 * What feeds descriptor `fd` from the first `end` redirects, read left to right as the shells open them: stdin starts
 * on the pipe, any other descriptor is inherited unless a redirect opens it. A dup or a target naming a descriptor
 * (`<&3`, `< /dev/fd/3`, `< /dev/stdin`) feeds what that descriptor held just before it, so `< /dev/stdin` keeps the pipe.
 */
function feedsOf(redirects: RedirectToken[], piped: boolean): (fd: number, end: number) => Feeds {
  const memo = new Map<string, Feeds>();
  const feeds = (fd: number, end: number): Feeds => {
    const key = `${fd}:${end}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const out: Feeds = { redirects: new Set(), pipe: fd === 0 && piped, unknown: false };
    let opened = false;
    redirects.slice(0, end).forEach((r, i) => {
      if (Number(r.fd ?? (r.op.startsWith(">") ? "1" : "0")) !== fd || !STDIN_OPS.has(r.op)) return;
      opened = true;
      join(out, redirectFeeds(r, (named) => feeds(named, i)));
    });
    out.unknown ||= fd !== 0 && !opened;
    memo.set(key, out);
    return out;
  };
  return feeds;
}

/** What one redirect feeds: its text or file, or, through `before`, what the descriptor it dups or names held. */
function redirectFeeds(r: RedirectToken, before: (fd: number) => Feeds): Feeds {
  const target = r.target;
  if (r.body !== null || r.op === "<<<") return fed(r.body !== null || target !== null ? r : null, false);
  if (target === null || target.dynamic) return fed(null, true);
  if (r.op === "<&" || r.op === ">&") return dupFeeds(target.value, before);
  const named = pathFd(target.value);
  return named === null ? fed(r, false) : before(named);
}

/** A dup `N`, or bash's move `N-`, feeds what fd N held; `-` closes the descriptor. */
function dupFeeds(value: string, before: (fd: number) => Feeds): Feeds {
  if (value === "-") return fed(null, false);
  const from = /^(\d+)-?$/.exec(value)?.[1];
  return from === undefined ? fed(null, true) : before(Number(from));
}

function fed(r: RedirectToken | null, unknown: boolean): Feeds {
  return { redirects: new Set(r ? [r] : []), pipe: false, unknown };
}

function join(into: Feeds, from: Feeds): void {
  for (const r of from.redirects) into.redirects.add(r);
  into.pipe ||= from.pipe;
  into.unknown ||= from.unknown;
}

/**
 * The descriptor a script path names however it is spelled (`//dev/stdin`, `/dev/./fd/3`, `/dev/../dev/stdin`), or
 * null. The path is matched on its tail: enough `..` reach `/` from any directory, so a relative path may name one too.
 */
function pathFd(path: string): number | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  const match = FD_PATH_RE.exec(`/${parts.join("/")}`);
  if (!match) return null;
  return match[1] !== undefined ? (NAMED_FDS[match[1]] ?? null) : Number(match[2]);
}
