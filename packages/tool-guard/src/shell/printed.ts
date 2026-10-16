import { decodeAnsiC, decodeEscapes } from "./ansi-c.js";
import type { WordToken } from "./lexer.js";

type FormatMode = "printf-format" | "zsh-printf-format";

/**
 * The shell whose builtins print: zsh's echo takes a lone `-` as the end of its options and drops it, and bash's printf
 * counts width and precision in bytes where zsh's counts characters. Without one, echo keeps `-` and printf counts
 * characters. bash's echo decodes escapes only when `-e` is the last of `-e`/`-E`, and zsh's whenever `-e` is given. A
 * printf format's `\c` prints as written in bash and ends all output in zsh.
 */
export type Shell = "bash" | "zsh";

/** Text `echo` or `printf` writes to stdout, or null when an argument is dynamic or the format is not understood. */
export function printedText(name: string | null, args: WordToken[], shell?: Shell): string | null {
  if (args.some((a) => a.dynamic)) return null;
  const values = args.map((a) => a.value);
  if (name === "echo") return echoText(values, shell);
  if (name === "printf") return printfText(values, shell);
  return null;
}

/**
 * Every distinct text `echo` or `printf` writes when the line may run under any of `shells`: the shell-less text first,
 * then each shell's text that differs. Empty when an argument is dynamic or the format is not understood.
 */
export function printedReadings(name: string | null, args: WordToken[], shells: readonly Shell[]): string[] {
  const first = printedText(name, args);
  if (first === null) return [];
  const texts = [first];
  for (const shell of shells) {
    const text = printedText(name, args, shell);
    if (text !== null && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

/** Without a shell, escapes are decoded unless `-E` comes last, as sh's echo with xpg_echo and dash's decode them. */
function echoText(values: string[], shell: Shell | undefined): string {
  let i = 0;
  let escapes = shell !== "bash";
  let sawE = false;
  for (; i < values.length && /^-[neE]+$/.test(values[i] as string); i++) {
    const flags = values[i] as string;
    if (/[eE]/.test(flags)) escapes = flags.lastIndexOf("e") > flags.lastIndexOf("E");
    sawE ||= flags.includes("e");
  }
  if (shell === "zsh") escapes ||= sawE;
  if (shell === "zsh" && values[i] === "-") i++;
  const text = values.slice(i).join(" ");
  return escapes ? decodeAnsiC(text, "echo") : text;
}

/** Handles `%s`, `%b`, `%c`, `%d`, `%i` and `%%` with width and precision, reusing the format as printf does. */
function printfText(values: string[], shell: Shell | undefined): string | null {
  const ended = values[0] === "--";
  const [format, ...args] = ended ? values.slice(1) : values;
  if (format === undefined || (!ended && format.startsWith("-"))) return null;
  const pieces = formatPieces(format);
  const mode = shell === "zsh" ? "zsh-printf-format" : "printf-format";
  let out = "";
  let rest = args;
  do {
    const pass = applyFormat(pieces, rest, shell === "bash", mode);
    if (pass === null) return null;
    out += pass.text;
    if (pass.stopped || pass.used === 0) break;
    rest = rest.slice(pass.used);
  } while (rest.length > 0);
  return out;
}

const DIRECTIVE = /\\[^%]|%([-+ #0]*)(\*|\d*)(?:\.(\*|\d*))?(.?)/g;

/** A raw literal run of the format, or one directive in it. */
type Piece = string | RegExpMatchArray;

/**
 * Directives are found before escapes are decoded, so an escaped `%` (`\045`, `\x25`) prints as `%` and starts none.
 * A `\` pair is skipped whole; a `\` before `%` is a lone backslash and the `%` still starts a directive, as in bash and zsh.
 */
function formatPieces(format: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const m of format.matchAll(DIRECTIVE)) {
    if (m[0].startsWith("\\")) continue;
    pieces.push(format.slice(at, m.index), m);
    at = (m.index ?? 0) + m[0].length;
  }
  pieces.push(format.slice(at));
  return pieces;
}

/** A `*` count printf would read as `-1` or `0x8` is not guessed: only plain decimals are understood. */
function applyFormat(pieces: Piece[], args: string[], bytes: boolean, mode: FormatMode): { text: string; used: number; stopped: boolean } | null {
  const r = argReader(args);
  let text = "";
  for (const piece of pieces) {
    if (typeof piece === "string") {
      const literal = decodeEscapes(piece, mode);
      text += literal.text;
      if (literal.stopped) return r.understood ? { text, used: r.used, stopped: true } : null;
      continue;
    }
    const [whole, flags = "", width = "", precision, conv = ""] = piece;
    if (whole === "%%") {
      text += "%";
      continue;
    }
    if (!"sbcdi".includes(conv) || conv === "") r.understood = false;
    const w = width === "*" ? r.count() : width;
    const p = precision === "*" ? r.count() : precision;
    const arg = r.next();
    if (conv === "b" && decodeEscapes(arg, "printf-b").stopped) {
      return r.understood ? { text: text + convert(conv, arg, p, bytes), used: r.used, stopped: true } : null;
    }
    text += pad(convert(conv, arg, p, bytes), w, flags.includes("-"), bytes);
  }
  return r.understood ? { text, used: r.used, stopped: false } : null;
}

/** Reads printf's arguments in order; a `*` count that is not a plain decimal leaves the pass not understood. */
function argReader(args: string[]) {
  const r = {
    used: 0,
    understood: true,
    next: () => args[r.used++] ?? "",
    count: () => {
      const v = r.next();
      if (!/^\d+$/.test(v)) r.understood = false;
      return v;
    },
  };
  return r;
}

/** `%.3s` truncates to three characters, the one directive that can turn `git push` into `git`. */
function convert(conv: string, arg: string, precision: string | undefined, bytes: boolean): string {
  const value = conv === "b" ? decodeAnsiC(arg, "printf-b") : conv === "c" ? leading(arg, 1, bytes) : arg;
  if (precision === undefined || !"sb".includes(conv)) return value;
  return leading(value, Number.parseInt(precision, 10) || 0, bytes);
}

/** A cut through a multibyte character leaves a broken byte, which decodes to U+FFFD and so never matches zsh's text. */
function leading(value: string, n: number, bytes: boolean): string {
  return bytes ? Buffer.from(value).subarray(0, n).toString() : value.slice(0, n);
}

function pad(value: string, width: string, left: boolean, bytes: boolean): string {
  const n = Number.parseInt(width, 10) || 0;
  const fill = " ".repeat(Math.max(0, n - (bytes ? Buffer.byteLength(value) : value.length)));
  return left ? value + fill : fill + value;
}
